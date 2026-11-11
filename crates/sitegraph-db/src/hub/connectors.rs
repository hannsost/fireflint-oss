//! Durable inbound connector configuration and immutable import plans.
use super::*;
use ring::aead::{self, Aad, LessSafeKey, Nonce, UnboundKey};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectorMapping {
    pub kind: String,
    pub external_id: String,
    pub name: String,
    pub fields: BTreeMap<String, String>,
    #[serde(default = "comma")]
    pub delimiter: String,
}
fn comma() -> String {
    ",".into()
}

// Deliberately no Debug: never include secrets in tracing or API errors.
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectorCredentials {
    pub token: Option<String>,
    pub consumer_key: Option<String>,
    pub consumer_secret: Option<String>,
    pub api_key: Option<String>,
    pub api_secret: Option<String>,
    pub username: Option<String>,
    pub app_password: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectorInput {
    pub name: String,
    pub provider: String,
    pub object_type: String,
    pub source_id: Uuid,
    pub base_url: Option<String>,
    pub database: Option<String>,
    pub folder_path: Option<String>,
    #[serde(default)]
    pub share_metadata: bool,
    pub mapping: Option<ConnectorMapping>,
    pub enabled: bool,
    pub credentials: Option<ConnectorCredentials>,
    pub expected_revision: Option<i64>,
}

#[derive(Deserialize)]
pub struct ConnectorConfig {
    pub id: Uuid,
    pub org_id: Uuid,
    pub source_id: Uuid,
    pub provider: String,
    pub object_type: String,
    pub base_url: Option<String>,
    pub database: Option<String>,
    pub folder_path: Option<String>,
    #[serde(default)]
    pub share_metadata: bool,
    pub mapping: Option<ConnectorMapping>,
    pub revision: i64,
    pub enabled: bool,
}

pub struct ConnectorFetch {
    pub config: ConnectorConfig,
    pub credentials: Option<ConnectorCredentials>,
    pub lease_id: Uuid,
    pub retry_after_seconds: i64,
}

const PROJECTION: &str = "to_jsonb(c) - 'credentials_ciphertext' - 'lease_id' - 'lease_until' || jsonb_build_object('has_credentials',c.credentials_ciphertext IS NOT NULL)";

async fn connector(tx: &mut Tx<'_>, org: Uuid, id: Uuid) -> HubResult<Value> {
    sqlx::query_scalar(&format!(
        "SELECT {PROJECTION} FROM hub_connectors c WHERE org_id=$1 AND id=$2"
    ))
    .bind(org)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(HubError::NotFound)
}

fn aad(org: Uuid, id: Uuid, provider: &str) -> String {
    format!("fireflint:hub-connector:v2:{org}:{id}:{provider}")
}
fn seal(key: &[u8; 32], context: &str, value: &ConnectorCredentials) -> HubResult<String> {
    let cipher = LessSafeKey::new(UnboundKey::new(&aead::AES_256_GCM, key).expect("AES key"));
    let nonce: [u8; 12] = rand::random();
    let mut data = serde_json::to_vec(value).map_err(anyhow::Error::from)?;
    cipher
        .seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(context.as_bytes()),
            &mut data,
        )
        .map_err(|_| anyhow::anyhow!("connector credential encryption failed"))?;
    Ok(format!("v2:{}{}", hex::encode(nonce), hex::encode(data)))
}
fn unseal(key: &[u8; 32], context: &str, value: &str) -> HubResult<ConnectorCredentials> {
    let invalid = || anyhow::anyhow!("connector credential decryption failed");
    let data =
        hex::decode(value.strip_prefix("v2:").ok_or_else(invalid)?).map_err(|_| invalid())?;
    let (nonce, ciphertext) = data.split_at_checked(12).ok_or_else(invalid)?;
    let cipher = LessSafeKey::new(UnboundKey::new(&aead::AES_256_GCM, key).expect("AES key"));
    let mut data = ciphertext.to_vec();
    let plaintext = cipher
        .open_in_place(
            Nonce::try_assume_unique_for_key(nonce).map_err(|_| invalid())?,
            Aad::from(context.as_bytes()),
            &mut data,
        )
        .map_err(|_| invalid())?;
    serde_json::from_slice(plaintext).map_err(|_| invalid().into())
}

impl Db {
    pub async fn hub_connectors(&self, org: Uuid) -> HubResult<Value> {
        self.hub_enabled(org, "integrations").await?;
        let rows: Vec<Value> = sqlx::query_scalar(&format!("SELECT {PROJECTION} FROM hub_connectors c WHERE org_id=$1 ORDER BY created_at DESC,id LIMIT 100"))
            .bind(org).fetch_all(&self.org_pool(org)?).await?;
        Ok(json!(rows))
    }

    pub async fn hub_save_connector(
        &self,
        org: Uuid,
        actor: Uuid,
        id: Option<Uuid>,
        body: ConnectorInput,
    ) -> HubResult<Value> {
        bounded(&body.name, 240, "Bezeichnung")?;
        let mut tx = self.hub_begin(org, actor, "integrations", true).await?;
        if records::active_record(&mut tx, org, body.source_id).await?["kind"] != "source" {
            return Err(HubError::Invalid(
                "Eine aktive Datenquelle ist erforderlich.".into(),
            ));
        }
        let connector_id = id.unwrap_or_else(Uuid::new_v4);
        let encrypted = body
            .credentials
            .as_ref()
            .map(|v| {
                seal(
                    &self.connector_encryption_key,
                    &aad(org, connector_id, &body.provider),
                    v,
                )
            })
            .transpose()?;
        let mapping = body
            .mapping
            .as_ref()
            .map(serde_json::to_value)
            .transpose()
            .map_err(anyhow::Error::from)?;
        if id.is_some() {
            let current = connector(&mut tx, org, connector_id).await?;
            check_revision(
                body.expected_revision,
                current["revision"].as_i64().unwrap(),
            )?;
            let same = current["provider"] == body.provider
                && current["object_type"] == body.object_type
                && current["source_id"] == json!(body.source_id)
                && current["base_url"] == json!(body.base_url)
                && current["database"] == json!(body.database)
                && current["folder_path"] == json!(body.folder_path)
                && current["share_metadata"] == json!(body.share_metadata);
            if !same {
                return Err(HubError::Invalid("Anbieter, Objekttyp, Quelle, Ordner, Metadatenfreigabe und Systemadresse sind unveränderlich. Neue Verbindung anlegen.".into()));
            }
            sqlx::query("UPDATE hub_connectors SET name=$3,mapping=$4,enabled=$5,credentials_ciphertext=COALESCE($6,credentials_ciphertext),revision=revision+1,updated_by=$7,updated_at=now(),lease_id=NULL,lease_until=NULL WHERE org_id=$1 AND id=$2")
                .bind(org).bind(connector_id).bind(body.name.trim()).bind(mapping).bind(body.enabled).bind(encrypted).bind(actor).execute(&mut *tx).await?;
        } else {
            check_revision(body.expected_revision, 0)?;
            let count: i64 =
                sqlx::query_scalar("SELECT count(*) FROM hub_connectors WHERE org_id=$1")
                    .bind(org)
                    .fetch_one(&mut *tx)
                    .await?;
            if count >= 100 {
                return Err(HubError::Invalid(
                    "Höchstens 100 Verbindungen pro Arbeitsbereich.".into(),
                ));
            }
            if !matches!(body.provider.as_str(), "csv" | "json") && encrypted.is_none() {
                return Err(HubError::Invalid("Zugangsdaten sind erforderlich.".into()));
            }
            sqlx::query("INSERT INTO hub_connectors(id,org_id,source_id,name,provider,object_type,base_url,database,mapping,enabled,credentials_ciphertext,created_by,updated_by,folder_path,share_metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,$14)")
                .bind(connector_id).bind(org).bind(body.source_id).bind(body.name.trim()).bind(&body.provider).bind(&body.object_type).bind(&body.base_url).bind(&body.database).bind(mapping).bind(body.enabled).bind(encrypted).bind(actor).bind(&body.folder_path).bind(body.share_metadata).execute(&mut *tx).await?;
        }
        let value = connector(&mut tx, org, connector_id).await?;
        event(
            &mut tx,
            org,
            actor,
            "de.fireflint.connector.configured",
            &connector_id.to_string(),
            &json!({"provider":body.provider,"revision":value["revision"],"enabled":body.enabled}),
        )
        .await?;
        tx.commit().await?;
        Ok(value)
    }

    /// Lease is durable, bounded, and invalidated by configuration changes.
    pub async fn hub_connector_start(
        &self,
        org: Uuid,
        actor: Uuid,
        id: Uuid,
        expected: Option<i64>,
    ) -> HubResult<ConnectorFetch> {
        let mut tx = self.hub_begin(org, actor, "integrations", false).await?;
        let value = connector(&mut tx, org, id).await?;
        let config: ConnectorConfig = serde_json::from_value(value).map_err(anyhow::Error::from)?;
        check_revision(expected, config.revision)?;
        if !config.enabled {
            return Err(HubError::Invalid(
                "Diese Verbindung ist deaktiviert.".into(),
            ));
        }
        records::active_record(&mut tx, org, config.source_id).await?;
        let (encrypted, retry): (Option<String>, i64) = sqlx::query_as("SELECT credentials_ciphertext,GREATEST(0,CEIL(EXTRACT(EPOCH FROM (GREATEST(retry_at,lease_until)-now()))))::bigint FROM hub_connectors WHERE org_id=$1 AND id=$2")
            .bind(org).bind(id).fetch_one(&mut *tx).await?;
        let lease_id = Uuid::new_v4();
        let credentials = if retry == 0 {
            sqlx::query("UPDATE hub_connectors SET lease_id=$3,lease_until=now()+interval '75 seconds' WHERE org_id=$1 AND id=$2")
                .bind(org).bind(id).bind(lease_id).execute(&mut *tx).await?;
            encrypted
                .map(|v| {
                    unseal(
                        &self.connector_encryption_key,
                        &aad(org, id, &config.provider),
                        &v,
                    )
                })
                .transpose()?
        } else {
            None
        };
        tx.commit().await?;
        Ok(ConnectorFetch {
            config,
            credentials,
            lease_id,
            retry_after_seconds: retry,
        })
    }

    pub async fn hub_connector_failed(
        &self,
        org: Uuid,
        id: Uuid,
        lease: Uuid,
        error: Value,
        retry_seconds: i64,
    ) -> HubResult<()> {
        sqlx::query("UPDATE hub_connectors SET lease_id=NULL,lease_until=NULL,last_error=$4,retry_at=CASE WHEN $5::bigint>0 THEN now()+$5::bigint*interval '1 second' ELSE NULL END WHERE org_id=$1 AND id=$2 AND lease_id=$3")
            .bind(org).bind(id).bind(lease).bind(error).bind(retry_seconds).execute(&self.org_pool(org)?).await?;
        Ok(())
    }

    pub async fn hub_connector_capture(
        &self,
        org: Uuid,
        actor: Uuid,
        fetch: &ConnectorFetch,
        mut rows: Vec<ImportRow>,
        next_cursor: Option<String>,
    ) -> HubResult<Value> {
        let mut tx = self.hub_begin(org, actor, "integrations", false).await?;
        let c = connector(&mut tx, org, fetch.config.id).await?;
        check_revision(Some(fetch.config.revision), c["revision"].as_i64().unwrap())?;
        let valid: bool = sqlx::query_scalar("SELECT COALESCE(lease_id=$3 AND lease_until>now(),false) FROM hub_connectors WHERE org_id=$1 AND id=$2")
            .bind(org).bind(fetch.config.id).bind(fetch.lease_id).fetch_one(&mut *tx).await?;
        if !valid {
            return Err(HubError::Invalid(
                "Der Abruf ist abgelaufen. Neue Vorschau anfordern.".into(),
            ));
        }
        if rows.len() > 100 {
            return Err(HubError::Invalid(
                "Höchstens 100 Datensätze je Vorschau.".into(),
            ));
        }
        // Capture once under the same org lock as all record writes. Merge unowned
        // fields from the current record so a partial adapter mapping preserves them.
        for row in &mut rows {
            let current: Option<(i64,Value)> = sqlx::query_as("SELECT revision,data FROM hub_records WHERE org_id=$1 AND source_id=$2 AND external_id=$3")
                .bind(org).bind(fetch.config.source_id).bind(&row.external_id).fetch_optional(&mut *tx).await?;
            row.expected_revision = Some(current.as_ref().map_or(0, |v| v.0));
            if let Some((_, mut data)) = current {
                if let (Some(existing), Some(incoming)) =
                    (data.as_object_mut(), row.data.as_object())
                {
                    existing.extend(incoming.clone());
                }
                row.data = data;
            }
        }
        let id = Uuid::new_v4();
        let input = ImportInput {
            source_id: fetch.config.source_id,
            request_key: id,
            rows,
        };
        let checked = if input.rows.is_empty() {
            json!({"rows":[]})
        } else {
            records::import_in_tx(&mut tx, org, actor, &input, false).await?
        };
        let mut report_rows = Vec::new();
        for (row, check) in input.rows.iter().zip(checked["rows"].as_array().unwrap()) {
            let mut value = serde_json::to_value(row).map_err(anyhow::Error::from)?;
            value
                .as_object_mut()
                .unwrap()
                .extend(check.as_object().unwrap().clone());
            report_rows.push(value);
        }
        let report = json!({"id":id,"connector_id":fetch.config.id,"connector_revision":fetch.config.revision,"status":"preview","applied":false,"next_cursor":next_cursor,"rows":report_rows});
        // Bounded retained plans; applied import receipts remain in hub_imports.
        sqlx::query("DELETE FROM hub_connector_previews WHERE org_id=$1 AND connector_id=$2 AND expires_at<now()")
            .bind(org).bind(fetch.config.id).execute(&mut *tx).await?;
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM hub_connector_previews WHERE org_id=$1 AND connector_id=$2",
        )
        .bind(org)
        .bind(fetch.config.id)
        .fetch_one(&mut *tx)
        .await?;
        if count >= 100 {
            return Err(HubError::Invalid(
                "Höchstens 100 Vorschauen pro Verbindung in 24 Stunden.".into(),
            ));
        }
        let expires: chrono::DateTime<chrono::Utc> = sqlx::query_scalar("INSERT INTO hub_connector_previews(id,org_id,connector_id,connector_revision,import_input,report,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING expires_at")
            .bind(id).bind(org).bind(fetch.config.id).bind(fetch.config.revision).bind(serde_json::to_value(input).map_err(anyhow::Error::from)?).bind(&report).bind(actor).fetch_one(&mut *tx).await?;
        sqlx::query("UPDATE hub_connectors SET lease_id=NULL,lease_until=NULL,retry_at=NULL,last_error=NULL WHERE org_id=$1 AND id=$2")
            .bind(org).bind(fetch.config.id).execute(&mut *tx).await?;
        tx.commit().await?;
        let mut report = report;
        report["expires_at"] = json!(expires);
        Ok(report)
    }

    pub async fn hub_connector_preview(
        &self,
        org: Uuid,
        id: Uuid,
        preview: Uuid,
    ) -> HubResult<Value> {
        self.hub_enabled(org, "integrations").await?;
        sqlx::query_scalar("SELECT report || jsonb_build_object('expires_at',expires_at,'applied',applied_at IS NOT NULL,'status',CASE WHEN applied_at IS NULL THEN 'preview' ELSE 'applied' END,'result',result) FROM hub_connector_previews WHERE org_id=$1 AND connector_id=$2 AND id=$3")
            .bind(org).bind(id).bind(preview).fetch_optional(&self.org_pool(org)?).await?.ok_or(HubError::NotFound)
    }

    pub async fn hub_connector_apply(
        &self,
        org: Uuid,
        actor: Uuid,
        id: Uuid,
        preview: Uuid,
        expected: Option<i64>,
    ) -> HubResult<Value> {
        let mut tx = self.hub_begin(org, actor, "integrations", false).await?;
        let (revision, input, result, expired): (i64,Value,Option<Value>,bool) = sqlx::query_as("SELECT connector_revision,import_input,result,expires_at<=now() FROM hub_connector_previews WHERE org_id=$1 AND connector_id=$2 AND id=$3")
            .bind(org).bind(id).bind(preview).fetch_optional(&mut *tx).await?.ok_or(HubError::NotFound)?;
        check_revision(expected, revision)?;
        // An accepted request is an immutable receipt, even if configuration later changes.
        if let Some(result) = result {
            return Ok(result);
        }
        let current = connector(&mut tx, org, id).await?;
        check_revision(expected, current["revision"].as_i64().unwrap())?;
        if expired {
            return Err(HubError::Invalid(
                "Diese Vorschau ist abgelaufen. Neue Vorschau anfordern.".into(),
            ));
        }
        if current["enabled"] != true {
            return Err(HubError::Invalid(
                "Diese Verbindung ist deaktiviert.".into(),
            ));
        }
        let input: ImportInput = serde_json::from_value(input).map_err(anyhow::Error::from)?;
        let result = records::import_in_tx(&mut tx, org, actor, &input, true).await?;
        sqlx::query("UPDATE hub_connector_previews SET result=$4,applied_at=now() WHERE org_id=$1 AND connector_id=$2 AND id=$3")
            .bind(org).bind(id).bind(preview).bind(&result).execute(&mut *tx).await?;
        event(
            &mut tx,
            org,
            actor,
            "de.fireflint.connector.imported",
            &id.to_string(),
            &json!({"preview_id":preview,"count":input.rows.len()}),
        )
        .await?;
        tx.commit().await?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credentials_are_bound_to_tenant_connector_and_provider() {
        let org = Uuid::new_v4();
        let id = Uuid::new_v4();
        let context = aad(org, id, "hubspot");
        let key = [7; 32];
        let secret = ConnectorCredentials {
            token: Some("fixture-not-a-real-token".into()),
            consumer_key: None,
            consumer_secret: None,
            ..Default::default()
        };
        let encrypted = seal(&key, &context, &secret).unwrap();
        assert!(!encrypted.contains("fixture"));
        assert_eq!(
            unseal(&key, &context, &encrypted).unwrap().token,
            secret.token
        );
        for other in [
            aad(Uuid::new_v4(), id, "hubspot"),
            aad(org, Uuid::new_v4(), "hubspot"),
            aad(org, id, "shopify"),
        ] {
            assert!(unseal(&key, &other, &encrypted).is_err());
        }
        assert!(unseal(&[8; 32], &context, &encrypted).is_err());
        assert!(unseal(&key, &context, "v2:bad").is_err());
        assert_ne!(seal(&key, &context, &secret).unwrap(), encrypted);
    }
}
