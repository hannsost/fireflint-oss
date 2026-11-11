//! Owner-confirmed menu sources and atomic, revision-checked draft imports.
use super::*;
use crate::{insert_version, ContentObjectRow};
use chrono::{DateTime, Utc};
use ring::aead::{self, Aad, LessSafeKey, Nonce, UnboundKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sitegraph_domain::{flintplate::decode_snapshot, ContentObject};

const CONTENT_COLUMNS: &str = "id,org_id,content_type_id,status,revision,data,published_data,published_channels,published_revision,published_at,created_at,updated_at";

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct MenuConnection {
    pub id: Uuid,
    pub org_id: Uuid,
    pub name: String,
    pub source_instance: String,
    pub source_tenant: String,
    pub venue_id: Uuid,
    pub content_id: Uuid,
    pub revision: i64,
    pub enabled: bool,
    #[serde(skip_serializing)]
    pub source_base_url: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl MenuConnection {
    fn json(&self) -> Value {
        let mut value = json!(self);
        value["confirmation"] = json!("manual");
        value["connection_status"] = json!("not_connected");
        if let Some(base_url) = &self.source_base_url {
            value["connection_status"] = json!("read_access_configured");
            value["live_source"] = json!({
                "base_url":base_url,"auth_scheme":"X-FlintPlate-Key","scope":"menu:read"
            });
        }
        value
    }
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MenuConnectionCreate {
    pub expected_revision: Option<i64>,
    pub name: String,
    pub source_instance: String,
    pub source_tenant: String,
    pub venue_id: Uuid,
    pub snapshot_json: String,
    pub confirmed: bool,
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MenuConnectionUpdate {
    pub expected_revision: Option<i64>,
    pub name: String,
    pub enabled: bool,
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MenuReview {
    pub expected_revision: Option<i64>,
    pub expected_content_revision: Option<i64>,
    pub snapshot_json: String,
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MenuApply {
    pub expected_revision: Option<i64>,
    pub expected_content_revision: Option<i64>,
    pub snapshot_json: String,
    pub request_id: Uuid,
}

// Deliberately no Debug or Serialize: the submitted credential is write-only.
#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MenuSourceInput {
    pub expected_revision: Option<i64>,
    pub base_url: String,
    pub api_key: String,
    pub confirmed: bool,
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MenuFetchInput {
    pub expected_revision: Option<i64>,
    pub expected_content_revision: Option<i64>,
}

// Internal transport input only; never serialize or derive Debug.
pub struct MenuSourceAccess {
    pub base_url: String,
    pub api_key: String,
}

fn source_context(org: Uuid, id: Uuid, origin: &str) -> String {
    format!("fireflint:flintplate-source:v1:{org}:{id}:{origin}")
}

fn valid_source_key(value: &str) -> bool {
    (1..=4096).contains(&value.len()) && value.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

fn seal_source(key: &[u8; 32], context: &str, value: &str) -> HubResult<String> {
    let cipher = LessSafeKey::new(UnboundKey::new(&aead::AES_256_GCM, key).expect("AES key"));
    let nonce: [u8; 12] = rand::random();
    let mut data = value.as_bytes().to_vec();
    cipher
        .seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(context.as_bytes()),
            &mut data,
        )
        .map_err(|_| anyhow::anyhow!("menu source credential encryption failed"))?;
    Ok(format!("fp1:{}{}", hex::encode(nonce), hex::encode(data)))
}

fn unseal_source(key: &[u8; 32], context: &str, value: &str) -> HubResult<String> {
    let invalid = || anyhow::anyhow!("menu source credential decryption failed");
    let encoded = value.strip_prefix("fp1:").ok_or_else(invalid)?;
    if !(58..=8248).contains(&encoded.len()) {
        return Err(invalid().into());
    }
    let data = hex::decode(encoded).map_err(|_| invalid())?;
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
    let value = std::str::from_utf8(plaintext).map_err(|_| invalid())?;
    if !valid_source_key(value) {
        return Err(invalid().into());
    }
    Ok(value.to_owned())
}

fn label(value: &str, max: usize) -> HubResult<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(HubError::Invalid(format!(
            "Name und Quellkennungen müssen ausgefüllt sein und dürfen keine Steuerzeichen oder mehr als {max} Bytes enthalten."
        )));
    }
    Ok(value.into())
}

async fn connection(tx: &mut Tx<'_>, org: Uuid, id: Uuid) -> HubResult<MenuConnection> {
    // Use the same lock order for reads and writes: connection, then content.
    // A SHARE-to-UPDATE upgrade after locking content can deadlock a concurrent reader.
    sqlx::query_as::<_, MenuConnection>(
        "SELECT * FROM hub_flintplate_connections WHERE org_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(org)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(HubError::NotFound)
}

async fn content(tx: &mut Tx<'_>, c: &MenuConnection) -> HubResult<ContentObject> {
    let row = sqlx::query_as::<_, ContentObjectRow>(&format!(
        "SELECT {CONTENT_COLUMNS} FROM content_objects WHERE org_id=$1 AND id=$2 FOR UPDATE"
    ))
    .bind(c.org_id)
    .bind(c.content_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(HubError::NotFound)?;
    Ok(row.into())
}

fn bundle(c: &MenuConnection, content: &ContentObject) -> Value {
    json!({"connection": c.json(), "content": content})
}

async fn validate_type(tx: &mut Tx<'_>, org: Uuid, id: Uuid, data: &Value) -> HubResult<()> {
    let schema: Option<Value> = sqlx::query_scalar("SELECT schema FROM content_types WHERE org_id=$1 AND id=$2 AND key='gastro_menu' FOR SHARE")
        .bind(org).bind(id).fetch_optional(&mut **tx).await?;
    let schema = schema.ok_or(HubError::NotFound)?;
    if !sitegraph_domain::validate(&schema, data).is_empty() {
        return Err(HubError::Invalid("Der vorhandene Inhaltstyp gastro_menu passt nicht zu diesem Snapshot. Bitte das Schema prüfen; es wird nicht automatisch verändert.".into()));
    }
    Ok(())
}

impl Db {
    pub async fn menu_connections(&self, org: Uuid) -> HubResult<Value> {
        let rows = sqlx::query_as::<_, MenuConnection>(
            "SELECT * FROM hub_flintplate_connections WHERE org_id=$1 ORDER BY name,id LIMIT 100",
        )
        .bind(org)
        .fetch_all(&self.org_pool(org)?)
        .await?;
        Ok(Value::Array(
            rows.iter().map(MenuConnection::json).collect(),
        ))
    }

    pub async fn menu_connection(&self, org: Uuid, id: Uuid) -> HubResult<Value> {
        let mut tx = self.org_pool(org)?.begin().await?;
        let c = connection(&mut tx, org, id).await?;
        let object = content(&mut tx, &c).await?;
        Ok(bundle(&c, &object))
    }

    pub async fn menu_content_managed(&self, org: Uuid, id: Uuid) -> anyhow::Result<bool> {
        Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM hub_flintplate_connections WHERE org_id=$1 AND content_id=$2)")
            .bind(org).bind(id).fetch_one(&self.org_pool(org)?).await?)
    }

    pub async fn menu_create(
        &self,
        org: Uuid,
        actor: Uuid,
        id: Uuid,
        input: MenuConnectionCreate,
    ) -> HubResult<Value> {
        let mut tx = self.hub_begin(org, actor, "integrations", true).await?;
        if let Some(current) = sqlx::query_scalar::<_, i64>(
            "SELECT revision FROM hub_flintplate_connections WHERE org_id=$1 AND id=$2",
        )
        .bind(org)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        {
            return Err(HubError::Conflict(current));
        }
        check_revision(input.expected_revision, 0)?;
        if !input.confirmed || id.is_nil() {
            return Err(HubError::Invalid("Bitte die Quellzuordnung ausdrücklich bestätigen und eine gültige Auftragskennung verwenden.".into()));
        }
        let name = label(&input.name, 240)?;
        let instance = label(&input.source_instance, 160)?;
        let tenant = label(&input.source_tenant, 160)?;
        let data =
            decode_snapshot(&input.snapshot_json, input.venue_id).map_err(HubError::Invalid)?;
        if let Some(current) = sqlx::query_scalar::<_, i64>("SELECT revision FROM hub_flintplate_connections WHERE org_id=$1 AND source_instance=$2 AND source_tenant=$3 AND venue_id=$4")
            .bind(org).bind(&instance).bind(&tenant).bind(input.venue_id).fetch_optional(&mut *tx).await? {
            return Err(HubError::Conflict(current));
        }
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM hub_flintplate_connections WHERE org_id=$1")
                .bind(org)
                .fetch_one(&mut *tx)
                .await?;
        if count >= 100 {
            return Err(HubError::Invalid(
                "Höchstens 100 Menü-Verbindungen pro Organisation.".into(),
            ));
        }
        let mut fields = vec![
            json!({"key":"schema_version","label":"Schema-Version","type":"number","required":true}),
        ];
        for key in [
            "source_system",
            "venue_id",
            "menu_id",
            "menu_revision",
            "currency",
            "timezone",
            "published_at",
        ] {
            fields.push(json!({"key":key,"label":key,"type":"text","required":true}));
        }
        sqlx::query("INSERT INTO content_types(org_id,key,name,schema) VALUES($1,'gastro_menu','FlintPlate-Menü',$2) ON CONFLICT(org_id,key) DO NOTHING")
            .bind(org).bind(json!({"fields":fields})).execute(&mut *tx).await?;
        let type_id: Uuid = sqlx::query_scalar(
            "SELECT id FROM content_types WHERE org_id=$1 AND key='gastro_menu'",
        )
        .bind(org)
        .fetch_one(&mut *tx)
        .await?;
        validate_type(&mut tx, org, type_id, &data).await?;
        let row = sqlx::query_as::<_, ContentObjectRow>(&format!("INSERT INTO content_objects(org_id,content_type_id,status,data) VALUES($1,$2,'draft',$3) RETURNING {CONTENT_COLUMNS}"))
            .bind(org).bind(type_id).bind(&data).fetch_one(&mut *tx).await?;
        insert_version(&mut tx, row.id, &data).await?;
        let object: ContentObject = row.into();
        sqlx::query("INSERT INTO hub_flintplate_connections(org_id,id,name,source_instance,source_tenant,venue_id,content_id,snapshot,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)")
            .bind(org).bind(id).bind(name).bind(instance).bind(tenant).bind(input.venue_id).bind(object.id).bind(&data).bind(actor).execute(&mut *tx).await?;
        let c = connection(&mut tx, org, id).await?;
        event(
            &mut tx,
            org,
            actor,
            "de.fireflint.menu.connected",
            &id.to_string(),
            &json!({"content_id":object.id,"revision":c.revision,"confirmation":"manual"}),
        )
        .await?;
        let result = bundle(&c, &object);
        tx.commit().await?;
        Ok(result)
    }

    pub async fn menu_update(
        &self,
        org: Uuid,
        actor: Uuid,
        id: Uuid,
        input: MenuConnectionUpdate,
    ) -> HubResult<Value> {
        let mut tx = self.hub_begin(org, actor, "integrations", true).await?;
        let c = connection(&mut tx, org, id).await?;
        check_revision(input.expected_revision, c.revision)?;
        let name = label(&input.name, 240)?;
        sqlx::query("UPDATE hub_flintplate_connections SET name=$3,enabled=$4,revision=revision+1,updated_at=now() WHERE org_id=$1 AND id=$2")
            .bind(org).bind(id).bind(name).bind(input.enabled).execute(&mut *tx).await?;
        let c = connection(&mut tx, org, id).await?;
        let object = content(&mut tx, &c).await?;
        event(
            &mut tx,
            org,
            actor,
            "de.fireflint.menu.connection_changed",
            &id.to_string(),
            &json!({"revision":c.revision,"enabled":c.enabled}),
        )
        .await?;
        let result = bundle(&c, &object);
        tx.commit().await?;
        Ok(result)
    }

    /// The API supplies a locally validated, canonical origin; no network I/O
    /// is performed while this transaction holds permission and revision locks.
    pub async fn menu_save_source(
        &self,
        org: Uuid,
        actor: Uuid,
        id: Uuid,
        input: MenuSourceInput,
    ) -> HubResult<Value> {
        let mut tx = self.hub_begin(org, actor, "integrations", true).await?;
        let c = connection(&mut tx, org, id).await?;
        check_revision(input.expected_revision, c.revision)?;
        if !c.enabled {
            return Err(HubError::Invalid(
                "Diese Menü-Verbindung ist deaktiviert.".into(),
            ));
        }
        if !input.confirmed || !valid_source_key(&input.api_key) {
            return Err(HubError::Invalid("Bitte den Lesezugang bestätigen und einen gültigen API-Schlüssel mit 1 bis 4096 sichtbaren ASCII-Zeichen ohne Leerzeichen angeben.".into()));
        }
        if c.source_base_url
            .as_ref()
            .is_some_and(|origin| origin != &input.base_url)
        {
            return Err(HubError::Invalid("Die bestätigte Quelladresse ist unveränderlich. Ein neuer Schlüssel muss zur selben Quelle gehören.".into()));
        }
        let ciphertext = seal_source(
            &self.connector_encryption_key,
            &source_context(org, id, &input.base_url),
            &input.api_key,
        )?;
        sqlx::query("UPDATE hub_flintplate_connections SET source_base_url=$3,source_api_key_ciphertext=$4,revision=revision+1,updated_at=now() WHERE org_id=$1 AND id=$2")
            .bind(org).bind(id).bind(input.base_url).bind(ciphertext).execute(&mut *tx).await?;
        let c = connection(&mut tx, org, id).await?;
        let object = content(&mut tx, &c).await?;
        event(
            &mut tx,
            org,
            actor,
            "de.fireflint.menu.source_configured",
            &id.to_string(),
            &json!({"revision":c.revision,"auth_scheme":"X-FlintPlate-Key","scope":"menu:read"}),
        )
        .await?;
        let result = bundle(&c, &object);
        tx.commit().await?;
        Ok(result)
    }

    pub async fn menu_source_for_fetch(
        &self,
        org: Uuid,
        actor: Uuid,
        id: Uuid,
        input: &MenuFetchInput,
    ) -> HubResult<MenuSourceAccess> {
        let mut tx = self.hub_begin(org, actor, "integrations", false).await?;
        let c = connection(&mut tx, org, id).await?;
        check_revision(input.expected_revision, c.revision)?;
        if !c.enabled {
            return Err(HubError::Invalid(
                "Diese Menü-Verbindung ist deaktiviert.".into(),
            ));
        }
        let object = content(&mut tx, &c).await?;
        check_revision(input.expected_content_revision, object.revision)?;
        let base_url = c.source_base_url.ok_or_else(|| {
            HubError::Invalid(
                "Für diese Menü-Verbindung ist noch kein Lesezugang konfiguriert.".into(),
            )
        })?;
        let ciphertext: Option<String> = sqlx::query_scalar(
            "SELECT source_api_key_ciphertext FROM hub_flintplate_connections WHERE org_id=$1 AND id=$2"
        ).bind(org).bind(id).fetch_one(&mut *tx).await?;
        let ciphertext =
            ciphertext.ok_or_else(|| anyhow::anyhow!("menu source credential missing"))?;
        let api_key = unseal_source(
            &self.connector_encryption_key,
            &source_context(org, id, &base_url),
            &ciphertext,
        )?;
        // Explicitly finish the read transaction before the caller starts DNS/HTTP.
        tx.rollback().await?;
        Ok(MenuSourceAccess { base_url, api_key })
    }

    pub async fn menu_inspect(
        &self,
        org: Uuid,
        actor: Uuid,
        id: Uuid,
        input: MenuReview,
    ) -> HubResult<Value> {
        let mut tx = self.hub_begin(org, actor, "integrations", false).await?;
        let c = connection(&mut tx, org, id).await?;
        check_revision(input.expected_revision, c.revision)?;
        if !c.enabled {
            return Err(HubError::Invalid(
                "Diese Menü-Verbindung ist deaktiviert.".into(),
            ));
        }
        let object = content(&mut tx, &c).await?;
        check_revision(input.expected_content_revision, object.revision)?;
        let data = decode_snapshot(&input.snapshot_json, c.venue_id).map_err(HubError::Invalid)?;
        validate_type(&mut tx, org, object.content_type_id, &data).await?;
        let mut result = bundle(&c, &object);
        result["item_count"] = json!(data["items"].as_array().map_or(0, Vec::len));
        result["snapshot"] = data;
        Ok(result)
    }

    pub async fn menu_apply(
        &self,
        org: Uuid,
        actor: Uuid,
        id: Uuid,
        input: MenuApply,
    ) -> HubResult<Value> {
        let mut tx = self.hub_begin(org, actor, "integrations", false).await?;
        let c = connection(&mut tx, org, id).await?;
        check_revision(input.expected_revision, c.revision)?;
        if !c.enabled || input.request_id.is_nil() {
            return Err(HubError::Invalid(
                "Menü-Verbindung deaktiviert oder ungültige Auftragskennung.".into(),
            ));
        }
        // Preserve the exact submitted snapshot bytes, including whitespace, in
        // the fingerprint; semantic similarity must not rebase an old request.
        let fingerprint = hex::encode(Sha256::digest(
            json!([
                input.expected_revision,
                input.expected_content_revision,
                input.snapshot_json
            ])
            .to_string()
            .as_bytes(),
        ));
        let prior: Option<(String,Value)> = sqlx::query_as("SELECT request_hash,result FROM hub_flintplate_receipts WHERE org_id=$1 AND connection_id=$2 AND request_id=$3")
            .bind(org).bind(id).bind(input.request_id).fetch_optional(&mut *tx).await?;
        if let Some((hash, result)) = prior {
            if hash != fingerprint {
                return Err(HubError::Conflict(c.revision));
            }
            return Ok(result);
        }
        let object = content(&mut tx, &c).await?;
        check_revision(input.expected_content_revision, object.revision)?;
        let data = decode_snapshot(&input.snapshot_json, c.venue_id).map_err(HubError::Invalid)?;
        validate_type(&mut tx, org, object.content_type_id, &data).await?;
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM hub_flintplate_receipts WHERE org_id=$1")
                .bind(org)
                .fetch_one(&mut *tx)
                .await?;
        if count >= 5000 {
            return Err(HubError::Invalid("Die Organisation hat die Grenze von 5000 Menü-Importbelegen erreicht. Bestehende Belege bleiben erhalten.".into()));
        }
        sqlx::query("UPDATE hub_flintplate_connections SET snapshot=$3,updated_at=now() WHERE org_id=$1 AND id=$2")
            .bind(org).bind(id).bind(&data).execute(&mut *tx).await?;
        let row = sqlx::query_as::<_, ContentObjectRow>(&format!("UPDATE content_objects SET data=$3,updated_at=now() WHERE org_id=$1 AND id=$2 RETURNING {CONTENT_COLUMNS}"))
            .bind(org).bind(object.id).bind(&data).fetch_one(&mut *tx).await?;
        insert_version(&mut tx, row.id, &data).await?;
        let object: ContentObject = row.into();
        let c = connection(&mut tx, org, id).await?;
        let mut result = bundle(&c, &object);
        result["applied"] = json!(true);
        result["request_id"] = json!(input.request_id);
        sqlx::query("INSERT INTO hub_flintplate_receipts(org_id,connection_id,request_id,request_hash,result) VALUES($1,$2,$3,$4,$5)")
            .bind(org).bind(id).bind(input.request_id).bind(fingerprint).bind(&result).execute(&mut *tx).await?;
        event(&mut tx, org, actor, "de.fireflint.menu.imported", &id.to_string(), &json!({"content_id":object.id,"revision":object.revision,"request_id":input.request_id})).await?;
        tx.commit().await?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_credentials_are_bound_to_org_connection_and_canonical_origin() {
        let org = Uuid::new_v4();
        let id = Uuid::new_v4();
        let context = source_context(org, id, "https://menu.example.test");
        let key = [17; 32];
        let secret = "synthetic-menu-read-key";
        let ciphertext = seal_source(&key, &context, secret).unwrap();
        assert!(!ciphertext.contains(secret));
        assert_eq!(unseal_source(&key, &context, &ciphertext).unwrap(), secret);
        assert_ne!(seal_source(&key, &context, secret).unwrap(), ciphertext);
        for other in [
            source_context(Uuid::new_v4(), id, "https://menu.example.test"),
            source_context(org, Uuid::new_v4(), "https://menu.example.test"),
            source_context(org, id, "https://other.example.test"),
            source_context(org, id, "https://menu.example.test/"),
        ] {
            assert!(unseal_source(&key, &other, &ciphertext).is_err());
        }
        assert!(unseal_source(&[18; 32], &context, &ciphertext).is_err());
        let mut corrupted = ciphertext.clone().into_bytes();
        corrupted[30] = if corrupted[30] == b'a' { b'b' } else { b'a' };
        assert!(unseal_source(&key, &context, std::str::from_utf8(&corrupted).unwrap()).is_err());
        for invalid in [
            "fp1:bad",
            "v2:bad",
            "",
            "synthetic-secret-in-invalid-ciphertext",
        ] {
            let error = unseal_source(&key, &context, invalid)
                .unwrap_err()
                .to_string();
            assert_eq!(error, "menu source credential decryption failed");
        }
    }

    #[test]
    fn source_key_limits_preserve_exact_visible_ascii() {
        assert!(valid_source_key("!~synthetic-key"));
        assert!(valid_source_key(&"a".repeat(4096)));
        for value in [
            "",
            " key",
            "key ",
            "key\n",
            "key\0",
            "key\t",
            "key\u{7f}",
            "ümlaut",
        ] {
            assert!(!valid_source_key(value));
        }
        assert!(!valid_source_key(&"a".repeat(4097)));
        let context = source_context(Uuid::new_v4(), Uuid::new_v4(), "https://menu.example.test");
        for size in [1, 4096] {
            let secret = "a".repeat(size);
            let cipher = seal_source(&[17; 32], &context, &secret).unwrap();
            assert!((62..=8252).contains(&cipher.len()));
            assert_eq!(unseal_source(&[17; 32], &context, &cipher).unwrap(), secret);
        }
    }

    #[test]
    fn source_projection_preserves_manual_confirmation_without_secret_fields() {
        let mut connection = MenuConnection {
            id: Uuid::new_v4(),
            org_id: Uuid::new_v4(),
            name: "Menu".into(),
            source_instance: "fixture".into(),
            source_tenant: "fixture".into(),
            venue_id: Uuid::new_v4(),
            content_id: Uuid::new_v4(),
            revision: 1,
            enabled: true,
            source_base_url: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        let manual = connection.json();
        assert_eq!(manual["confirmation"], "manual");
        assert_eq!(manual["connection_status"], "not_connected");
        assert!(manual.get("live_source").is_none());
        connection.source_base_url = Some("https://menu.example.test".into());
        let configured = connection.json();
        assert_eq!(configured["confirmation"], "manual");
        assert_eq!(configured["connection_status"], "read_access_configured");
        assert_eq!(
            configured["live_source"],
            json!({
                "base_url":"https://menu.example.test","auth_scheme":"X-FlintPlate-Key","scope":"menu:read"
            })
        );
        for value in [manual, configured] {
            for field in [
                "source_base_url",
                "source_api_key_ciphertext",
                "api_key",
                "credentials",
            ] {
                assert!(value.get(field).is_none());
            }
        }
    }
}
