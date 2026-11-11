use super::*;
use serde::Deserialize;
use sitegraph_company_hub::{key_valid, kinds, validate_fields, Field, Kind};

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct KindInput {
    pub key: String,
    pub name: String,
    pub fields: Vec<Field>,
    pub expected_revision: Option<i64>,
}

pub(super) async fn resolve_kind(tx: &mut Tx<'_>, org: Uuid, key: &str) -> HubResult<Kind> {
    if let Some(kind) = kinds().into_iter().find(|k| k.key == key) {
        return Ok(kind);
    }
    let (name, fields): (String, Value) =
        sqlx::query_as("SELECT name,fields FROM hub_kinds WHERE org_id=$1 AND kind_key=$2")
            .bind(org)
            .bind(key)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or(HubError::NotFound)?;
    Ok(Kind {
        key: key.into(),
        name,
        module: "directory".into(),
        fields: serde_json::from_value(fields).map_err(anyhow::Error::from)?,
    })
}

impl Db {
    pub async fn hub_kinds(&self, org: Uuid) -> HubResult<Value> {
        let mut rows: Vec<Value> = kinds()
            .into_iter()
            .map(|k| {
                let mut v = serde_json::to_value(k).expect("static schema");
                v["builtin"] = json!(true);
                v["revision"] = json!(0);
                v
            })
            .collect();
        let custom:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('key',kind_key,'name',name,'fields',fields,'revision',revision,'module','directory','builtin',false) FROM hub_kinds WHERE org_id=$1 ORDER BY name,kind_key")
            .bind(org).fetch_all(&self.org_pool(org)?).await?;
        rows.extend(custom);
        Ok(json!(rows))
    }
    pub async fn hub_save_kind(&self, org: Uuid, actor: Uuid, body: KindInput) -> HubResult<Value> {
        if !key_valid(&body.key) || kinds().iter().any(|k| k.key == body.key) {
            return Err(HubError::Invalid(
                "Diese Typkennung ist ungültig oder reserviert.".into(),
            ));
        }
        bounded(&body.name, 160, "Typname")?;
        validate_fields(&body.fields).map_err(HubError::Invalid)?;
        let mut tx = self.hub_begin(org, actor, "directory", true).await?;
        let previous: Option<(i64, Value)> =
            sqlx::query_as("SELECT revision,fields FROM hub_kinds WHERE org_id=$1 AND kind_key=$2")
                .bind(org)
                .bind(&body.key)
                .fetch_optional(&mut *tx)
                .await?;
        check_revision(body.expected_revision, previous.as_ref().map_or(0, |r| r.0))?;
        if let Some((_, fields)) = previous {
            let old: Vec<Field> = serde_json::from_value(fields).map_err(anyhow::Error::from)?;
            // Compatible additions preserve every existing record. Destructive schema
            // migrations need a separately reviewed migration, never a blind UI save.
            for old_field in &old {
                let new = body
                    .fields
                    .iter()
                    .find(|f| f.key == old_field.key)
                    .ok_or_else(|| {
                        HubError::Invalid("Bestehende Felder können nicht entfernt werden.".into())
                    })?;
                if new.kind != old_field.kind
                    || (!old_field.required && new.required)
                    || !old_field.options.iter().all(|o| new.options.contains(o))
                {
                    return Err(HubError::Invalid(
                        "Die Änderung wäre mit bestehenden Daten nicht kompatibel.".into(),
                    ));
                }
            }
            if body
                .fields
                .iter()
                .any(|n| n.required && !old.iter().any(|o| o.key == n.key))
            {
                return Err(HubError::Invalid(
                    "Neue Felder müssen zunächst optional sein.".into(),
                ));
            }
        } else {
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM hub_kinds WHERE org_id=$1")
                .bind(org)
                .fetch_one(&mut *tx)
                .await?;
            if count >= 100 {
                return Err(HubError::Invalid(
                    "Ein Arbeitsbereich unterstützt derzeit bis zu 100 eigene Datentypen.".into(),
                ));
            }
        }
        let fields = serde_json::to_value(body.fields).map_err(anyhow::Error::from)?;
        sqlx::query("INSERT INTO hub_kinds(org_id,kind_key,name,fields) VALUES($1,$2,$3,$4) ON CONFLICT(org_id,kind_key) DO UPDATE SET name=$3,fields=$4,revision=hub_kinds.revision+1,updated_at=now()")
            .bind(org).bind(&body.key).bind(&body.name).bind(&fields).execute(&mut *tx).await?;
        event(
            &mut tx,
            org,
            actor,
            "de.fireflint.schema.saved",
            &body.key,
            &json!({"name":body.name,"fields":fields}),
        )
        .await?;
        tx.commit().await?;
        self.hub_kinds(org).await
    }
}
