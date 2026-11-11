//! Tenant-scoped durable hub repositories. Mutations serialize per organization,
//! including module changes, so disabling a module cannot race an accepted write.
mod connectors;
mod devices;
mod flintplate;
mod forms;
mod kinds;
mod quality;
mod records;
mod resources;
mod service_access;
mod work;

use crate::Db;
use serde_json::{json, Value};
use sitegraph_company_hub::{module, MODULES};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

pub use connectors::*;
pub use devices::*;
pub use flintplate::*;
pub use forms::*;
pub use kinds::*;
pub use quality::*;
pub use records::*;
pub use resources::*;
pub use service_access::*;
pub use work::*;

#[derive(Debug, thiserror::Error)]
pub enum HubError {
    #[error("Datensatz nicht gefunden.")]
    NotFound,
    #[error("Keine Berechtigung für diese Aktion.")]
    Forbidden,
    #[error("Dieses Modul ist nicht aktiviert.")]
    Disabled,
    #[error("Der Datensatz wurde inzwischen geändert.")]
    Conflict(i64),
    #[error("Die gelesene Revision ist erforderlich.")]
    RevisionRequired,
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}
pub type HubResult<T> = Result<T, HubError>;
type Tx<'a> = Transaction<'a, Postgres>;

fn check_revision(expected: Option<i64>, current: i64) -> HubResult<()> {
    match expected {
        None => Err(HubError::RevisionRequired),
        Some(v) if v < 0 => Err(HubError::Invalid("Ungültige Revision.".into())),
        Some(v) if v != current => Err(HubError::Conflict(current)),
        _ => Ok(()),
    }
}

fn bounded(value: &str, max: usize, label: &str) -> HubResult<()> {
    if value.trim().is_empty() || value.len() > max {
        return Err(HubError::Invalid(format!(
            "{label} ist erforderlich und darf höchstens {max} Zeichen enthalten."
        )));
    }
    Ok(())
}

async fn enabled(tx: &mut Tx<'_>, org: Uuid, key: &str) -> HubResult<()> {
    let m = module(key).ok_or(HubError::NotFound)?;
    if m.required {
        return Ok(());
    }
    let active: bool = sqlx::query_scalar("SELECT COALESCE((SELECT enabled FROM hub_modules WHERE org_id=$1 AND module_key=$2),false)")
        .bind(org).bind(key).fetch_one(&mut **tx).await?;
    if !active {
        return Err(HubError::Disabled);
    }
    Ok(())
}

async fn event(
    tx: &mut Tx<'_>,
    org: Uuid,
    actor: Uuid,
    typ: &str,
    subject: &str,
    data: &Value,
) -> HubResult<()> {
    sqlx::query(
        "INSERT INTO hub_events(org_id,actor_id,event_type,subject,data) VALUES($1,$2,$3,$4,$5)",
    )
    .bind(org)
    .bind(actor)
    .bind(typ)
    .bind(subject)
    .bind(data)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

impl Db {
    async fn hub_begin(&self, org: Uuid, actor: Uuid, key: &str, owner: bool) -> HubResult<Tx<'_>> {
        let mut tx = self.org_pool(org)?.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 76102))")
            .bind(org.to_string())
            .execute(&mut *tx)
            .await?;
        let role: Option<String> = sqlx::query_scalar(
            "SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2 FOR SHARE",
        )
        .bind(org)
        .bind(actor)
        .fetch_optional(&mut *tx)
        .await?;
        if !matches!(role.as_deref(), Some("owner")) && (owner || role.as_deref() != Some("editor"))
        {
            return Err(HubError::Forbidden);
        }
        enabled(&mut tx, org, key).await?;
        Ok(tx)
    }

    pub async fn hub_enabled(&self, org: Uuid, key: &str) -> HubResult<()> {
        let mut tx = self.org_pool(org)?.begin().await?;
        enabled(&mut tx, org, key).await
    }

    pub async fn hub_modules(&self, org: Uuid) -> HubResult<Value> {
        let states: Vec<(String, bool, i64)> =
            sqlx::query_as("SELECT module_key,enabled,revision FROM hub_modules WHERE org_id=$1")
                .bind(org)
                .fetch_all(&self.org_pool(org)?)
                .await?;
        Ok(Value::Array(
            MODULES
                .iter()
                .map(|m| {
                    let state = states.iter().find(|s| s.0 == m.key);
                    let mut value = serde_json::to_value(m).expect("static module contract");
                    value["enabled"] = json!(m.required || state.is_some_and(|s| s.1));
                    value["revision"] = json!(state.map_or(0, |s| s.2));
                    value
                })
                .collect(),
        ))
    }

    pub async fn hub_set_module(
        &self,
        org: Uuid,
        actor: Uuid,
        key: &str,
        active: bool,
        expected: Option<i64>,
    ) -> HubResult<Value> {
        let m = module(key).ok_or(HubError::NotFound)?;
        if m.required && !active {
            return Err(HubError::Invalid(
                "Die gemeinsame Datenbasis bleibt aktiviert.".into(),
            ));
        }
        let mut tx = self.hub_begin(org, actor, "directory", true).await?;
        let current: Option<i64> = sqlx::query_scalar(
            "SELECT revision FROM hub_modules WHERE org_id=$1 AND module_key=$2",
        )
        .bind(org)
        .bind(key)
        .fetch_optional(&mut *tx)
        .await?;
        check_revision(expected, current.unwrap_or(0))?;
        if active {
            for dep in m.dependencies {
                enabled(&mut tx, org, dep).await.map_err(|_| {
                    HubError::Invalid(format!(
                        "Zuerst das Modul {} aktivieren.",
                        module(dep).unwrap().name
                    ))
                })?;
            }
        } else {
            for dependent in MODULES.iter().filter(|d| d.dependencies.contains(&key)) {
                if enabled(&mut tx, org, dependent.key).await.is_ok() {
                    return Err(HubError::Invalid(format!(
                        "{} benötigt dieses Modul.",
                        dependent.name
                    )));
                }
            }
        }
        sqlx::query("INSERT INTO hub_modules(org_id,module_key,enabled) VALUES($1,$2,$3) ON CONFLICT(org_id,module_key) DO UPDATE SET enabled=$3,revision=hub_modules.revision+1,updated_at=now()")
            .bind(org).bind(key).bind(active).execute(&mut *tx).await?;
        event(
            &mut tx,
            org,
            actor,
            "de.fireflint.module.changed",
            key,
            &json!({"enabled":active,"revision":current.unwrap_or(0)+1}),
        )
        .await?;
        tx.commit().await?;
        self.hub_modules(org).await
    }

    pub async fn hub_events(&self, org: Uuid, offset: i64) -> HubResult<Value> {
        let rows: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('specversion','1.0','id',id,'source','urn:fireflint:org:'||org_id,'type',event_type,'subject',subject,'time',created_at,'datacontenttype','application/json','actor',actor_id,'data',data) FROM hub_events WHERE org_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100 OFFSET $2")
            .bind(org).bind(offset.clamp(0,100_000)).fetch_all(&self.org_pool(org)?).await?;
        Ok(json!(rows))
    }

    pub async fn hub_summary(&self, org: Uuid) -> HubResult<Value> {
        let records: Value = sqlx::query_scalar("SELECT COALESCE(jsonb_object_agg(kind,n),'{}') FROM (SELECT kind,count(*) n FROM hub_records WHERE org_id=$1 AND NOT archived GROUP BY kind) c")
            .bind(org).fetch_one(&self.org_pool(org)?).await?;
        Ok(json!({"records":records,"modules":self.hub_modules(org).await?}))
    }
}
