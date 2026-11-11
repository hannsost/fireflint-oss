//! Authentication primitives (WP1.3): password hashing, JWTs, API tokens.
//!
//! Security notes (Whitepaper §19): passwords are argon2-hashed, API tokens are
//! stored only as SHA-256 hashes, and JWTs are short-lived with a separate
//! long-lived refresh token.

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sitegraph_db::Db;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

// Fixed demo identifiers (match seed migrations 0001/0002). Replaced by real
// signup in Phase 2 (WP2.3).
pub const DEMO_ORG_ID: Uuid = Uuid::from_u128(0x0000_0000_0000_0000_0000_0000_0000_0001);
pub const DEMO_USER_ID: Uuid = Uuid::from_u128(0x0000_0000_0000_0000_0000_0000_0000_000A);
/// A non-admin demo user (Editor in the demo org, not a platform admin) so the
/// control-plane authorization (403) can be exercised end to end.
pub const DEMO_EDITOR_USER_ID: Uuid = Uuid::from_u128(0x0000_0000_0000_0000_0000_0000_0000_000B);
const DEMO_PASSWORD: &str = "demo1234";
const DEMO_API_TOKEN: &str = "sg_demo_token";

const ACCESS_TTL_SECS: u64 = 15 * 60;
const REFRESH_TTL_SECS: u64 = 30 * 24 * 60 * 60;

// --- Passwords -------------------------------------------------------------

/// Shared policy for newly assigned passwords; legacy credentials remain valid
/// for login until their owner explicitly replaces them.
pub fn validate_new_password(value: &str) -> Result<(), &'static str> {
    if value.len() > 1024
        || value.chars().count() < 12
        || value.trim() != value
        || value
            .chars()
            .collect::<std::collections::HashSet<_>>()
            .len()
            < 6
    {
        return Err("password must contain at least 12 characters, at most 1024 UTF-8 bytes, no surrounding whitespace, and at least six distinct characters");
    }
    Ok(())
}

pub fn hash_password(password: &str) -> anyhow::Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| anyhow::anyhow!("hash error: {e}"))
}

pub fn verify_password(hash: &str, password: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

// --- JWTs ------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    /// Subject: user id.
    pub sub: Uuid,
    /// "access" | "refresh".
    pub typ: String,
    /// Platform administrator (gates cross-org control-plane views). Defaults
    /// to false so older tokens decode as non-admin.
    #[serde(default)]
    pub pa: bool,
    /// Password/session generation; older tokens belong to generation zero.
    #[serde(default)]
    pub sv: i32,
    /// OIDC-derived sessions are validated against storage and the provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oidc_sid: Option<Uuid>,
    /// Rotation generation for an OIDC refresh credential. Access tokens carry
    /// the same value for diagnostics; only refresh validates it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oidc_rv: Option<i32>,
    /// Expiry (unix seconds).
    pub exp: usize,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn issue(
    secret: &str,
    user_id: Uuid,
    typ: &str,
    pa: bool,
    ttl: u64,
    sv: i32,
) -> anyhow::Result<String> {
    let claims = Claims {
        sub: user_id,
        typ: typ.to_string(),
        pa,
        sv,
        oidc_sid: None,
        oidc_rv: None,
        exp: (now_secs() + ttl) as usize,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(Into::into)
}

pub fn issue_access(secret: &str, user_id: Uuid, platform_admin: bool) -> anyhow::Result<String> {
    issue(
        secret,
        user_id,
        "access",
        platform_admin,
        ACCESS_TTL_SECS,
        0,
    )
}

pub fn issue_refresh(secret: &str, user_id: Uuid, platform_admin: bool) -> anyhow::Result<String> {
    issue(
        secret,
        user_id,
        "refresh",
        platform_admin,
        REFRESH_TTL_SECS,
        0,
    )
}

pub fn issue_access_versioned(
    secret: &str,
    user_id: Uuid,
    platform_admin: bool,
    session_version: i32,
) -> anyhow::Result<String> {
    issue(
        secret,
        user_id,
        "access",
        platform_admin,
        ACCESS_TTL_SECS,
        session_version,
    )
}

pub fn issue_refresh_versioned(
    secret: &str,
    user_id: Uuid,
    platform_admin: bool,
    session_version: i32,
) -> anyhow::Result<String> {
    issue(
        secret,
        user_id,
        "refresh",
        platform_admin,
        REFRESH_TTL_SECS,
        session_version,
    )
}

/// Issue a token bound to one server-side OIDC session and refresh generation.
/// Callers separately cap access by the provider token and refresh by idle/max age.
pub struct OidcTokenBinding {
    pub session_id: Uuid,
    pub refresh_version: i32,
    pub expires_at: usize,
}

pub fn issue_oidc(
    secret: &str,
    user_id: Uuid,
    platform_admin: bool,
    session_version: i32,
    binding: OidcTokenBinding,
    typ: &str,
) -> anyhow::Result<String> {
    let claims = Claims {
        sub: user_id,
        typ: typ.into(),
        pa: platform_admin,
        sv: session_version,
        oidc_sid: Some(binding.session_id),
        oidc_rv: Some(binding.refresh_version),
        exp: binding.expires_at,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(Into::into)
}

const PREVIEW_TTL_SECS: u64 = 30 * 60;

/// A short-lived preview token scoped to an org (carried in `sub`), so draft
/// content can be fetched on the public preview path without a login (v2).
pub fn issue_preview(secret: &str, org_id: Uuid) -> anyhow::Result<String> {
    issue(secret, org_id, "preview", false, PREVIEW_TTL_SECS, 0)
}

pub fn verify(secret: &str, token: &str) -> Option<Claims> {
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .ok()
    .map(|d| d.claims)
}

// --- API tokens ------------------------------------------------------------

/// Generate a new opaque API token (the plaintext is shown to the user once).
pub fn generate_api_token() -> String {
    let mut bytes = [0u8; 24];
    OsRng.fill_bytes(&mut bytes);
    format!("sg_{}", hex::encode(bytes))
}

/// Hash an API token for storage/lookup (SHA-256, hex).
pub fn hash_api_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    hex::encode(digest)
}

// --- Demo bootstrap --------------------------------------------------------

/// Idempotently ensure a demo owner + an org-wide delivery token exist, so the
/// skeleton is usable immediately. Removed once real signup lands (WP2.3).
pub async fn bootstrap_demo(db: &Db) -> anyhow::Result<()> {
    let hash = hash_password(DEMO_PASSWORD)?;
    db.upsert_user(DEMO_USER_ID, "owner@demo.test", "Demo Owner", &hash)
        .await?;
    db.upsert_membership(DEMO_ORG_ID, DEMO_USER_ID, sitegraph_domain::Role::Owner)
        .await?;
    // The demo owner doubles as the platform admin for the control-plane views.
    db.set_platform_admin(DEMO_USER_ID, true).await?;
    // A non-admin editor: member of the org, but no platform-admin claim — so the
    // control-plane views (storage + cluster) return 403 for this user.
    db.upsert_user(
        DEMO_EDITOR_USER_ID,
        "editor@demo.test",
        "Demo Editor",
        &hash,
    )
    .await?;
    db.upsert_membership(
        DEMO_ORG_ID,
        DEMO_EDITOR_USER_ID,
        sitegraph_domain::Role::Editor,
    )
    .await?;
    db.upsert_api_token(
        DEMO_ORG_ID,
        None, // org-wide so the demo can read every channel
        "demo-delivery",
        &hash_api_token(DEMO_API_TOKEN),
    )
    .await?;
    tracing::info!(
        "demo bootstrap ready (login owner@demo.test / {DEMO_PASSWORD}, delivery token {DEMO_API_TOKEN})"
    );
    Ok(())
}

/// Seed the in-memory storage registry with a realistic data-residency picture
/// for the admin UI: the implicit single-pool target plus an example tenant
/// pool pinned to a region and a generic fallback. The default request path
/// still routes through `SinglePoolProvider`; these entries only populate the
/// read view (in production the operator-sync loop fills the registry instead).
pub fn seed_demo_storage(
    registry: &dyn sitegraph_platform_data_residency::StorageRegistry,
) -> anyhow::Result<()> {
    use sitegraph_platform_data_residency::{
        BindingPolicy, BindingSelector, IsolationTopology, StorageTarget, StorageTargetStatus,
    };

    let target = |id: &str,
                  topology: IsolationTopology,
                  region: &str,
                  organization_id: Option<String>| StorageTarget {
        id: id.into(),
        topology,
        region: region.into(),
        status: StorageTargetStatus::Ready,
        endpoint_ref: format!("endpoints/{id}"),
        credential_ref: format!("secrets/{id}"),
        organization_id,
        schema_version: Some("1".into()),
        revision: 1,
    };

    let map = |error: sitegraph_platform_data_residency::DataResidencyError| {
        anyhow::anyhow!(error.to_string())
    };

    registry
        .put_target(StorageTarget {
            endpoint_ref: "default".into(),
            credential_ref: "default".into(),
            ..target("default", IsolationTopology::SharedRow, "eu-central", None)
        })
        .map_err(map)?;
    registry
        .put_target(target(
            "tenant-eu-central",
            IsolationTopology::DatabasePerTenant,
            "eu-central",
            Some(DEMO_ORG_ID.to_string()),
        ))
        .map_err(map)?;
    registry
        .put_target(target(
            "pool-eu-west",
            IsolationTopology::SchemaPerTenant,
            "eu-west",
            None,
        ))
        .map_err(map)?;

    registry
        .put_binding(BindingPolicy {
            id: "demo-org-eu-central".into(),
            selector: BindingSelector {
                organization_id: Some(DEMO_ORG_ID.to_string()),
                ..BindingSelector::default()
            },
            target_id: "tenant-eu-central".into(),
            priority: 10,
            fallback: false,
            active_from: None,
            active_until: None,
            revision: 1,
        })
        .map_err(map)?;
    registry
        .put_binding(BindingPolicy {
            id: "fallback-default".into(),
            selector: BindingSelector::default(),
            target_id: "default".into(),
            priority: 1,
            fallback: true,
            active_from: None,
            active_until: None,
            revision: 1,
        })
        .map_err(map)?;

    Ok(())
}
