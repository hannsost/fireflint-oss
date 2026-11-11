//! Read-only credentials and durable, commit-ordered private record replication.
use super::*;
use chrono::{DateTime, Duration, Utc};
use rand::{rngs::OsRng, RngCore};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ServiceAccessInput {
    pub name: String,
    pub scopes: Vec<String>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ServiceAccessRevision {
    pub expected_revision: Option<i64>,
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ServiceAccessRotation {
    pub expected_revision: Option<i64>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ServiceRead {
    Kinds,
    Record(Uuid),
    Export,
    Changes,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    access: Uuid,
    revision: i64,
    org: Uuid,
    mode: String,
    upper: Option<i64>,
    after_sequence: i64,
    after_record: Option<Uuid>,
}

#[derive(sqlx::FromRow)]
struct Credential {
    id: Uuid,
    org_id: Uuid,
    scopes: Vec<String>,
    revision: i64,
}

fn expiry(expires: DateTime<Utc>) -> HubResult<()> {
    let now = Utc::now();
    if expires <= now || expires > now + Duration::days(366) {
        return Err(HubError::Invalid(
            "Das Ablaufdatum muss in der Zukunft und innerhalb von 366 Tagen liegen.".into(),
        ));
    }
    Ok(())
}

fn new_token() -> (String, String) {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let secret = format!("ffhs_{}", hex::encode(bytes));
    let hash = hex::encode(Sha256::digest(secret.as_bytes()));
    (secret, hash)
}

fn invalid_cursor() -> HubError {
    HubError::Invalid("Ungültiger Cursor. Bitte einen neuen Export beginnen.".into())
}

async fn access_view(tx: &mut Tx<'_>, org: Uuid, id: Uuid) -> HubResult<Value> {
    sqlx::query_scalar("SELECT jsonb_build_object('id',id,'name',name,'scopes',scopes,'expires_at',expires_at,'revoked_at',revoked_at,'revision',revision,'created_at',created_at,'rotated_at',rotated_at,'last_used_at',last_used_at) FROM hub_service_access WHERE org_id=$1 AND id=$2")
        .bind(org).bind(id).fetch_optional(&mut **tx).await?.ok_or(HubError::NotFound)
}

// Build an explicit public projection, never a subtraction from a full audit row.
// Lookup IDs only in the token's org and allowed kinds; no foreign names, actor IDs,
// connector configuration, link metadata or excluded source identifiers escape.
async fn project(
    tx: &mut Tx<'_>,
    auth: &Credential,
    snapshots: Vec<Value>,
) -> HubResult<Vec<Value>> {
    let mut referenced = HashSet::new();
    for row in &snapshots {
        if let Some(id) = row["source_id"]
            .as_str()
            .and_then(|v| v.parse::<Uuid>().ok())
        {
            referenced.insert(id);
        }
        if let Some(links) = row["links"].as_array() {
            for link in links {
                if let Some(id) = link["to_id"].as_str().and_then(|v| v.parse::<Uuid>().ok()) {
                    referenced.insert(id);
                }
            }
        }
    }
    let ids: Vec<Uuid> = referenced.into_iter().collect();
    let visible: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM hub_records WHERE org_id=$1 AND id=ANY($2) AND kind=ANY($3)",
    )
    .bind(auth.org_id)
    .bind(ids)
    .bind(&auth.scopes)
    .fetch_all(&mut **tx)
    .await?;
    let visible: HashSet<String> = visible.into_iter().map(|id| id.to_string()).collect();
    Ok(snapshots
        .into_iter()
        .map(|row| {
            let links: Vec<Value> = row["links"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|link| {
                    link["to_id"]
                        .as_str()
                        .is_some_and(|id| visible.contains(id))
                })
                .map(|link| json!({"to_id":link["to_id"],"relation":link["relation"]}))
                .collect();
            let provenance = match row["source_id"].as_str() {
                Some(id) if visible.contains(id) => {
                    json!({"type":"imported","source_id":id,"external_id":row["external_id"]})
                }
                Some(_) => json!({"type":"imported"}),
                None => json!({"type":"local"}),
            };
            json!({"id":row["id"],"kind":row["kind"],"name":row["name"],"data":row["data"],
            "revision":row["revision"],"archived":row["archived"],"created_at":row["created_at"],
            "updated_at":row["updated_at"],"provenance":provenance,"links":links})
        })
        .collect())
}

impl Db {
    fn service_cursor_key(&self) -> LessSafeKey {
        let mut hash = Sha256::new();
        hash.update(b"fireflint/hub-service-cursor/v1\0");
        hash.update(self.connector_encryption_key);
        LessSafeKey::new(
            UnboundKey::new(&AES_256_GCM, &hash.finalize()).expect("32-byte cursor key"),
        )
    }

    fn seal_service_cursor(&self, cursor: &Cursor) -> HubResult<String> {
        let mut nonce = [0_u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let mut bytes = serde_json::to_vec(cursor).map_err(anyhow::Error::from)?;
        self.service_cursor_key()
            .seal_in_place_append_tag(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(b"ffhc1"),
                &mut bytes,
            )
            .map_err(|_| HubError::Internal(anyhow::anyhow!("cursor encryption failed")))?;
        Ok(format!(
            "ffhc1_{}{}",
            hex::encode(nonce),
            hex::encode(bytes)
        ))
    }

    fn open_service_cursor(&self, value: &str) -> HubResult<Cursor> {
        if value.len() > 2048 {
            return Err(invalid_cursor());
        }
        let mut bytes = hex::decode(value.strip_prefix("ffhc1_").ok_or_else(invalid_cursor)?)
            .map_err(|_| invalid_cursor())?;
        if bytes.len() < 29 {
            return Err(invalid_cursor());
        }
        let (nonce, encrypted) = bytes.split_at_mut(12);
        let plaintext = self
            .service_cursor_key()
            .open_in_place(
                Nonce::try_assume_unique_for_key(nonce).map_err(|_| invalid_cursor())?,
                Aad::from(b"ffhc1"),
                encrypted,
            )
            .map_err(|_| invalid_cursor())?;
        serde_json::from_slice(plaintext).map_err(|_| invalid_cursor())
    }

    pub async fn hub_service_access_list(&self, org: Uuid, actor: Uuid) -> HubResult<Value> {
        let mut tx = self.hub_begin(org, actor, "directory", true).await?;
        let rows: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',id,'name',name,'scopes',scopes,'expires_at',expires_at,'revoked_at',revoked_at,'revision',revision,'created_at',created_at,'rotated_at',rotated_at,'last_used_at',last_used_at) FROM hub_service_access WHERE org_id=$1 ORDER BY created_at DESC,id DESC")
            .bind(org).fetch_all(&mut *tx).await?;
        tx.commit().await?;
        Ok(json!(rows))
    }

    pub async fn hub_service_access_create(
        &self,
        org: Uuid,
        actor: Uuid,
        mut body: ServiceAccessInput,
    ) -> HubResult<Value> {
        bounded(&body.name, 160, "Name")?;
        expiry(body.expires_at)?;
        if body.scopes.is_empty() || body.scopes.len() > 106 {
            return Err(HubError::Invalid(
                "Mindestens einen expliziten Datentyp auswählen (maximal 106).".into(),
            ));
        }
        body.scopes.sort();
        body.scopes.dedup();
        let mut tx = self.hub_begin(org, actor, "service_access", true).await?;
        for key in &body.scopes {
            let kind = super::kinds::resolve_kind(&mut tx, org, key).await?;
            enabled(&mut tx, org, &kind.module).await?;
        }
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM hub_service_access WHERE org_id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()")
            .bind(org).fetch_one(&mut *tx).await?;
        if count >= 100 {
            return Err(HubError::Invalid(
                "Maximal 100 aktive Servicezugänge pro Arbeitsbereich.".into(),
            ));
        }
        let id = Uuid::new_v4();
        let (secret, hash) = new_token();
        sqlx::query("INSERT INTO hub_service_access(id,org_id,name,token_hash,scopes,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)")
            .bind(id).bind(org).bind(body.name.trim()).bind(hash).bind(&body.scopes).bind(body.expires_at).bind(actor).execute(&mut *tx).await?;
        event(
            &mut tx,
            org,
            actor,
            "de.fireflint.service.created",
            &id.to_string(),
            &json!({"scopes":body.scopes,"expires_at":body.expires_at}),
        )
        .await?;
        let access = access_view(&mut tx, org, id).await?;
        tx.commit().await?;
        Ok(json!({"access":access,"secret":secret}))
    }

    pub async fn hub_service_access_revoke(
        &self,
        org: Uuid,
        actor: Uuid,
        id: Uuid,
        expected: Option<i64>,
    ) -> HubResult<Value> {
        // Revocation remains available even when service_access is disabled.
        let mut tx = self.hub_begin(org, actor, "directory", true).await?;
        let row = access_view(&mut tx, org, id).await?;
        check_revision(expected, row["revision"].as_i64().unwrap())?;
        if row["revoked_at"].is_null() {
            sqlx::query("UPDATE hub_service_access SET revoked_at=clock_timestamp(),revision=revision+1 WHERE org_id=$1 AND id=$2")
                .bind(org).bind(id).execute(&mut *tx).await?;
            event(
                &mut tx,
                org,
                actor,
                "de.fireflint.service.revoked",
                &id.to_string(),
                &json!({}),
            )
            .await?;
        }
        let row = access_view(&mut tx, org, id).await?;
        tx.commit().await?;
        Ok(row)
    }

    pub async fn hub_service_access_rotate(
        &self,
        org: Uuid,
        actor: Uuid,
        id: Uuid,
        body: ServiceAccessRotation,
    ) -> HubResult<Value> {
        expiry(body.expires_at)?;
        let mut tx = self.hub_begin(org, actor, "service_access", true).await?;
        let row = access_view(&mut tx, org, id).await?;
        check_revision(body.expected_revision, row["revision"].as_i64().unwrap())?;
        if !row["revoked_at"].is_null() {
            return Err(HubError::Invalid(
                "Ein widerrufener Zugang kann nicht erneuert werden.".into(),
            ));
        }
        let (secret, hash) = new_token();
        sqlx::query("UPDATE hub_service_access SET token_hash=$3,expires_at=$4,revision=revision+1,rotated_at=clock_timestamp() WHERE org_id=$1 AND id=$2")
            .bind(org).bind(id).bind(hash).bind(body.expires_at).execute(&mut *tx).await?;
        event(
            &mut tx,
            org,
            actor,
            "de.fireflint.service.rotated",
            &id.to_string(),
            &json!({"expires_at":body.expires_at}),
        )
        .await?;
        let access = access_view(&mut tx, org, id).await?;
        tx.commit().await?;
        Ok(json!({"access":access,"secret":secret}))
    }

    /// `None` is a failed credential check; no tenant or cursor information leaks.
    /// All checks and data reads share the org lock with module/credential writes.
    pub async fn hub_service_read(
        &self,
        hash: &str,
        mode: ServiceRead,
        cursor: Option<&str>,
        limit: i64,
    ) -> HubResult<Option<Value>> {
        let org: Option<Uuid> =
            sqlx::query_scalar("SELECT org_id FROM hub_service_access WHERE token_hash=$1")
                .bind(hash)
                .fetch_optional(&self.pool)
                .await?;
        let Some(org) = org else {
            return Ok(None);
        };
        let mut tx = self.org_pool(org)?.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,76102))")
            .bind(org.to_string())
            .execute(&mut *tx)
            .await?;
        let auth: Option<Credential> = sqlx::query_as("SELECT id,org_id,scopes,revision FROM hub_service_access WHERE org_id=$1 AND token_hash=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()")
            .bind(org).bind(hash).fetch_optional(&mut *tx).await?;
        let Some(auth) = auth else {
            return Ok(None);
        };
        enabled(&mut tx, org, "service_access").await?;
        let mut kinds = Vec::new();
        for key in &auth.scopes {
            let kind = super::kinds::resolve_kind(&mut tx, org, key).await?;
            // Fail the entire request, without advancing its cursor, if any source
            // module is disabled. Re-enable can then resume without skipping rows.
            enabled(&mut tx, org, &kind.module).await?;
            kinds.push(kind);
        }
        if !(1..=100).contains(&limit) {
            return Err(HubError::Invalid(
                "limit muss zwischen 1 und 100 liegen.".into(),
            ));
        }
        let result = match mode {
            ServiceRead::Kinds => {
                if cursor.is_some() {
                    return Err(invalid_cursor());
                }
                json!({"kinds":kinds})
            }
            ServiceRead::Record(id) => {
                if cursor.is_some() {
                    return Err(invalid_cursor());
                }
                let snapshot: Value = sqlx::query_scalar("SELECT snapshot FROM hub_service_changes WHERE org_id=$1 AND record_id=$2 AND kind=ANY($3) ORDER BY sequence DESC LIMIT 1")
                    .bind(org).bind(id).bind(&auth.scopes).fetch_optional(&mut *tx).await?.ok_or(HubError::NotFound)?;
                project(&mut tx, &auth, vec![snapshot]).await?.remove(0)
            }
            ServiceRead::Export | ServiceRead::Changes => {
                let is_export = mode == ServiceRead::Export;
                let name = if is_export { "export" } else { "changes" };
                let high: i64 = sqlx::query_scalar(
                    "SELECT COALESCE((SELECT sequence FROM hub_service_heads WHERE org_id=$1),0)",
                )
                .bind(org)
                .fetch_one(&mut *tx)
                .await?;
                let mut position = match cursor {
                    Some(value) => self.open_service_cursor(value)?,
                    None => Cursor {
                        version: 1,
                        access: auth.id,
                        revision: auth.revision,
                        org,
                        mode: name.into(),
                        upper: Some(high),
                        after_sequence: 0,
                        after_record: None,
                    },
                };
                if position.version != 1
                    || position.access != auth.id
                    || position.revision != auth.revision
                    || position.org != org
                    || position.mode != name
                    || position.after_sequence < 0
                {
                    return Err(invalid_cursor());
                }
                let upper = position.upper.unwrap_or(high);
                if upper > high || upper < position.after_sequence {
                    return Err(invalid_cursor());
                }
                position.upper = Some(upper);
                let mut rows: Vec<(i64, Uuid, Value)> = if is_export {
                    sqlx::query_as("SELECT sequence,record_id,snapshot FROM (SELECT DISTINCT ON(record_id) sequence,record_id,snapshot FROM hub_service_changes WHERE org_id=$1 AND sequence<=$2 AND kind=ANY($3) AND ($4::uuid IS NULL OR record_id>$4) ORDER BY record_id,sequence DESC) latest ORDER BY record_id LIMIT $5")
                        .bind(org).bind(upper).bind(&auth.scopes).bind(position.after_record).bind(limit+1).fetch_all(&mut *tx).await?
                } else {
                    sqlx::query_as("SELECT sequence,record_id,snapshot FROM hub_service_changes WHERE org_id=$1 AND sequence>$2 AND sequence<=$3 AND kind=ANY($4) ORDER BY sequence LIMIT $5")
                        .bind(org).bind(position.after_sequence).bind(upper).bind(&auth.scopes).bind(limit+1).fetch_all(&mut *tx).await?
                };
                let has_more = rows.len() as i64 > limit;
                rows.truncate(limit as usize);
                if let Some((sequence, id, _)) = rows.last() {
                    if is_export {
                        position.after_record = Some(*id);
                    } else {
                        position.after_sequence = *sequence;
                    }
                }
                let items =
                    project(&mut tx, &auth, rows.into_iter().map(|r| r.2).collect()).await?;
                let mut checkpoint = Cursor {
                    version: 1,
                    access: auth.id,
                    revision: auth.revision,
                    org,
                    mode: "changes".into(),
                    upper: None,
                    after_sequence: upper,
                    after_record: None,
                };
                if is_export {
                    json!({"items":items,"has_more":has_more,"next_cursor":if has_more {Some(self.seal_service_cursor(&position)?)} else {None},"changes_cursor":self.seal_service_cursor(&checkpoint)?})
                } else {
                    if has_more {
                        checkpoint = position;
                    }
                    json!({"items":items,"has_more":has_more,"next_cursor":self.seal_service_cursor(&checkpoint)?})
                }
            }
        };
        sqlx::query("UPDATE hub_service_access SET last_used_at=clock_timestamp() WHERE org_id=$1 AND id=$2")
            .bind(org).bind(auth.id).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(Some(result))
    }
}
