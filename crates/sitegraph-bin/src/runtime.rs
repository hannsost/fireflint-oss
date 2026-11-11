//! Explicit production configuration and operator-only account lifecycle.
use anyhow::{bail, Context, Result};
use sitegraph_api::auth;
use sitegraph_db::Db;
use std::{env, path::Path};
use uuid::Uuid;

pub const DEV_SECRET: &str = "dev-insecure-secret-change-me";

pub struct Config {
    pub production: bool,
    pub jwt_secret: String,
    pub allowed_origins: Vec<String>,
}

impl Config {
    pub fn read() -> Result<Self> {
        let production = match env::var("APP_ENV").as_deref().unwrap_or("development") {
            "production" => true,
            "development" => false,
            _ => bail!("APP_ENV must be development or production"),
        };
        let jwt_secret = env::var("JWT_SECRET").unwrap_or_else(|_| DEV_SECRET.into());
        let allowed_origins: Vec<_> = env::var("CORS_ALLOWED_ORIGINS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
            .collect();
        if production {
            strong_secret(&jwt_secret, "JWT_SECRET")?;
            let encryption_key = required("AI_CONNECTOR_ENCRYPTION_KEY")?;
            strong_secret(&encryption_key, "AI_CONNECTOR_ENCRYPTION_KEY")?;
            if encryption_key == jwt_secret {
                bail!("JWT_SECRET and AI_CONNECTOR_ENCRYPTION_KEY must be distinct");
            }
            if allowed_origins.is_empty() || allowed_origins.iter().any(|v| !https_origin(v)) {
                bail!("production requires explicit HTTPS origins in CORS_ALLOWED_ORIGINS (no paths, wildcards or credentials)");
            }
            if env::var("WEBHOOK_ALLOW_PRIVATE").as_deref() == Ok("true") {
                bail!("WEBHOOK_ALLOW_PRIVATE is development-only");
            }
        }
        Ok(Self {
            production,
            jwt_secret,
            allowed_origins,
        })
    }
}

fn https_origin(value: &str) -> bool {
    let Some(authority) = value.strip_prefix("https://") else {
        return false;
    };
    if authority.is_empty()
        || authority.contains(['/', '?', '#', '@', '*', '\\'])
        || authority.chars().any(char::is_whitespace)
    {
        return false;
    }
    // HTTP authority parsing rejects malformed ports/hosts and CRLF.
    authority.parse::<axum::http::uri::Authority>().is_ok()
}

fn strong_secret(value: &str, name: &str) -> Result<()> {
    if value.len() < 32
        || value.len() > 4096
        || value == DEV_SECRET
        || value.contains("change-me")
        || value.contains("development-only")
        || value
            .chars()
            .collect::<std::collections::HashSet<_>>()
            .len()
            < 10
    {
        bail!("{name} must be an independent random secret of at least 32 characters");
    }
    Ok(())
}

fn required(name: &str) -> Result<String> {
    env::var(name).ok().filter(|v| !v.trim().is_empty())
        .with_context(|| format!("{name} must be set; use a mounted Secret/environment, never command-line password arguments"))
}

fn email(value: String) -> Result<String> {
    let value = value.trim().to_lowercase();
    let parts: Vec<_> = value.split('@').collect();
    if value.len() > 254
        || parts.len() != 2
        || parts[0].is_empty()
        || !parts[1].contains('.')
        || value.chars().any(char::is_whitespace)
    {
        bail!("account email is invalid");
    }
    Ok(value)
}

fn password(value: &str) -> Result<()> {
    auth::validate_new_password(value).map_err(anyhow::Error::msg)
}

pub async fn reject_demo_accounts(db: &Db) -> Result<()> {
    let unsafe_demo: (bool,) = sqlx::query_as(
        "SELECT EXISTS(SELECT 1 FROM users WHERE id IN ($1, $2) OR lower(email) IN ('owner@demo.test','editor@demo.test')) OR EXISTS(SELECT 1 FROM api_tokens WHERE token_hash = $3)"
    ).bind(auth::DEMO_USER_ID).bind(auth::DEMO_EDITOR_USER_ID)
        .bind(auth::hash_api_token("sg_demo_token")).fetch_one(&db.pool).await?;
    if unsafe_demo.0 {
        bail!("production refuses a database containing known demo accounts/delivery credentials; migrate customer data to a clean production installation or remove demo credentials explicitly after backup");
    }
    Ok(())
}

pub async fn bootstrap_admin(db: &Db) -> Result<()> {
    let email = email(required("BOOTSTRAP_ADMIN_EMAIL")?)?;
    let secret = required("BOOTSTRAP_ADMIN_PASSWORD")?;
    password(&secret)?;
    let name = required("BOOTSTRAP_ADMIN_ORG_NAME")?;
    let slug = required("BOOTSTRAP_ADMIN_ORG_SLUG")?;
    if name.len() > 160
        || slug.is_empty()
        || slug.len() > 80
        || slug.starts_with('-')
        || slug.ends_with('-')
        || !slug
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    {
        bail!("organization name must be at most 160 bytes; slug must be lowercase letters, digits and inner hyphens, at most 80 bytes");
    }
    let mut tx = db.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(713601891)")
        .execute(&mut *tx)
        .await?;
    let existing: Option<(Uuid, Uuid)> =
        sqlx::query_as("SELECT admin_id, org_id FROM installation_bootstrap WHERE singleton")
            .fetch_optional(&mut *tx)
            .await?;
    if let Some((admin_id, org_id)) = existing {
        let same: (bool,) = sqlx::query_as("SELECT EXISTS(SELECT 1 FROM users u JOIN memberships m ON m.user_id=u.id JOIN organizations o ON o.id=m.org_id WHERE u.id=$1 AND o.id=$2 AND lower(u.email)=$3 AND o.slug=$4 AND u.is_platform_admin AND m.role='owner')")
            .bind(admin_id).bind(org_id).bind(&email).bind(&slug).fetch_one(&mut *tx).await?;
        if !same.0 {
            bail!("installation was bootstrapped already; bootstrap will not recreate accounts, change identity or restore privileges");
        }
        tx.commit().await?;
        tracing::info!("installation already bootstrapped; password and roles unchanged");
        return Ok(());
    }
    let occupied: (bool,) = sqlx::query_as("SELECT EXISTS(SELECT 1 FROM users WHERE is_platform_admin OR lower(email)=$1) OR EXISTS(SELECT 1 FROM organizations WHERE slug=$2)")
        .bind(&email).bind(&slug).fetch_one(&mut *tx).await?;
    if occupied.0 {
        bail!("bootstrap requires a fresh installation and unused account/workspace; existing accounts are never promoted or reset");
    }
    let hash = auth::hash_password(&secret)?;
    let admin_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users(id,email,name,password_hash,is_platform_admin) VALUES($1,$2,$3,$4,true)",
    )
    .bind(admin_id)
    .bind(&email)
    .bind("Administrator")
    .bind(hash)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO organizations(id,name,slug) VALUES($1,$2,$3)")
        .bind(org_id)
        .bind(name.trim())
        .bind(&slug)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,'owner')")
        .bind(org_id)
        .bind(admin_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO installation_bootstrap(singleton,admin_id,org_id) VALUES(true,$1,$2)")
        .bind(admin_id)
        .bind(org_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    tracing::info!("initial administrator and private workspace created; remove the bootstrap Secret after verifying login");
    Ok(())
}

pub async fn reset_password(db: &Db) -> Result<()> {
    let email = email(required("RESET_ACCOUNT_EMAIL")?)?;
    let secret = required("RESET_ACCOUNT_PASSWORD")?;
    password(&secret)?;
    let hash = auth::hash_password(&secret)?;
    if !db.reset_password_and_revoke(&email, &hash).await? {
        bail!("password reset requires an existing account");
    }
    tracing::info!("password replaced; all previous access and refresh sessions revoked");
    Ok(())
}

pub async fn check_assets(path: &str) -> Result<()> {
    let path = Path::new(path);
    tokio::fs::create_dir_all(path)
        .await
        .context("asset storage is not writable")?;
    let check = path.join(format!(".fireflint-write-check-{}", Uuid::new_v4()));
    let file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&check)
        .await
        .context("asset storage is not writable")?;
    file.sync_all().await?;
    drop(file);
    tokio::fs::remove_file(check).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn production_origins_are_explicit_https_authorities() {
        assert!(https_origin("https://cms.example.com"));
        assert!(https_origin("https://cms.example.com:8443"));
        for value in [
            "*",
            "http://cms.example.com",
            "https://",
            "https://a.test/path",
            "https://user@a.test",
            "https://*.example.com",
            "https://a.test\r\nX: y",
            "https://a.test?x=1",
        ] {
            assert!(!https_origin(value), "{value}");
        }
    }
    #[test]
    fn account_input_and_secret_policy_reject_unsafe_defaults() {
        assert!(strong_secret(DEV_SECRET, "test").is_err());
        assert!(strong_secret(&"a".repeat(64), "test").is_err());
        assert!(password("demo1234").is_err());
        assert!(password("test-only-Account-password-2026").is_ok());
        assert_eq!(
            email(" OWNER@Example.Test ".into()).unwrap(),
            "owner@example.test"
        );
        assert!(email("owner@@example.test".into()).is_err());
    }
}
