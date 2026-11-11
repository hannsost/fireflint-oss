//! Persistence layer: connection pool, migrations, repositories.
//!
//! Mandantentrennung (Whitepaper §19/§20): every query is scoped by `org_id`.
//! No repository function reads or writes without an org context.
//!
//! The walking skeleton uses runtime-checked queries (`query_as`) so the
//! workspace builds without a live database. WP1.4 can move hot paths to
//! compile-time-checked `query!` once an offline cache is set up.

pub mod campaigns;
pub mod hub;
pub mod instagram;
pub mod oidc;
pub mod residency;

use anyhow::Result;
use chrono::{DateTime, Utc};
use residency::{default_storage_target, ConnectionProvider, ResidencyError, SinglePoolProvider};
use ring::aead::{self, Aad, LessSafeKey, Nonce, UnboundKey};
use serde_json::Value;
use sha2::Digest;
use sitegraph_domain::{
    AiConnector, AiRun, AiWorkflow, Asset, AuditEntry, ChannelAssignment, ContentObject,
    ContentPublication, ContentSchedule, ContentType, ContentVersion, Membership, Role, Status,
    User, Webhook, WebhookDelivery, Website,
};
use sitegraph_platform_data_residency::StorageContext;
use sqlx::postgres::PgPoolOptions;
use sqlx::{FromRow, PgPool};
use std::sync::Arc;
use uuid::Uuid;

const CONNECTOR_KEY_PREFIX: &str = "v1:";
const DEV_CONNECTOR_KEY: &str = "development-only-connector-key";

fn connector_encryption_key() -> Result<[u8; 32]> {
    let configured = std::env::var("AI_CONNECTOR_ENCRYPTION_KEY").ok();
    if std::env::var("APP_ENV").as_deref() == Ok("production") && configured.is_none() {
        anyhow::bail!("AI_CONNECTOR_ENCRYPTION_KEY must be set when APP_ENV=production");
    }
    let material = configured.as_deref().unwrap_or(DEV_CONNECTOR_KEY);
    Ok(sha2::Sha256::digest(material.as_bytes()).into())
}

fn encrypt_connector_key(key: &[u8; 32], plaintext: &str) -> Result<String> {
    let cipher =
        LessSafeKey::new(UnboundKey::new(&aead::AES_256_GCM, key).expect("32-byte AES key"));
    let nonce_bytes: [u8; 12] = rand::random();
    let mut encrypted = plaintext.as_bytes().to_vec();
    cipher
        .seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce_bytes),
            Aad::empty(),
            &mut encrypted,
        )
        .map_err(|_| anyhow::anyhow!("failed to encrypt connector API key"))?;
    let mut encoded = Vec::with_capacity(nonce_bytes.len() + encrypted.len());
    encoded.extend_from_slice(&nonce_bytes);
    encoded.append(&mut encrypted);
    Ok(format!("{CONNECTOR_KEY_PREFIX}{}", hex::encode(encoded)))
}

fn decrypt_connector_key(key: &[u8; 32], stored: &str) -> Result<String> {
    let encoded = stored
        .strip_prefix(CONNECTOR_KEY_PREFIX)
        .ok_or_else(|| anyhow::anyhow!("connector API key is not encrypted"))?;
    let bytes =
        hex::decode(encoded).map_err(|_| anyhow::anyhow!("invalid encrypted connector API key"))?;
    let (nonce, ciphertext) = bytes
        .split_at_checked(12)
        .ok_or_else(|| anyhow::anyhow!("invalid encrypted connector API key"))?;
    let cipher =
        LessSafeKey::new(UnboundKey::new(&aead::AES_256_GCM, key).expect("32-byte AES key"));
    let mut ciphertext = ciphertext.to_vec();
    let plaintext = cipher
        .open_in_place(
            Nonce::try_assume_unique_for_key(nonce)
                .map_err(|_| anyhow::anyhow!("invalid encrypted connector API key"))?,
            Aad::empty(),
            &mut ciphertext,
        )
        .map_err(|_| anyhow::anyhow!("failed to decrypt connector API key"))?;
    String::from_utf8(plaintext.to_vec())
        .map_err(|_| anyhow::anyhow!("connector API key is not UTF-8"))
}

#[derive(Clone)]
pub struct Db {
    /// Default global pool. Repositories use this until per-context routing
    /// lands (O4.3); kept public for backward compatibility.
    pub pool: PgPool,
    /// Data-residency connection provider (default: single pool, O4.1).
    provider: Arc<dyn ConnectionProvider>,
    connector_encryption_key: [u8; 32],
}

impl Db {
    /// Create a pool without opening a connection. Useful for offline engine
    /// tests whose graph only uses the key-free mock provider.
    pub fn connect_lazy(database_url: &str) -> Result<Self> {
        let pool = PgPoolOptions::new().connect_lazy(database_url)?;
        let provider: Arc<dyn ConnectionProvider> = Arc::new(
            SinglePoolProvider::new(pool.clone(), default_storage_target("default"))
                .map_err(|error| anyhow::anyhow!(error.to_string()))?,
        );
        Ok(Self {
            pool,
            provider,
            connector_encryption_key: connector_encryption_key()?,
        })
    }

    pub async fn connect(database_url: &str) -> Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(database_url)
            .await?;
        let provider: Arc<dyn ConnectionProvider> = Arc::new(
            SinglePoolProvider::new(pool.clone(), default_storage_target("default"))
                .map_err(|error| anyhow::anyhow!(error.to_string()))?,
        );
        Ok(Self {
            pool,
            provider,
            connector_encryption_key: connector_encryption_key()?,
        })
    }

    /// Resolve the pool for a storage context (request path; no Kubernetes).
    pub fn pool_for(&self, context: &StorageContext) -> Result<PgPool, ResidencyError> {
        self.provider.pool_for(context)
    }

    /// Resolve the pool for an org via the residency provider (O4.3).
    ///
    /// With the default single-pool binding this returns the global pool, so
    /// behavior is unchanged; multi-target deployments route per org through the
    /// `CachingConnectionProvider` transparently. Every org-scoped repository
    /// method routes through here. Pre-auth / website-keyed paths (login, token
    /// resolution, delivery) stay on [`Db::pool`] until the org is resolved
    /// upstream.
    fn org_pool(&self, org_id: Uuid) -> Result<PgPool> {
        let context = residency::default_storage_context(&org_id.to_string());
        Ok(self.pool_for(&context)?)
    }

    /// Apply all migrations in `/migrations` (relative to the workspace root).
    pub async fn migrate(&self) -> Result<()> {
        sqlx::migrate!("../../migrations").run(&self.pool).await?;
        self.migrate_ai_connector_keys().await?;
        Ok(())
    }

    /// Encrypt legacy plaintext connector keys after the schema migration.
    async fn migrate_ai_connector_keys(&self) -> Result<()> {
        let rows: Vec<(Uuid, String)> = sqlx::query_as(
            "SELECT id, api_key FROM ai_connectors WHERE api_key IS NOT NULL AND api_key NOT LIKE 'v1:%'",
        )
        .fetch_all(&self.pool)
        .await?;
        for (id, plaintext) in rows {
            let encrypted = encrypt_connector_key(&self.connector_encryption_key, &plaintext)?;
            sqlx::query("UPDATE ai_connectors SET api_key = $2 WHERE id = $1 AND api_key = $3")
                .bind(id)
                .bind(encrypted)
                .bind(plaintext)
                .execute(&self.pool)
                .await?;
        }
        Ok(())
    }

    /// Lightweight connectivity check for the readiness probe.
    pub async fn ping(&self) -> Result<()> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }
}

#[cfg(test)]
mod connector_key_tests {
    use super::{decrypt_connector_key, encrypt_connector_key};
    use serde_json::json;
    use sitegraph_domain::AiConnector;
    use uuid::Uuid;

    #[test]
    fn connector_keys_round_trip_with_authenticated_encryption() {
        let key = [7_u8; 32];
        let encrypted = encrypt_connector_key(&key, "sk-live-never-return-this").unwrap();
        assert!(encrypted.starts_with("v1:"));
        assert_ne!(encrypted, "sk-live-never-return-this");
        assert_eq!(
            decrypt_connector_key(&key, &encrypted).unwrap(),
            "sk-live-never-return-this"
        );
        assert!(decrypt_connector_key(&[8_u8; 32], &encrypted).is_err());
    }

    #[test]
    fn connector_api_shape_does_not_serialize_a_key() {
        let connector = AiConnector {
            id: Uuid::nil(),
            org_id: Uuid::nil(),
            name: "Production".into(),
            provider: "anthropic".into(),
            active: true,
            has_key: true,
            preprompt: None,
            default_model: None,
            created_at: chrono::Utc::now(),
        };
        let body = json!(connector).to_string();
        assert!(body.contains("has_key"));
        assert!(!body.contains("api_key"));
        assert!(!body.contains("sk-live"));
    }
}

/// A conditional content mutation never confuses a stale revision with a
/// missing object and does not expose the newer content to the caller.
pub enum RevisionWriteResult<T> {
    Applied(T),
    NotFound,
    Conflict {
        current_revision: i64,
    },
    ScheduleConflict {
        current_revision: i64,
        current_schedule_revision: i64,
    },
}

pub type ContentWriteResult = RevisionWriteResult<ContentObject>;
pub type ScheduleWriteResult = RevisionWriteResult<ContentSchedule>;
pub type ChannelsWriteResult = RevisionWriteResult<(Vec<ChannelAssignment>, ContentObject)>;
pub type DeleteWriteResult = RevisionWriteResult<()>;

async fn check_content_revision<T>(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org_id: Uuid,
    id: Uuid,
    expected_revision: i64,
) -> Result<Option<RevisionWriteResult<T>>> {
    let revision: Option<(i64,)> = sqlx::query_as(
        "SELECT revision FROM content_objects WHERE org_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(org_id)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(match revision {
        None => Some(RevisionWriteResult::NotFound),
        Some((current_revision,)) if current_revision != expected_revision => {
            Some(RevisionWriteResult::Conflict { current_revision })
        }
        Some(_) => None,
    })
}

// --- Row structs (DB-shaped) mapped to domain types ------------------------

#[derive(FromRow)]
struct ContentObjectRow {
    id: Uuid,
    org_id: Uuid,
    content_type_id: Uuid,
    status: String,
    revision: i64,
    data: Value,
    published_data: Option<Value>,
    published_channels: Option<sqlx::types::Json<Vec<ChannelAssignment>>>,
    published_revision: Option<i64>,
    published_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl From<ContentObjectRow> for ContentObject {
    fn from(r: ContentObjectRow) -> Self {
        let has_unpublished_changes =
            r.status != "published" || r.published_revision != Some(r.revision);
        let publication = match (
            r.published_data,
            r.published_channels,
            r.published_revision,
            r.published_at,
        ) {
            (Some(data), Some(assignments), Some(revision), Some(published_at)) => {
                Some(ContentPublication {
                    data,
                    assignments: assignments.0,
                    revision,
                    published_at,
                })
            }
            _ => None,
        };
        ContentObject {
            id: r.id,
            org_id: r.org_id,
            content_type_id: r.content_type_id,
            status: Status::parse(&r.status),
            revision: r.revision,
            data: r.data,
            publication,
            has_unpublished_changes,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

#[derive(FromRow)]
struct ContentTypeRow {
    id: Uuid,
    org_id: Uuid,
    key: String,
    name: String,
    schema: Value,
}

impl From<ContentTypeRow> for ContentType {
    fn from(r: ContentTypeRow) -> Self {
        ContentType {
            id: r.id,
            org_id: r.org_id,
            key: r.key,
            name: r.name,
            schema: r.schema,
        }
    }
}

#[derive(FromRow)]
struct ContentVersionRow {
    id: Uuid,
    content_object_id: Uuid,
    data: Value,
    created_at: DateTime<Utc>,
}

impl From<ContentVersionRow> for ContentVersion {
    fn from(r: ContentVersionRow) -> Self {
        ContentVersion {
            id: r.id,
            content_object_id: r.content_object_id,
            data: r.data,
            created_at: r.created_at,
        }
    }
}

#[derive(FromRow)]
struct WebsiteRow {
    id: Uuid,
    org_id: Uuid,
    name: String,
    slug: String,
    domain: Option<String>,
    created_at: DateTime<Utc>,
}

impl From<WebsiteRow> for Website {
    fn from(r: WebsiteRow) -> Self {
        Website {
            id: r.id,
            org_id: r.org_id,
            name: r.name,
            slug: r.slug,
            domain: r.domain,
            created_at: r.created_at,
        }
    }
}

/// Write an immutable snapshot of `data` within an existing transaction (WP1.5).
async fn insert_version(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    content_object_id: Uuid,
    data: &Value,
) -> Result<()> {
    sqlx::query("INSERT INTO content_versions (content_object_id, data) VALUES ($1, $2)")
        .bind(content_object_id)
        .bind(data)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

// --- Content type lookups --------------------------------------------------

impl Db {
    pub async fn content_type_by_key(
        &self,
        org_id: Uuid,
        key: &str,
    ) -> Result<Option<ContentType>> {
        let row = sqlx::query_as::<_, ContentTypeRow>(
            "SELECT id, org_id, key, name, schema FROM content_types \
             WHERE org_id = $1 AND key = $2",
        )
        .bind(org_id)
        .bind(key)
        .fetch_optional(&self.org_pool(org_id)?)
        .await?;
        Ok(row.map(Into::into))
    }

    pub async fn list_content_types(&self, org_id: Uuid) -> Result<Vec<ContentType>> {
        let rows = sqlx::query_as::<_, ContentTypeRow>(
            "SELECT id, org_id, key, name, schema FROM content_types \
             WHERE org_id = $1 ORDER BY name",
        )
        .bind(org_id)
        .fetch_all(&self.org_pool(org_id)?)
        .await?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    /// Create a content type from a builder definition (WP v2 content modeling).
    pub async fn create_content_type(
        &self,
        org_id: Uuid,
        key: &str,
        name: &str,
        schema: &Value,
    ) -> Result<ContentType> {
        let row = sqlx::query_as::<_, ContentTypeRow>(
            "INSERT INTO content_types (org_id, key, name, schema) VALUES ($1, $2, $3, $4) \
             RETURNING id, org_id, key, name, schema",
        )
        .bind(org_id)
        .bind(key)
        .bind(name)
        .bind(schema)
        .fetch_one(&self.org_pool(org_id)?)
        .await?;
        Ok(row.into())
    }

    /// Update a content type's name and schema (the key is immutable).
    pub async fn update_content_type(
        &self,
        org_id: Uuid,
        key: &str,
        name: &str,
        schema: &Value,
    ) -> Result<Option<ContentType>> {
        let row = sqlx::query_as::<_, ContentTypeRow>(
            "UPDATE content_types SET name = $3, schema = $4 \
             WHERE org_id = $1 AND key = $2 \
             RETURNING id, org_id, key, name, schema",
        )
        .bind(org_id)
        .bind(key)
        .bind(name)
        .bind(schema)
        .fetch_optional(&self.org_pool(org_id)?)
        .await?;
        Ok(row.map(Into::into))
    }

    /// Whether any content objects exist for a type (guards deletion).
    pub async fn content_type_in_use(&self, org_id: Uuid, key: &str) -> Result<bool> {
        let row: Option<(i64,)> = sqlx::query_as(
            "SELECT COUNT(*) FROM content_objects co \
             JOIN content_types ct ON ct.id = co.content_type_id \
             WHERE co.org_id = $1 AND ct.key = $2",
        )
        .bind(org_id)
        .bind(key)
        .fetch_optional(&self.org_pool(org_id)?)
        .await?;
        Ok(row.map(|(n,)| n > 0).unwrap_or(false))
    }

    pub async fn delete_content_type(&self, org_id: Uuid, key: &str) -> Result<bool> {
        let res = sqlx::query("DELETE FROM content_types WHERE org_id = $1 AND key = $2")
            .bind(org_id)
            .bind(key)
            .execute(&self.org_pool(org_id)?)
            .await?;
        Ok(res.rows_affected() > 0)
    }

    pub async fn list_websites(&self, org_id: Uuid) -> Result<Vec<Website>> {
        let rows = sqlx::query_as::<_, WebsiteRow>(
            "SELECT id, org_id, name, slug, domain, created_at FROM websites \
             WHERE org_id = $1 ORDER BY name",
        )
        .bind(org_id)
        .fetch_all(&self.org_pool(org_id)?)
        .await?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn create_website(
        &self,
        org_id: Uuid,
        name: &str,
        slug: &str,
        domain: Option<&str>,
    ) -> Result<Website> {
        let row = sqlx::query_as::<_, WebsiteRow>(
            "INSERT INTO websites (org_id, name, slug, domain) VALUES ($1, $2, $3, $4) \
             RETURNING id, org_id, name, slug, domain, created_at",
        )
        .bind(org_id)
        .bind(name)
        .bind(slug)
        .bind(domain)
        .fetch_one(&self.org_pool(org_id)?)
        .await?;
        Ok(row.into())
    }
}

// --- Content CRUD (internal/admin API) -------------------------------------

impl Db {
    /// List content of a type with optional status filter and full-text-ish
    /// search over the JSON payload (v2). NULL params disable the respective
    /// filter, so the bind positions stay fixed (no dynamic SQL).
    pub async fn list_content(
        &self,
        org_id: Uuid,
        type_key: &str,
        status: Option<&str>,
        query: Option<&str>,
    ) -> Result<Vec<ContentObject>> {
        let pattern = query.map(|q| format!("%{q}%"));
        let rows = sqlx::query_as::<_, ContentObjectRow>(
            "SELECT co.id, co.org_id, co.content_type_id, co.status, co.revision, co.data, \
                    co.published_data, co.published_channels, co.published_revision, co.published_at, \
                    co.created_at, co.updated_at \
             FROM content_objects co \
             JOIN content_types ct ON ct.id = co.content_type_id \
             WHERE co.org_id = $1 AND ct.key = $2 \
               AND ($3::text IS NULL OR co.status = $3) \
               AND ($4::text IS NULL OR co.data::text ILIKE $4) \
             ORDER BY co.updated_at DESC",
        )
        .bind(org_id)
        .bind(type_key)
        .bind(status)
        .bind(pattern)
        .fetch_all(&self.org_pool(org_id)?)
        .await?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn get_content(&self, org_id: Uuid, id: Uuid) -> Result<Option<ContentObject>> {
        let row = sqlx::query_as::<_, ContentObjectRow>(
            "SELECT id, org_id, content_type_id, status, revision, data, \
                       published_data, published_channels, published_revision, published_at, \
                       created_at, updated_at \
             FROM content_objects WHERE org_id = $1 AND id = $2",
        )
        .bind(org_id)
        .bind(id)
        .fetch_optional(&self.org_pool(org_id)?)
        .await?;
        Ok(row.map(Into::into))
    }

    /// Resolve an admin object URL by its complete identity, including type.
    /// Both sides of the join must belong to the requested organization.
    pub async fn get_content_by_type(
        &self,
        org_id: Uuid,
        type_key: &str,
        id: Uuid,
    ) -> Result<Option<ContentObject>> {
        let row = sqlx::query_as::<_, ContentObjectRow>(
            "SELECT co.id, co.org_id, co.content_type_id, co.status, co.revision, co.data, \
                    co.published_data, co.published_channels, co.published_revision, co.published_at, \
                    co.created_at, co.updated_at \
             FROM content_objects co \
             JOIN content_types ct ON ct.id = co.content_type_id AND ct.org_id = co.org_id \
             WHERE co.org_id = $1 AND ct.key = $2 AND co.id = $3",
        )
        .bind(org_id)
        .bind(type_key)
        .bind(id)
        .fetch_optional(&self.org_pool(org_id)?)
        .await?;
        Ok(row.map(Into::into))
    }

    pub async fn create_content(
        &self,
        org_id: Uuid,
        content_type_id: Uuid,
        data: &Value,
    ) -> Result<ContentObject> {
        let mut tx = self.org_pool(org_id)?.begin().await?;
        let row = sqlx::query_as::<_, ContentObjectRow>(
            "INSERT INTO content_objects (org_id, content_type_id, status, data) \
             VALUES ($1, $2, 'draft', $3) \
             RETURNING id, org_id, content_type_id, status, revision, data, \
                       published_data, published_channels, published_revision, published_at, \
                       created_at, updated_at",
        )
        .bind(org_id)
        .bind(content_type_id)
        .bind(data)
        .fetch_one(&mut *tx)
        .await?;
        insert_version(&mut tx, row.id, &row.data).await?;
        tx.commit().await?;
        Ok(row.into())
    }

    /// Lock, compare, update and record history in one transaction. A writer
    /// waiting on another writer observes the newly committed revision.
    pub async fn update_content_data(
        &self,
        org_id: Uuid,
        id: Uuid,
        data: &Value,
        expected_revision: i64,
    ) -> Result<ContentWriteResult> {
        let mut tx = self.org_pool(org_id)?.begin().await?;
        if let Some(rejection) =
            check_content_revision(&mut tx, org_id, id, expected_revision).await?
        {
            return Ok(rejection);
        }
        let row = sqlx::query_as::<_, ContentObjectRow>(
            "UPDATE content_objects SET data = $3, updated_at = now() \
             WHERE org_id = $1 AND id = $2 \
             RETURNING id, org_id, content_type_id, status, revision, data, \
                       published_data, published_channels, published_revision, published_at, \
                       created_at, updated_at",
        )
        .bind(org_id)
        .bind(id)
        .bind(data)
        .fetch_one(&mut *tx)
        .await?;
        insert_version(&mut tx, row.id, &row.data).await?;
        tx.commit().await?;
        Ok(ContentWriteResult::Applied(row.into()))
    }

    /// User-requested transitions must compare the editor's revision under
    /// the same row lock that protects the status update.
    pub async fn set_status_at_revision(
        &self,
        org_id: Uuid,
        id: Uuid,
        status: Status,
        expected_revision: i64,
    ) -> Result<ContentWriteResult> {
        let mut tx = self.org_pool(org_id)?.begin().await?;
        if let Some(rejection) =
            check_content_revision(&mut tx, org_id, id, expected_revision).await?
        {
            return Ok(rejection);
        }
        let row = sqlx::query_as::<_, ContentObjectRow>(
            "UPDATE content_objects SET status = $3, updated_at = now(), \
                    publish_at = NULL, unpublish_at = NULL, publish_revision = NULL \
             WHERE org_id = $1 AND id = $2 \
             RETURNING id, org_id, content_type_id, status, revision, data, \
                       published_data, published_channels, published_revision, published_at, \
                       created_at, updated_at",
        )
        .bind(org_id)
        .bind(id)
        .bind(status.as_str())
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(ContentWriteResult::Applied(row.into()))
    }

    /// Internal transitions (e.g. a freshly AI-created object). The database
    /// trigger still increments the revision, invalidating existing editors.
    pub async fn set_status(
        &self,
        org_id: Uuid,
        id: Uuid,
        status: Status,
    ) -> Result<Option<ContentObject>> {
        let row = sqlx::query_as::<_, ContentObjectRow>(
            "UPDATE content_objects SET status = $3, updated_at = now(), \
                    publish_at = NULL, unpublish_at = NULL, publish_revision = NULL \
             WHERE org_id = $1 AND id = $2 \
             RETURNING id, org_id, content_type_id, status, revision, data, \
                       published_data, published_channels, published_revision, published_at, \
                       created_at, updated_at",
        )
        .bind(org_id)
        .bind(id)
        .bind(status.as_str())
        .fetch_optional(&self.org_pool(org_id)?)
        .await?;
        Ok(row.map(Into::into))
    }

    pub async fn delete_content(&self, org_id: Uuid, id: Uuid) -> Result<bool> {
        let res = sqlx::query("DELETE FROM content_objects WHERE org_id = $1 AND id = $2")
            .bind(org_id)
            .bind(id)
            .execute(&self.org_pool(org_id)?)
            .await?;
        Ok(res.rows_affected() > 0)
    }

    /// Deletion compares the client's reviewed revision under the same row
    /// lock used by edits, channel replacement, publication and scheduling.
    pub async fn delete_content_at_revision(
        &self,
        org_id: Uuid,
        id: Uuid,
        expected_revision: i64,
    ) -> Result<DeleteWriteResult> {
        let mut tx = self.org_pool(org_id)?.begin().await?;
        if let Some(rejection) =
            check_content_revision(&mut tx, org_id, id, expected_revision).await?
        {
            return Ok(rejection);
        }
        sqlx::query("DELETE FROM content_objects WHERE org_id = $1 AND id = $2")
            .bind(org_id)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(DeleteWriteResult::Applied(()))
    }
}

// --- Channel assignments + delivery ----------------------------------------

impl Db {
    /// Replace working-copy channels under the content row lock. Publishing
    /// takes the same lock, so a release cannot capture a partial assignment set.
    pub async fn set_channel_assignments(
        &self,
        org_id: Uuid,
        content_object_id: Uuid,
        assignments: &[ChannelAssignment],
    ) -> Result<(Vec<ChannelAssignment>, ContentObject)> {
        match self
            .set_channel_assignments_inner(org_id, content_object_id, assignments, None)
            .await?
        {
            ChannelsWriteResult::Applied(value) => Ok(value),
            ChannelsWriteResult::NotFound => anyhow::bail!("content object not found in org"),
            ChannelsWriteResult::Conflict { .. } | ChannelsWriteResult::ScheduleConflict { .. } => {
                anyhow::bail!("unexpected internal revision conflict")
            }
        }
    }

    pub async fn set_channel_assignments_at_revision(
        &self,
        org_id: Uuid,
        content_object_id: Uuid,
        assignments: &[ChannelAssignment],
        expected_revision: i64,
    ) -> Result<ChannelsWriteResult> {
        self.set_channel_assignments_inner(
            org_id,
            content_object_id,
            assignments,
            Some(expected_revision),
        )
        .await
    }

    async fn set_channel_assignments_inner(
        &self,
        org_id: Uuid,
        content_object_id: Uuid,
        assignments: &[ChannelAssignment],
        expected_revision: Option<i64>,
    ) -> Result<ChannelsWriteResult> {
        let mut tx = self.org_pool(org_id)?.begin().await?;
        if let Some(expected_revision) = expected_revision {
            if let Some(rejection) =
                check_content_revision(&mut tx, org_id, content_object_id, expected_revision)
                    .await?
            {
                return Ok(rejection);
            }
        } else {
            let owns: Option<(Uuid,)> = sqlx::query_as(
                "SELECT id FROM content_objects WHERE org_id = $1 AND id = $2 FOR UPDATE",
            )
            .bind(org_id)
            .bind(content_object_id)
            .fetch_optional(&mut *tx)
            .await?;
            if owns.is_none() {
                return Ok(ChannelsWriteResult::NotFound);
            }
        }

        sqlx::query("DELETE FROM content_channel_assignments WHERE content_object_id = $1")
            .bind(content_object_id)
            .execute(&mut *tx)
            .await?;
        for a in assignments {
            let inserted = sqlx::query(
                "INSERT INTO content_channel_assignments (content_object_id, website_id, overrides) \
                 SELECT $1, w.id, $3 FROM websites w WHERE w.id = $2 AND w.org_id = $4",
            )
            .bind(content_object_id)
            .bind(a.website_id)
            .bind(a.overrides.as_ref())
            .bind(org_id)
            .execute(&mut *tx)
            .await?;
            if inserted.rows_affected() != 1 {
                anyhow::bail!("channel website not found in org");
            }
        }
        let current: Vec<(Uuid, Option<Value>)> = sqlx::query_as(
            "SELECT website_id, overrides FROM content_channel_assignments \
             WHERE content_object_id = $1 ORDER BY website_id",
        )
        .bind(content_object_id)
        .fetch_all(&mut *tx)
        .await?;
        // Deliberately do not write data/status: the live snapshot stays intact.
        let row = sqlx::query_as::<_, ContentObjectRow>(
            "UPDATE content_objects SET revision = revision + 1, updated_at = now() \
             WHERE org_id = $1 AND id = $2 \
             RETURNING id, org_id, content_type_id, status, revision, data, \
                       published_data, published_channels, published_revision, published_at, \
                       created_at, updated_at",
        )
        .bind(org_id)
        .bind(content_object_id)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(ChannelsWriteResult::Applied((
            current
                .into_iter()
                .map(|(website_id, overrides)| ChannelAssignment {
                    website_id,
                    overrides,
                })
                .collect(),
            row.into(),
        )))
    }

    /// Read channels and their content revision from one database snapshot.
    /// Separate queries could pair older assignments with a newly published token.
    pub async fn get_channel_assignments(
        &self,
        org_id: Uuid,
        content_object_id: Uuid,
    ) -> Result<Option<(Vec<ChannelAssignment>, i64)>> {
        let row = sqlx::query_as::<_, (sqlx::types::Json<Vec<ChannelAssignment>>, i64)>(
            "SELECT COALESCE(( \
                 SELECT jsonb_agg(jsonb_build_object( \
                     'website_id', cca.website_id, 'overrides', cca.overrides \
                 ) ORDER BY cca.website_id) \
                 FROM content_channel_assignments cca \
                 JOIN websites w ON w.id = cca.website_id AND w.org_id = co.org_id \
                 WHERE cca.content_object_id = co.id \
             ), '[]'::jsonb), co.revision \
             FROM content_objects co WHERE co.org_id = $1 AND co.id = $2",
        )
        .bind(org_id)
        .bind(content_object_id)
        .fetch_optional(&self.org_pool(org_id)?)
        .await?;
        Ok(row.map(|(assignments, revision)| (assignments.0, revision)))
    }

    /// Version history of an object, newest first (org-scoped, WP1.5).
    pub async fn list_versions(
        &self,
        org_id: Uuid,
        content_object_id: Uuid,
    ) -> Result<Vec<ContentVersion>> {
        let rows = sqlx::query_as::<_, ContentVersionRow>(
            "SELECT cv.id, cv.content_object_id, cv.data, cv.created_at \
             FROM content_versions cv \
             JOIN content_objects co ON co.id = cv.content_object_id \
             WHERE cv.content_object_id = $1 AND co.org_id = $2 \
             ORDER BY cv.created_at DESC",
        )
        .bind(content_object_id)
        .bind(org_id)
        .fetch_all(&self.org_pool(org_id)?)
        .await?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    /// Check the full version path before validating mutation preconditions.
    pub async fn content_version_exists(
        &self,
        org_id: Uuid,
        content_object_id: Uuid,
        version_id: Uuid,
    ) -> Result<bool> {
        let (exists,): (bool,) = sqlx::query_as(
            "SELECT EXISTS (SELECT 1 FROM content_versions cv \
             JOIN content_objects co ON co.id = cv.content_object_id \
             WHERE co.org_id = $1 AND co.id = $2 AND cv.id = $3)",
        )
        .bind(org_id)
        .bind(content_object_id)
        .bind(version_id)
        .fetch_one(&self.org_pool(org_id)?)
        .await?;
        Ok(exists)
    }

    /// Restore an immutable snapshot only if it belongs to this object/org
    /// and the editor's revision is current. The new history row is atomic.
    pub async fn revert(
        &self,
        org_id: Uuid,
        content_object_id: Uuid,
        version_id: Uuid,
        expected_revision: i64,
    ) -> Result<ContentWriteResult> {
        let mut tx = self.org_pool(org_id)?.begin().await?;
        let snapshot: Option<(Value,)> = sqlx::query_as(
            "SELECT cv.data FROM content_versions cv \
             JOIN content_objects co ON co.id = cv.content_object_id \
             WHERE cv.id = $1 AND cv.content_object_id = $2 AND co.org_id = $3",
        )
        .bind(version_id)
        .bind(content_object_id)
        .bind(org_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some((data,)) = snapshot else {
            return Ok(ContentWriteResult::NotFound);
        };
        if let Some(rejection) =
            check_content_revision(&mut tx, org_id, content_object_id, expected_revision).await?
        {
            return Ok(rejection);
        }
        let row = sqlx::query_as::<_, ContentObjectRow>(
            "UPDATE content_objects SET data = $3, updated_at = now() \
             WHERE org_id = $1 AND id = $2 \
             RETURNING id, org_id, content_type_id, status, revision, data, \
                       published_data, published_channels, published_revision, published_at, \
                       created_at, updated_at",
        )
        .bind(org_id)
        .bind(content_object_id)
        .bind(&data)
        .fetch_one(&mut *tx)
        .await?;
        insert_version(&mut tx, row.id, &row.data).await?;
        tx.commit().await?;
        Ok(ContentWriteResult::Applied(row.into()))
    }

    /// Public delivery (Pull, Whitepaper §13): published objects of `type_key`
    /// assigned to `website_id`, returned as raw `data` plus the per-channel
    /// `overrides` (merging is done by the caller). The website is resolved and
    /// authorized by the caller via the API token.
    pub async fn delivery_list(
        &self,
        org_id: Uuid,
        website_id: Uuid,
        type_key: &str,
    ) -> Result<Vec<(Value, Option<Value>)>> {
        let rows: Vec<(Value, Option<Value>)> = sqlx::query_as(
            "SELECT co.published_data, NULLIF(channel.value->'overrides', 'null'::jsonb) \
             FROM content_objects co \
             JOIN content_types ct ON ct.id = co.content_type_id AND ct.org_id = co.org_id \
             CROSS JOIN LATERAL jsonb_array_elements(co.published_channels) channel(value) \
             JOIN websites w ON w.id::text = channel.value->>'website_id' AND w.org_id = co.org_id \
             WHERE co.org_id = $1 AND w.id = $2 AND ct.key = $3 AND co.status = 'published' \
             ORDER BY co.published_at DESC, co.id",
        )
        .bind(org_id)
        .bind(website_id)
        .bind(type_key)
        .fetch_all(&self.org_pool(org_id)?)
        .await?;
        Ok(rows)
    }

    pub async fn website_by_org_slug(&self, org_id: Uuid, slug: &str) -> Result<Option<Website>> {
        let row = sqlx::query_as::<_, WebsiteRow>(
            "SELECT id, org_id, name, slug, domain, created_at FROM websites \
             WHERE org_id = $1 AND slug = $2",
        )
        .bind(org_id)
        .bind(slug)
        .fetch_optional(&self.org_pool(org_id)?)
        .await?;
        Ok(row.map(Into::into))
    }
}

// --- Audit log (WP1.4) -----------------------------------------------------

#[derive(FromRow)]
struct AuditRow {
    id: Uuid,
    user_id: Option<Uuid>,
    user_email: Option<String>,
    action: String,
    target_type: String,
    target_id: Option<Uuid>,
    meta: Option<Value>,
    created_at: DateTime<Utc>,
}

impl From<AuditRow> for AuditEntry {
    fn from(r: AuditRow) -> Self {
        AuditEntry {
            id: r.id,
            user_id: r.user_id,
            user_email: r.user_email,
            action: r.action,
            target_type: r.target_type,
            target_id: r.target_id,
            meta: r.meta,
            created_at: r.created_at,
        }
    }
}

impl Db {
    /// Append an audit record (best-effort caller; org-scoped).
    pub async fn insert_audit(
        &self,
        org_id: Uuid,
        user_id: Option<Uuid>,
        action: &str,
        target_type: &str,
        target_id: Option<Uuid>,
        meta: Option<&Value>,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO audit_log (org_id, user_id, action, target_type, target_id, meta) \
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(org_id)
        .bind(user_id)
        .bind(action)
        .bind(target_type)
        .bind(target_id)
        .bind(meta)
        .execute(&self.org_pool(org_id)?)
        .await?;
        Ok(())
    }

    pub async fn list_audit(&self, org_id: Uuid, limit: i64) -> Result<Vec<AuditEntry>> {
        let rows = sqlx::query_as::<_, AuditRow>(
            "SELECT al.id, al.user_id, u.email AS user_email, al.action, al.target_type, \
                    al.target_id, al.meta, al.created_at \
             FROM audit_log al \
             LEFT JOIN users u ON u.id = al.user_id \
             WHERE al.org_id = $1 ORDER BY al.created_at DESC LIMIT $2",
        )
        .bind(org_id)
        .bind(limit)
        .fetch_all(&self.org_pool(org_id)?)
        .await?;
        Ok(rows.into_iter().map(Into::into).collect())
    }
}

// --- Auth: users, memberships, API tokens (WP1.3) --------------------------

/// A user plus its password hash, for login verification only.
pub struct UserWithHash {
    pub user: User,
    pub password_hash: String,
    /// Cross-org platform administrator (gates the control-plane views).
    pub is_platform_admin: bool,
    pub session_version: i32,
}

#[derive(FromRow)]
struct UserRow {
    id: Uuid,
    email: String,
    name: String,
    password_hash: String,
    is_platform_admin: bool,
    session_version: i32,
}

impl Db {
    /// Operator recovery: atomically replace the hash and invalidate all prior JWTs.
    pub async fn reset_password_and_revoke(
        &self,
        email: &str,
        password_hash: &str,
    ) -> Result<bool> {
        Ok(sqlx::query("UPDATE users SET password_hash = $2, session_version = session_version + 1 WHERE lower(email) = lower($1)")
            .bind(email).bind(password_hash).execute(&self.pool).await?.rows_affected() == 1)
    }

    /// Self-service credential replacement: only the hash just verified by the
    /// caller may be replaced. A concurrent reset/change wins without being
    /// overwritten; session revocation is part of the same atomic update.
    pub async fn change_password_if_current(
        &self,
        user_id: Uuid,
        expected_hash: &str,
        new_hash: &str,
    ) -> Result<bool> {
        Ok(sqlx::query(
            "UPDATE users SET password_hash = $3, session_version = session_version + 1 \
             WHERE id = $1 AND password_hash = $2",
        )
        .bind(user_id)
        .bind(expected_hash)
        .bind(new_hash)
        .execute(&self.pool)
        .await?
        .rows_affected()
            == 1)
    }

    pub async fn password_hash_by_id(&self, user_id: Uuid) -> Result<Option<String>> {
        Ok(
            sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1")
                .bind(user_id)
                .fetch_optional(&self.pool)
                .await?,
        )
    }

    /// Always read current authorization/session state; password recovery revokes JWTs.
    pub async fn user_session(&self, id: Uuid) -> Result<Option<(i32, bool)>> {
        Ok(
            sqlx::query_as("SELECT session_version, is_platform_admin FROM users WHERE id = $1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?,
        )
    }

    pub async fn user_with_hash_by_email(&self, email: &str) -> Result<Option<UserWithHash>> {
        let row = sqlx::query_as::<_, UserRow>(
            "SELECT id, email, name, password_hash, is_platform_admin, session_version FROM users WHERE email = $1",
        )
        .bind(email)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| UserWithHash {
            user: User {
                id: r.id,
                email: r.email,
                name: r.name,
            },
            password_hash: r.password_hash,
            is_platform_admin: r.is_platform_admin,
            session_version: r.session_version,
        }))
    }

    pub async fn user_by_id(&self, id: Uuid) -> Result<Option<User>> {
        let row = sqlx::query_as::<_, UserRow>(
            "SELECT id, email, name, password_hash, is_platform_admin, session_version FROM users WHERE id = $1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| User {
            id: r.id,
            email: r.email,
            name: r.name,
        }))
    }

    /// Whether a user is a platform administrator (used on token refresh, which
    /// has no other user context).
    pub async fn is_platform_admin(&self, id: Uuid) -> Result<bool> {
        let row: Option<(bool,)> =
            sqlx::query_as("SELECT is_platform_admin FROM users WHERE id = $1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|(flag,)| flag).unwrap_or(false))
    }

    /// Grant or revoke platform-admin (used by the demo bootstrap).
    pub async fn set_platform_admin(&self, id: Uuid, flag: bool) -> Result<()> {
        sqlx::query("UPDATE users SET is_platform_admin = $2 WHERE id = $1")
            .bind(id)
            .bind(flag)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn list_memberships(&self, user_id: Uuid) -> Result<Vec<Membership>> {
        let rows: Vec<(Uuid, String, String)> = sqlx::query_as(
            "SELECT m.org_id, m.role, o.name \
             FROM memberships m JOIN organizations o ON o.id = m.org_id \
             WHERE m.user_id = $1 ORDER BY o.name",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .filter_map(|(org_id, role, org_name)| {
                Role::parse(&role).map(|role| Membership {
                    org_id,
                    org_name,
                    role,
                })
            })
            .collect())
    }

    /// The user's role in an org, or `None` if not a member (authorization).
    pub async fn membership_role(&self, org_id: Uuid, user_id: Uuid) -> Result<Option<Role>> {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2")
                .bind(org_id)
                .bind(user_id)
                .fetch_optional(&self.org_pool(org_id)?)
                .await?;
        Ok(row.and_then(|(r,)| Role::parse(&r)))
    }

    /// Idempotent upsert used by the demo bootstrap.
    pub async fn upsert_user(
        &self,
        id: Uuid,
        email: &str,
        name: &str,
        password_hash: &str,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4) \
             ON CONFLICT (id) DO NOTHING",
        )
        .bind(id)
        .bind(email)
        .bind(name)
        .bind(password_hash)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn upsert_membership(&self, org_id: Uuid, user_id: Uuid, role: Role) -> Result<()> {
        sqlx::query(
            "INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3) \
             ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role",
        )
        .bind(org_id)
        .bind(user_id)
        .bind(role.as_str())
        .execute(&self.org_pool(org_id)?)
        .await?;
        Ok(())
    }

    /// Create an API token (stores only the hash). Returns nothing; the caller
    /// holds the plaintext.
    pub async fn create_api_token(
        &self,
        org_id: Uuid,
        website_id: Option<Uuid>,
        name: &str,
        token_hash: &str,
    ) -> Result<Uuid> {
        let row: (Uuid,) = sqlx::query_as(
            "INSERT INTO api_tokens (org_id, website_id, name, token_hash) \
             VALUES ($1, $2, $3, $4) RETURNING id",
        )
        .bind(org_id)
        .bind(website_id)
        .bind(name)
        .bind(token_hash)
        .fetch_one(&self.org_pool(org_id)?)
        .await?;
        Ok(row.0)
    }

    /// Idempotent token upsert by hash, used by the demo bootstrap.
    pub async fn upsert_api_token(
        &self,
        org_id: Uuid,
        website_id: Option<Uuid>,
        name: &str,
        token_hash: &str,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO api_tokens (org_id, website_id, name, token_hash) \
             VALUES ($1, $2, $3, $4) ON CONFLICT (token_hash) DO NOTHING",
        )
        .bind(org_id)
        .bind(website_id)
        .bind(name)
        .bind(token_hash)
        .execute(&self.org_pool(org_id)?)
        .await?;
        Ok(())
    }

    pub async fn delete_api_token(&self, org_id: Uuid, id: Uuid) -> Result<bool> {
        let res = sqlx::query("DELETE FROM api_tokens WHERE org_id = $1 AND id = $2")
            .bind(org_id)
            .bind(id)
            .execute(&self.org_pool(org_id)?)
            .await?;
        Ok(res.rows_affected() > 0)
    }

    pub async fn list_api_tokens(&self, org_id: Uuid) -> Result<Vec<(Uuid, String, Option<Uuid>)>> {
        let rows: Vec<(Uuid, String, Option<Uuid>)> = sqlx::query_as(
            "SELECT id, name, website_id FROM api_tokens WHERE org_id = $1 ORDER BY created_at",
        )
        .bind(org_id)
        .fetch_all(&self.org_pool(org_id)?)
        .await?;
        Ok(rows)
    }

    /// Look up a token by hash and stamp `last_used_at`. Returns the token's
    /// org and (optional) channel scope.
    pub async fn consume_api_token(
        &self,
        token_hash: &str,
    ) -> Result<Option<(Uuid, Option<Uuid>)>> {
        let row: Option<(Uuid, Option<Uuid>)> = sqlx::query_as(
            "UPDATE api_tokens SET last_used_at = now() WHERE token_hash = $1 \
             RETURNING org_id, website_id",
        )
        .bind(token_hash)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }
}

// --- Media assets (v2) -----------------------------------------------------

#[derive(FromRow)]
struct AssetRow {
    id: Uuid,
    org_id: Uuid,
    filename: String,
    content_type: String,
    byte_size: i64,
    created_at: DateTime<Utc>,
}

impl From<AssetRow> for Asset {
    fn from(r: AssetRow) -> Self {
        Asset {
            id: r.id,
            org_id: r.org_id,
            filename: r.filename,
            content_type: r.content_type,
            byte_size: r.byte_size,
            created_at: r.created_at,
        }
    }
}

impl Db {
    pub async fn create_asset(
        &self,
        org_id: Uuid,
        filename: &str,
        content_type: &str,
        byte_size: i64,
        storage_key: &str,
    ) -> Result<Asset> {
        let row = sqlx::query_as::<_, AssetRow>(
            "INSERT INTO assets (org_id, filename, content_type, byte_size, storage_key) \
             VALUES ($1, $2, $3, $4, $5) \
             RETURNING id, org_id, filename, content_type, byte_size, created_at",
        )
        .bind(org_id)
        .bind(filename)
        .bind(content_type)
        .bind(byte_size)
        .bind(storage_key)
        .fetch_one(&self.org_pool(org_id)?)
        .await?;
        Ok(row.into())
    }

    pub async fn list_assets(&self, org_id: Uuid) -> Result<Vec<Asset>> {
        let rows = sqlx::query_as::<_, AssetRow>(
            "SELECT id, org_id, filename, content_type, byte_size, created_at FROM assets \
             WHERE org_id = $1 ORDER BY created_at DESC",
        )
        .bind(org_id)
        .fetch_all(&self.org_pool(org_id)?)
        .await?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    /// Resolve an asset's content type + storage key for the public serve path.
    /// Org-scoped so it routes to the org's storage pool (data residency).
    pub async fn asset_blob_ref(&self, org_id: Uuid, id: Uuid) -> Result<Option<(String, String)>> {
        let row: Option<(String, String)> = sqlx::query_as(
            "SELECT content_type, storage_key FROM assets WHERE org_id = $1 AND id = $2",
        )
        .bind(org_id)
        .bind(id)
        .fetch_optional(&self.org_pool(org_id)?)
        .await?;
        Ok(row)
    }

    /// Delete an asset row, returning its storage key so the blob can be removed.
    pub async fn delete_asset(&self, org_id: Uuid, id: Uuid) -> hub::HubResult<Option<String>> {
        let mut tx = self.org_pool(org_id)?.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,76102))")
            .bind(org_id.to_string())
            .execute(&mut *tx)
            .await?;
        let key: Option<String> = sqlx::query_scalar(
            "SELECT storage_key FROM assets WHERE org_id=$1 AND id=$2 FOR UPDATE",
        )
        .bind(org_id)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
        if key.is_none() {
            return Ok(None);
        }
        let used: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM hub_media_usage WHERE org_id=$1 AND asset_id=$2)",
        )
        .bind(org_id)
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        if used {
            return Err(hub::HubError::Invalid("Die Datei wird noch in Unternehmensdaten verwendet. Zuerst die Verknüpfungen entfernen.".into()));
        }
        sqlx::query("DELETE FROM assets WHERE org_id=$1 AND id=$2")
            .bind(org_id)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(key)
    }
}

// --- Organizations & members (tenancy / team management) -------------------

impl Db {
    /// Create an organization and return its id (caller ensures a unique slug).
    pub async fn create_organization(&self, name: &str, slug: &str) -> Result<Uuid> {
        let row: (Uuid,) =
            sqlx::query_as("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id")
                .bind(name)
                .bind(slug)
                .fetch_one(&self.pool)
                .await?;
        Ok(row.0)
    }

    /// Members of an org with their role (org-admin view).
    pub async fn list_org_members(&self, org_id: Uuid) -> Result<Vec<(User, Role)>> {
        let rows: Vec<(Uuid, String, String, String)> = sqlx::query_as(
            "SELECT u.id, u.email, u.name, m.role FROM memberships m \
             JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY u.email",
        )
        .bind(org_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .filter_map(|(id, email, name, role)| {
                Role::parse(&role).map(|role| (User { id, email, name }, role))
            })
            .collect())
    }

    pub async fn user_id_by_email(&self, email: &str) -> Result<Option<Uuid>> {
        let row: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM users WHERE email = $1")
            .bind(email)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|(id,)| id))
    }

    /// Create a user (fails if the email already exists; callers check first).
    pub async fn create_user(&self, email: &str, name: &str, password_hash: &str) -> Result<Uuid> {
        let row: (Uuid,) = sqlx::query_as(
            "INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(email)
        .bind(name)
        .bind(password_hash)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.0)
    }

    /// Number of owners in an org (guards against removing the last owner).
    pub async fn count_org_owners(&self, org_id: Uuid) -> Result<i64> {
        let row: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM memberships WHERE org_id = $1 AND role = 'owner'")
                .bind(org_id)
                .fetch_one(&self.pool)
                .await?;
        Ok(row.0)
    }

    pub async fn remove_membership(&self, org_id: Uuid, user_id: Uuid) -> Result<bool> {
        let res = sqlx::query("DELETE FROM memberships WHERE org_id = $1 AND user_id = $2")
            .bind(org_id)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(res.rows_affected() > 0)
    }
}

// --- Scheduling + preview (v2) ---------------------------------------------

#[derive(FromRow)]
struct ContentScheduleRow {
    schedule_revision: i64,
    publish_at: Option<DateTime<Utc>>,
    unpublish_at: Option<DateTime<Utc>>,
    publish_revision: Option<i64>,
    revision: i64,
}

impl From<ContentScheduleRow> for ContentSchedule {
    fn from(row: ContentScheduleRow) -> Self {
        Self {
            schedule_revision: row.schedule_revision,
            publish_at: row.publish_at,
            unpublish_at: row.unpublish_at,
            publish_revision: row.publish_revision,
            publish_conflict: row.publish_at.is_some()
                && row.publish_revision != Some(row.revision),
            revision: row.revision,
        }
    }
}

#[cfg(test)]
mod publication_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn editor_response_preserves_the_last_release_after_a_draft_edit() {
        let now = Utc::now();
        let website_id = Uuid::new_v4();
        let object: ContentObject = ContentObjectRow {
            id: Uuid::new_v4(),
            org_id: Uuid::new_v4(),
            content_type_id: Uuid::new_v4(),
            status: "published".into(),
            revision: 9,
            data: json!({"title": "Unapproved working copy"}),
            published_data: Some(json!({"title": "Approved release"})),
            published_channels: Some(sqlx::types::Json(vec![ChannelAssignment {
                website_id,
                overrides: Some(json!({"title": "Approved channel title"})),
            }])),
            published_revision: Some(8),
            published_at: Some(now),
            created_at: now,
            updated_at: now,
        }
        .into();
        let body = serde_json::to_value(object).unwrap();
        assert_eq!(body["status"], "published");
        assert_eq!(body["revision"], 9);
        assert_eq!(body["has_unpublished_changes"], true);
        assert_eq!(body["data"]["title"], "Unapproved working copy");
        assert_eq!(body["publication"]["data"]["title"], "Approved release");
        assert_eq!(body["publication"]["revision"], 8);
        assert_eq!(
            body["publication"]["assignments"][0]["website_id"],
            json!(website_id)
        );
        assert_eq!(
            body["publication"]["assignments"][0]["overrides"]["title"],
            "Approved channel title"
        );
    }

    #[test]
    fn a_scheduled_release_exposes_changed_or_missing_approval_without_hiding_its_deadline() {
        let deadline = Utc::now();
        for (publish_revision, conflict) in [(Some(7), false), (Some(6), true), (None, true)] {
            let schedule: ContentSchedule = ContentScheduleRow {
                schedule_revision: 2,
                publish_at: Some(deadline),
                unpublish_at: None,
                publish_revision,
                revision: 7,
            }
            .into();
            assert_eq!(schedule.publish_at, Some(deadline));
            assert_eq!(schedule.publish_revision, publish_revision);
            assert_eq!(schedule.publish_conflict, conflict);
        }
    }
}

#[derive(FromRow)]
struct DueContentTransition {
    org_id: Uuid,
    id: Uuid,
    type_key: String,
    published: bool,
    publish_due: bool,
    unpublish_due: bool,
    publish_revision: Option<i64>,
    revision: i64,
}

impl Db {
    /// Scheduling approves a specific working revision, without consuming it.
    /// Later edits visibly invalidate the planned release until re-approved.
    pub async fn set_schedule(
        &self,
        org_id: Uuid,
        id: Uuid,
        publish_at: Option<DateTime<Utc>>,
        unpublish_at: Option<DateTime<Utc>>,
        expected_revision: i64,
        expected_schedule_revision: i64,
    ) -> Result<ScheduleWriteResult> {
        let mut tx = self.org_pool(org_id)?.begin().await?;
        if let Some(rejection) =
            check_content_revision(&mut tx, org_id, id, expected_revision).await?
        {
            return Ok(rejection);
        }
        let (schedule_revision,): (i64,) = sqlx::query_as(
            "SELECT schedule_revision FROM content_objects WHERE org_id = $1 AND id = $2",
        )
        .bind(org_id)
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        if schedule_revision != expected_schedule_revision {
            return Ok(ScheduleWriteResult::ScheduleConflict {
                current_revision: expected_revision,
                current_schedule_revision: schedule_revision,
            });
        }
        let row = sqlx::query_as::<_, ContentScheduleRow>(
            "UPDATE content_objects SET publish_at = $3, unpublish_at = $4, \
                    publish_revision = CASE WHEN $3::timestamptz IS NULL THEN NULL ELSE $5 END \
             WHERE org_id = $1 AND id = $2 \
             RETURNING publish_at, unpublish_at, publish_revision, revision, schedule_revision",
        )
        .bind(org_id)
        .bind(id)
        .bind(publish_at)
        .bind(unpublish_at)
        .bind(expected_revision)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(ScheduleWriteResult::Applied(row.into()))
    }

    pub async fn get_schedule(&self, org_id: Uuid, id: Uuid) -> Result<Option<ContentSchedule>> {
        let row = sqlx::query_as::<_, ContentScheduleRow>(
            "SELECT publish_at, unpublish_at, publish_revision, revision, schedule_revision \
             FROM content_objects WHERE org_id = $1 AND id = $2",
        )
        .bind(org_id)
        .bind(id)
        .fetch_optional(&self.org_pool(org_id)?)
        .await?;
        Ok(row.map(Into::into))
    }

    /// Lock each due object before deciding its transition. A scheduled release
    /// captures only its approved revision. An expired withdrawal always wins,
    /// including when both deadlines elapsed between ticks, avoiding a brief leak.
    /// Conflicted publish deadlines remain visible and produce no audit/events.
    ///
    /// Uses the control-plane pool, as before. Separate tenant DB scheduling is
    /// a multi-target follow-up; this local installation uses the shared pool.
    pub async fn run_due_transitions(&self) -> Result<Vec<(Uuid, Uuid, String, bool)>> {
        let mut tx = self.pool.begin().await?;
        let due = sqlx::query_as::<_, DueContentTransition>(
            "SELECT co.org_id, co.id, ct.key AS type_key, co.status = 'published' AS published, \
                    COALESCE(co.publish_at <= now(), false) AS publish_due, \
                    COALESCE(co.unpublish_at <= now(), false) AS unpublish_due, \
                    co.publish_revision, co.revision \
             FROM content_objects co \
             JOIN content_types ct ON ct.id = co.content_type_id AND ct.org_id = co.org_id \
             WHERE co.publish_at <= now() OR co.unpublish_at <= now() \
             ORDER BY co.id FOR UPDATE OF co SKIP LOCKED",
        )
        .fetch_all(&mut *tx)
        .await?;
        let mut out = Vec::new();
        for row in due {
            if row.unpublish_due {
                if row.published {
                    sqlx::query(
                        "UPDATE content_objects SET status = 'draft', updated_at = now(), \
                                publish_at = NULL, unpublish_at = NULL, publish_revision = NULL \
                         WHERE org_id = $1 AND id = $2",
                    )
                    .bind(row.org_id)
                    .bind(row.id)
                    .execute(&mut *tx)
                    .await?;
                    out.push((row.org_id, row.id, row.type_key, false));
                } else {
                    // Already withdrawn: clear expired plans without a fake transition.
                    sqlx::query(
                        "UPDATE content_objects SET publish_at = NULL, unpublish_at = NULL, \
                                publish_revision = NULL WHERE org_id = $1 AND id = $2",
                    )
                    .bind(row.org_id)
                    .bind(row.id)
                    .execute(&mut *tx)
                    .await?;
                }
            } else if row.publish_due && row.publish_revision == Some(row.revision) {
                // The later withdrawal stays scheduled. Same-status publication
                // deliberately refreshes the complete data + channel snapshot.
                sqlx::query(
                    "UPDATE content_objects SET status = 'published', updated_at = now(), \
                            publish_at = NULL, publish_revision = NULL \
                     WHERE org_id = $1 AND id = $2",
                )
                .bind(row.org_id)
                .bind(row.id)
                .execute(&mut *tx)
                .await?;
                out.push((row.org_id, row.id, row.type_key, true));
            }
        }
        tx.commit().await?;
        Ok(out)
    }

    /// Like [`Db::delivery_list`] but includes drafts (preview path).
    pub async fn delivery_list_preview(
        &self,
        org_id: Uuid,
        website_id: Uuid,
        type_key: &str,
    ) -> Result<Vec<(Value, Option<Value>)>> {
        let rows: Vec<(Value, Option<Value>)> = sqlx::query_as(
            "SELECT co.data, cca.overrides \
             FROM content_objects co \
             JOIN content_channel_assignments cca ON cca.content_object_id = co.id \
             JOIN content_types ct ON ct.id = co.content_type_id AND ct.org_id = co.org_id \
             JOIN websites w ON w.id = cca.website_id AND w.org_id = co.org_id \
             WHERE co.org_id = $1 AND w.id = $2 AND ct.key = $3 \
             ORDER BY co.updated_at DESC, co.id",
        )
        .bind(org_id)
        .bind(website_id)
        .bind(type_key)
        .fetch_all(&self.org_pool(org_id)?)
        .await?;
        Ok(rows)
    }
}

// --- Webhooks (v2) ---------------------------------------------------------

#[derive(FromRow)]
struct WebhookRow {
    id: Uuid,
    org_id: Uuid,
    url: String,
    active: bool,
    created_at: DateTime<Utc>,
}

impl From<WebhookRow> for Webhook {
    fn from(r: WebhookRow) -> Self {
        Webhook {
            id: r.id,
            org_id: r.org_id,
            url: r.url,
            active: r.active,
            created_at: r.created_at,
        }
    }
}

impl Db {
    pub async fn create_webhook(&self, org_id: Uuid, url: &str, secret: &str) -> Result<Webhook> {
        let row = sqlx::query_as::<_, WebhookRow>(
            "INSERT INTO webhooks (org_id, url, secret) VALUES ($1, $2, $3) \
             RETURNING id, org_id, url, active, created_at",
        )
        .bind(org_id)
        .bind(url)
        .bind(secret)
        .fetch_one(&self.org_pool(org_id)?)
        .await?;
        Ok(row.into())
    }

    pub async fn list_webhooks(&self, org_id: Uuid) -> Result<Vec<Webhook>> {
        let rows = sqlx::query_as::<_, WebhookRow>(
            "SELECT id, org_id, url, active, created_at FROM webhooks \
             WHERE org_id = $1 ORDER BY created_at",
        )
        .bind(org_id)
        .fetch_all(&self.org_pool(org_id)?)
        .await?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn delete_webhook(&self, org_id: Uuid, id: Uuid) -> Result<bool> {
        let res = sqlx::query("DELETE FROM webhooks WHERE org_id = $1 AND id = $2")
            .bind(org_id)
            .bind(id)
            .execute(&self.org_pool(org_id)?)
            .await?;
        Ok(res.rows_affected() > 0)
    }
}

// --- Webhook outbox (v2 hardening: durable delivery, retry, history, DLQ) ---

/// A pending delivery claimed by the worker (joined with its endpoint).
#[derive(Debug, Clone)]
pub struct DueDelivery {
    pub id: Uuid,
    pub url: String,
    pub secret: String,
    pub event: String,
    pub payload: Value,
    pub attempts: i32,
}

#[derive(FromRow)]
struct WebhookDeliveryRow {
    id: Uuid,
    webhook_id: Uuid,
    event: String,
    status: String,
    attempts: i32,
    response_status: Option<i32>,
    last_error: Option<String>,
    created_at: DateTime<Utc>,
    delivered_at: Option<DateTime<Utc>>,
}

impl From<WebhookDeliveryRow> for WebhookDelivery {
    fn from(r: WebhookDeliveryRow) -> Self {
        WebhookDelivery {
            id: r.id,
            webhook_id: r.webhook_id,
            event: r.event,
            status: r.status,
            attempts: r.attempts,
            response_status: r.response_status,
            last_error: r.last_error,
            created_at: r.created_at,
            delivered_at: r.delivered_at,
        }
    }
}

impl Db {
    /// Persist one pending delivery per active webhook (outbox: persist-first).
    pub async fn enqueue_deliveries(
        &self,
        org_id: Uuid,
        event: &str,
        payload: &Value,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO webhook_deliveries (org_id, webhook_id, event, payload) \
             SELECT $1, id, $2, $3 FROM webhooks WHERE org_id = $1 AND active = true",
        )
        .bind(org_id)
        .bind(event)
        .bind(payload)
        .execute(&self.org_pool(org_id)?)
        .await?;
        Ok(())
    }

    /// Claim due pending deliveries for the worker (control-plane pool, cross-org;
    /// single-worker model, so no row locking needed yet).
    pub async fn claim_due_deliveries(&self, limit: i64) -> Result<Vec<DueDelivery>> {
        let rows: Vec<(Uuid, String, String, String, Value, i32)> = sqlx::query_as(
            "SELECT d.id, w.url, w.secret, d.event, d.payload, d.attempts \
             FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id \
             WHERE d.status = 'pending' AND d.next_attempt_at <= now() \
             ORDER BY d.next_attempt_at LIMIT $1",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(id, url, secret, event, payload, attempts)| DueDelivery {
                id,
                url,
                secret,
                event,
                payload,
                attempts,
            })
            .collect())
    }

    pub async fn mark_delivery_ok(&self, id: Uuid, response_status: i32) -> Result<()> {
        sqlx::query(
            "UPDATE webhook_deliveries SET status = 'delivered', attempts = attempts + 1, \
             response_status = $2, delivered_at = now(), last_error = NULL WHERE id = $1",
        )
        .bind(id)
        .bind(response_status)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Mark a failed attempt: reschedule with backoff, or dead-letter on give-up.
    pub async fn mark_delivery_failed(
        &self,
        id: Uuid,
        response_status: Option<i32>,
        error: &str,
        give_up: bool,
        retry_in_secs: i64,
    ) -> Result<()> {
        if give_up {
            sqlx::query(
                "UPDATE webhook_deliveries SET status = 'failed', attempts = attempts + 1, \
                 response_status = $2, last_error = $3 WHERE id = $1",
            )
            .bind(id)
            .bind(response_status)
            .bind(error)
            .execute(&self.pool)
            .await?;
        } else {
            sqlx::query(
                "UPDATE webhook_deliveries SET attempts = attempts + 1, response_status = $2, \
                 last_error = $3, next_attempt_at = now() + make_interval(secs => $4) WHERE id = $1",
            )
            .bind(id)
            .bind(response_status)
            .bind(error)
            .bind(retry_in_secs as f64)
            .execute(&self.pool)
            .await?;
        }
        Ok(())
    }

    pub async fn list_recent_deliveries(
        &self,
        org_id: Uuid,
        limit: i64,
    ) -> Result<Vec<WebhookDelivery>> {
        let rows = sqlx::query_as::<_, WebhookDeliveryRow>(
            "SELECT id, webhook_id, event, status, attempts, response_status, last_error, \
                    created_at, delivered_at \
             FROM webhook_deliveries WHERE org_id = $1 ORDER BY created_at DESC LIMIT $2",
        )
        .bind(org_id)
        .bind(limit)
        .fetch_all(&self.org_pool(org_id)?)
        .await?;
        Ok(rows.into_iter().map(Into::into).collect())
    }
}

// --- AI workflows (v3) -----------------------------------------------------

#[derive(FromRow)]
struct AiConnectorRow {
    id: Uuid,
    org_id: Uuid,
    name: String,
    provider: String,
    api_key: Option<String>,
    preprompt: Option<String>,
    default_model: Option<String>,
    active: bool,
    created_at: DateTime<Utc>,
}

impl From<AiConnectorRow> for AiConnector {
    fn from(r: AiConnectorRow) -> Self {
        AiConnector {
            id: r.id,
            org_id: r.org_id,
            name: r.name,
            provider: r.provider,
            active: r.active,
            has_key: r.api_key.as_deref().is_some_and(|k| !k.is_empty()),
            preprompt: r.preprompt,
            default_model: r.default_model,
            created_at: r.created_at,
        }
    }
}

#[derive(FromRow)]
struct AiWorkflowRow {
    id: Uuid,
    org_id: Uuid,
    name: String,
    graph: Value,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl From<AiWorkflowRow> for AiWorkflow {
    fn from(r: AiWorkflowRow) -> Self {
        AiWorkflow {
            id: r.id,
            org_id: r.org_id,
            name: r.name,
            graph: r.graph,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

#[derive(FromRow)]
struct AiRunRow {
    id: Uuid,
    workflow_id: Uuid,
    status: String,
    trace: Value,
    error: Option<String>,
    created_at: DateTime<Utc>,
    finished_at: Option<DateTime<Utc>>,
}

impl From<AiRunRow> for AiRun {
    fn from(r: AiRunRow) -> Self {
        AiRun {
            id: r.id,
            workflow_id: r.workflow_id,
            status: r.status,
            trace: r.trace,
            error: r.error,
            created_at: r.created_at,
            finished_at: r.finished_at,
        }
    }
}

/// Runtime detail of a connector for the engine: provider, key, base url,
/// connector-level preprompt, and default model.
pub type ConnectorRuntime = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

impl Db {
    #[allow(clippy::too_many_arguments)]
    pub async fn create_ai_connector(
        &self,
        org_id: Uuid,
        name: &str,
        provider: &str,
        api_key: Option<&str>,
        base_url: Option<&str>,
        preprompt: Option<&str>,
        default_model: Option<&str>,
    ) -> Result<AiConnector> {
        let row = sqlx::query_as::<_, AiConnectorRow>(
            "INSERT INTO ai_connectors (org_id, name, provider, api_key, base_url, preprompt, default_model) \
             VALUES ($1, $2, $3, $4, $5, $6, $7) \
             RETURNING id, org_id, name, provider, api_key, preprompt, default_model, active, created_at",
        )
        .bind(org_id)
        .bind(name)
        .bind(provider)
        .bind(
            api_key
                .map(|value| encrypt_connector_key(&self.connector_encryption_key, value))
                .transpose()?,
        )
        .bind(base_url)
        .bind(preprompt)
        .bind(default_model)
        .fetch_one(&self.org_pool(org_id)?)
        .await?;
        Ok(row.into())
    }

    pub async fn list_ai_connectors(&self, org_id: Uuid) -> Result<Vec<AiConnector>> {
        let rows = sqlx::query_as::<_, AiConnectorRow>(
            "SELECT id, org_id, name, provider, api_key, preprompt, default_model, active, created_at \
             FROM ai_connectors WHERE org_id = $1 ORDER BY created_at",
        )
        .bind(org_id)
        .fetch_all(&self.org_pool(org_id)?)
        .await?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn delete_ai_connector(&self, org_id: Uuid, id: Uuid) -> Result<bool> {
        let res = sqlx::query("DELETE FROM ai_connectors WHERE org_id = $1 AND id = $2")
            .bind(org_id)
            .bind(id)
            .execute(&self.org_pool(org_id)?)
            .await?;
        Ok(res.rows_affected() > 0)
    }

    /// Resolve a connector for execution: provider, api_key, base_url,
    /// preprompt, default_model.
    pub async fn ai_connector_runtime(
        &self,
        org_id: Uuid,
        id: Uuid,
    ) -> Result<Option<ConnectorRuntime>> {
        let row: Option<ConnectorRuntime> = sqlx::query_as(
            "SELECT provider, api_key, base_url, preprompt, default_model \
             FROM ai_connectors WHERE org_id = $1 AND id = $2",
        )
        .bind(org_id)
        .bind(id)
        .fetch_optional(&self.org_pool(org_id)?)
        .await?;
        row.map(|(provider, api_key, base_url, preprompt, default_model)| {
            api_key
                .map(|value| decrypt_connector_key(&self.connector_encryption_key, &value))
                .transpose()
                .map(|key| (provider, key, base_url, preprompt, default_model))
        })
        .transpose()
    }

    /// Upsert a persistent memory entry for a workflow.
    pub async fn ai_memory_store(
        &self,
        org_id: Uuid,
        workflow_id: Uuid,
        key: &str,
        value: &str,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO ai_memory (org_id, workflow_id, key, value) VALUES ($1, $2, $3, $4) \
             ON CONFLICT (org_id, workflow_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        )
        .bind(org_id)
        .bind(workflow_id)
        .bind(key)
        .bind(value)
        .execute(&self.org_pool(org_id)?)
        .await?;
        Ok(())
    }

    /// Read a persistent memory value (None if absent).
    pub async fn ai_memory_recall(
        &self,
        org_id: Uuid,
        workflow_id: Uuid,
        key: &str,
    ) -> Result<Option<String>> {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT value FROM ai_memory WHERE org_id = $1 AND workflow_id = $2 AND key = $3",
        )
        .bind(org_id)
        .bind(workflow_id)
        .bind(key)
        .fetch_optional(&self.org_pool(org_id)?)
        .await?;
        Ok(row.map(|r| r.0))
    }

    /// Forget a persistent memory entry (returns true if one was removed).
    pub async fn ai_memory_forget(
        &self,
        org_id: Uuid,
        workflow_id: Uuid,
        key: &str,
    ) -> Result<bool> {
        let res = sqlx::query(
            "DELETE FROM ai_memory WHERE org_id = $1 AND workflow_id = $2 AND key = $3",
        )
        .bind(org_id)
        .bind(workflow_id)
        .bind(key)
        .execute(&self.org_pool(org_id)?)
        .await?;
        Ok(res.rows_affected() > 0)
    }

    pub async fn create_ai_workflow(
        &self,
        org_id: Uuid,
        name: &str,
        graph: &Value,
    ) -> Result<AiWorkflow> {
        let row = sqlx::query_as::<_, AiWorkflowRow>(
            "INSERT INTO ai_workflows (org_id, name, graph) VALUES ($1, $2, $3) \
             RETURNING id, org_id, name, graph, created_at, updated_at",
        )
        .bind(org_id)
        .bind(name)
        .bind(graph)
        .fetch_one(&self.org_pool(org_id)?)
        .await?;
        Ok(row.into())
    }

    pub async fn update_ai_workflow(
        &self,
        org_id: Uuid,
        id: Uuid,
        name: &str,
        graph: &Value,
    ) -> Result<Option<AiWorkflow>> {
        let row = sqlx::query_as::<_, AiWorkflowRow>(
            "UPDATE ai_workflows SET name = $3, graph = $4, updated_at = now() \
             WHERE org_id = $1 AND id = $2 \
             RETURNING id, org_id, name, graph, created_at, updated_at",
        )
        .bind(org_id)
        .bind(id)
        .bind(name)
        .bind(graph)
        .fetch_optional(&self.org_pool(org_id)?)
        .await?;
        Ok(row.map(Into::into))
    }

    pub async fn list_ai_workflows(&self, org_id: Uuid) -> Result<Vec<AiWorkflow>> {
        let rows = sqlx::query_as::<_, AiWorkflowRow>(
            "SELECT id, org_id, name, graph, created_at, updated_at \
             FROM ai_workflows WHERE org_id = $1 ORDER BY updated_at DESC",
        )
        .bind(org_id)
        .fetch_all(&self.org_pool(org_id)?)
        .await?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn get_ai_workflow(&self, org_id: Uuid, id: Uuid) -> Result<Option<AiWorkflow>> {
        let row = sqlx::query_as::<_, AiWorkflowRow>(
            "SELECT id, org_id, name, graph, created_at, updated_at \
             FROM ai_workflows WHERE org_id = $1 AND id = $2",
        )
        .bind(org_id)
        .bind(id)
        .fetch_optional(&self.org_pool(org_id)?)
        .await?;
        Ok(row.map(Into::into))
    }

    pub async fn delete_ai_workflow(&self, org_id: Uuid, id: Uuid) -> Result<bool> {
        let res = sqlx::query("DELETE FROM ai_workflows WHERE org_id = $1 AND id = $2")
            .bind(org_id)
            .bind(id)
            .execute(&self.org_pool(org_id)?)
            .await?;
        Ok(res.rows_affected() > 0)
    }

    pub async fn create_ai_run(&self, org_id: Uuid, workflow_id: Uuid) -> Result<Uuid> {
        let row: (Uuid,) = sqlx::query_as(
            "INSERT INTO ai_runs (org_id, workflow_id) VALUES ($1, $2) RETURNING id",
        )
        .bind(org_id)
        .bind(workflow_id)
        .fetch_one(&self.org_pool(org_id)?)
        .await?;
        Ok(row.0)
    }

    pub async fn finish_ai_run(
        &self,
        org_id: Uuid,
        id: Uuid,
        status: &str,
        trace: &Value,
        error: Option<&str>,
    ) -> Result<()> {
        sqlx::query(
            "UPDATE ai_runs SET status = $3, trace = $4, error = $5, finished_at = now() \
             WHERE org_id = $1 AND id = $2",
        )
        .bind(org_id)
        .bind(id)
        .bind(status)
        .bind(trace)
        .bind(error)
        .execute(&self.org_pool(org_id)?)
        .await?;
        Ok(())
    }

    pub async fn get_ai_run(&self, org_id: Uuid, id: Uuid) -> Result<Option<AiRun>> {
        let row = sqlx::query_as::<_, AiRunRow>(
            "SELECT id, workflow_id, status, trace, error, created_at, finished_at \
             FROM ai_runs WHERE org_id = $1 AND id = $2",
        )
        .bind(org_id)
        .bind(id)
        .fetch_optional(&self.org_pool(org_id)?)
        .await?;
        Ok(row.map(Into::into))
    }

    pub async fn list_ai_runs(
        &self,
        org_id: Uuid,
        workflow_id: Uuid,
        limit: i64,
    ) -> Result<Vec<AiRun>> {
        let rows = sqlx::query_as::<_, AiRunRow>(
            "SELECT id, workflow_id, status, trace, error, created_at, finished_at \
             FROM ai_runs WHERE org_id = $1 AND workflow_id = $2 ORDER BY created_at DESC LIMIT $3",
        )
        .bind(org_id)
        .bind(workflow_id)
        .bind(limit)
        .fetch_all(&self.org_pool(org_id)?)
        .await?;
        Ok(rows.into_iter().map(Into::into).collect())
    }
}

// --- Dashboard overview (v2) -----------------------------------------------

/// Aggregate counts for an org's dashboard.
#[derive(Debug, Clone, Default)]
pub struct OrgOverview {
    pub content_total: i64,
    pub content_published: i64,
    pub content_types: i64,
    pub websites: i64,
    pub assets: i64,
    pub members: i64,
}

impl Db {
    pub async fn org_overview(&self, org_id: Uuid) -> Result<OrgOverview> {
        let pool = self.org_pool(org_id)?;
        let (content_total, content_published): (i64, i64) = sqlx::query_as(
            "SELECT COUNT(*), COUNT(*) FILTER (WHERE status = 'published') \
             FROM content_objects WHERE org_id = $1",
        )
        .bind(org_id)
        .fetch_one(&pool)
        .await?;
        let content_types: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM content_types WHERE org_id = $1")
                .bind(org_id)
                .fetch_one(&pool)
                .await?;
        let websites: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM websites WHERE org_id = $1")
            .bind(org_id)
            .fetch_one(&pool)
            .await?;
        let assets: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM assets WHERE org_id = $1")
            .bind(org_id)
            .fetch_one(&pool)
            .await?;
        let members: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM memberships WHERE org_id = $1")
            .bind(org_id)
            .fetch_one(&self.pool)
            .await?;
        Ok(OrgOverview {
            content_total,
            content_published,
            content_types: content_types.0,
            websites: websites.0,
            assets: assets.0,
            members: members.0,
        })
    }
}
