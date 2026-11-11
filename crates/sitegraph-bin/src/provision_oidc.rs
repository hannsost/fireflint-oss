//! Explicit operator onboarding. No HTTP route and no lookup by email alone.
use anyhow::{bail, ensure, Context, Result};
use serde::Deserialize;
use sitegraph_api::auth;
use sitegraph_db::Db;
use std::io::Read;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    issuer: String,
    subject: String,
    user_id: Uuid,
    email: String,
    user_name: String,
    org_id: Uuid,
    org_slug: String,
    org_name: String,
}

impl Request {
    fn validate(&self, configured_issuer: &str, production: bool) -> Result<()> {
        let issuer: axum::http::Uri = self.issuer.parse().context("invalid issuer URL")?;
        let https = issuer.scheme_str() == Some("https");
        let loopback = !production
            && issuer.scheme_str() == Some("http")
            && matches!(issuer.host(), Some("127.0.0.1" | "localhost" | "[::1]"));
        ensure!(
            self.issuer == configured_issuer
                && (https || loopback)
                && issuer.host().is_some()
                && !self.issuer.contains(['@', '?', '#', '\\'])
                && self.issuer.len() <= 2048,
            "issuer must exactly match configured OIDC_ISSUER_URL and use HTTPS (loopback only in development)"
        );
        ensure!(
            !self.subject.is_empty()
                && self.subject.len() <= 255
                && !self.subject.chars().any(char::is_control),
            "subject must be a nonempty bounded identifier"
        );
        ensure!(
            !self.user_id.is_nil() && !self.org_id.is_nil(),
            "explicit nonzero user_id and org_id are required"
        );
        let parts: Vec<_> = self.email.split('@').collect();
        ensure!(
            self.email == self.email.trim().to_lowercase()
                && self.email.len() <= 254
                && parts.len() == 2
                && !parts[0].is_empty()
                && parts[1].contains('.')
                && !self
                    .email
                    .chars()
                    .any(|c| c.is_whitespace() || c.is_control()),
            "email must be an explicit normalized account address"
        );
        for name in [&self.user_name, &self.org_name] {
            ensure!(
                !name.is_empty()
                    && name.len() <= 160
                    && *name == name.trim()
                    && !name.chars().any(char::is_control),
                "names must be nonempty, trimmed and at most 160 bytes"
            );
        }
        ensure!(
            !self.org_slug.is_empty()
                && self.org_slug.len() <= 80
                && !self.org_slug.starts_with('-')
                && !self.org_slug.ends_with('-')
                && self
                    .org_slug
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-'),
            "organization slug must contain lowercase letters, digits and inner hyphens"
        );
        Ok(())
    }
}

pub async fn run(db: &Db, production: bool) -> Result<()> {
    let configured = std::env::var("OIDC_ISSUER_URL").context("OIDC_ISSUER_URL is required")?;
    let mut input = Vec::new();
    std::io::stdin()
        .take(16 * 1024 + 1)
        .read_to_end(&mut input)?;
    ensure!(
        input.len() <= 16 * 1024,
        "provisioning input exceeds 16 KiB"
    );
    let request: Request = serde_json::from_slice(&input).context("invalid provisioning JSON")?;
    request.validate(&configured, production)?;
    let created = provision(db, &request).await?;
    // Only stable resource IDs are emitted; no password, tokens or input claims.
    println!(
        "{}",
        serde_json::json!({"user_id":request.user_id,"org_id":request.org_id,"created":created})
    );
    Ok(())
}

async fn provision(db: &Db, r: &Request) -> Result<bool> {
    let mut tx = db.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(713601892)")
        .execute(&mut *tx)
        .await?;
    let users: Vec<(Uuid, String, String, bool)> = sqlx::query_as(
        "SELECT id,email,name,is_platform_admin FROM users WHERE id=$1 OR lower(email)=$2 FOR UPDATE"
    ).bind(r.user_id).bind(&r.email).fetch_all(&mut *tx).await?;
    let user_exists = match users.as_slice() {
        [] => false,
        [(id, email, name, false)]
            if *id == r.user_id && email == &r.email && name == &r.user_name =>
        {
            true
        }
        _ => bail!("user conflict: explicit ID, email and name must match a non-admin account"),
    };
    let identities: Vec<(String, String, Uuid)> = sqlx::query_as(
        "SELECT issuer,subject,user_id FROM oidc_identities WHERE user_id=$1 OR (issuer=$2 AND subject=$3) FOR UPDATE"
    ).bind(r.user_id).bind(&r.issuer).bind(&r.subject).fetch_all(&mut *tx).await?;
    let linked = match identities.as_slice() {
        [] => false,
        [(issuer, subject, user)]
            if issuer == &r.issuer && subject == &r.subject && *user == r.user_id =>
        {
            true
        }
        _ => bail!("identity conflict: existing bindings are never reassigned"),
    };
    let memberships: Vec<(Uuid, String)> =
        sqlx::query_as("SELECT org_id,role FROM memberships WHERE user_id=$1 FOR UPDATE")
            .bind(r.user_id)
            .fetch_all(&mut *tx)
            .await?;
    ensure!(
        memberships
            .iter()
            .all(|(org, role)| *org == r.org_id && role == "owner"),
        "membership conflict: existing tenant access or roles are never changed"
    );
    let orgs: Vec<(Uuid, String, String)> =
        sqlx::query_as("SELECT id,name,slug FROM organizations WHERE id=$1 OR slug=$2 FOR UPDATE")
            .bind(r.org_id)
            .bind(&r.org_slug)
            .fetch_all(&mut *tx)
            .await?;
    if !orgs.is_empty() {
        ensure!(matches!(orgs.as_slice(), [(id, name, slug)] if *id == r.org_id && name == &r.org_name && slug == &r.org_slug)
            && user_exists && linked && memberships.len() == 1,
            "organization conflict: an existing tenant is accepted only as an unchanged completed onboarding");
        tx.commit().await?;
        return Ok(false);
    }
    if !user_exists {
        // This random password is never returned or retained, so a newly created
        // account can sign in only through its explicitly bound SSO identity.
        let hash = auth::hash_password(&format!("{}{}", Uuid::new_v4(), Uuid::new_v4()))?;
        sqlx::query("INSERT INTO users(id,email,name,password_hash,is_platform_admin) VALUES($1,$2,$3,$4,false)")
            .bind(r.user_id).bind(&r.email).bind(&r.user_name).bind(hash).execute(&mut *tx).await?;
    }
    sqlx::query("INSERT INTO organizations(id,name,slug) VALUES($1,$2,$3)")
        .bind(r.org_id)
        .bind(&r.org_name)
        .bind(&r.org_slug)
        .execute(&mut *tx)
        .await?;
    if !linked {
        sqlx::query("INSERT INTO oidc_identities(issuer,subject,user_id) VALUES($1,$2,$3)")
            .bind(&r.issuer)
            .bind(&r.subject)
            .bind(r.user_id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,'owner')")
        .bind(r.org_id)
        .bind(r.user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Request {
        let suffix = Uuid::new_v4();
        Request {
            issuer: "https://identity.example.test/realms/neurofunken".into(),
            subject: format!("subject-{suffix}"),
            user_id: Uuid::new_v4(),
            email: format!("onboard-{suffix}@example.test"),
            user_name: "Fixture owner".into(),
            org_id: Uuid::new_v4(),
            org_slug: format!("onboard-{suffix}"),
            org_name: "Fixture tenant".into(),
        }
    }
    #[test]
    fn provisioning_requires_exact_issuer_and_explicit_bounded_fields() {
        let mut r = request();
        assert!(r.validate(&r.issuer, true).is_ok());
        assert!(r.validate("https://other.example.test", true).is_err());
        r.issuer = "http://127.0.0.1:28180".into();
        assert!(r.validate(&r.issuer, true).is_err());
        assert!(r.validate(&r.issuer, false).is_ok());
        r.subject.clear();
        assert!(r.validate(&r.issuer, false).is_err());
        assert!(serde_json::from_str::<Request>(r#"{"email":"owner@example.test"}"#).is_err());
    }

    #[tokio::test]
    #[ignore = "requires isolated FIRE_FLINT_OIDC_TEST_DATABASE_URL with migrations"]
    async fn explicit_onboarding_is_atomic_idempotent_and_never_takes_over_existing_access() {
        let url = std::env::var("FIRE_FLINT_OIDC_TEST_DATABASE_URL").unwrap();
        assert!(url.starts_with("postgres://fireflint_hub_test:"));
        assert!(url.ends_with("@127.0.0.1:25433/fireflint_hub_test"));
        let db = Db::connect(&url).await.unwrap();
        let mut r = request();
        assert!(provision(&db, &r).await.unwrap());
        let before: (String, bool, i32) = sqlx::query_as(
            "SELECT password_hash,is_platform_admin,session_version FROM users WHERE id=$1",
        )
        .bind(r.user_id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert!(!before.1);
        assert!(!auth::verify_password(&before.0, ""));
        assert!(!provision(&db, &r).await.unwrap());
        let after: (String, bool, i32) = sqlx::query_as(
            "SELECT password_hash,is_platform_admin,session_version FROM users WHERE id=$1",
        )
        .bind(r.user_id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(before, after);
        r.user_id = Uuid::new_v4();
        assert!(provision(&db, &r).await.is_err()); // same email is never a link
        r = request();
        let original_password = auth::hash_password("existing-local-fixture-only").unwrap();
        sqlx::query("INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)")
            .bind(r.user_id)
            .bind(&r.email)
            .bind(&r.user_name)
            .bind(&original_password)
            .execute(&db.pool)
            .await
            .unwrap();
        assert!(provision(&db, &r).await.unwrap());
        let stored: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id=$1")
            .bind(r.user_id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(stored, original_password);
        let original_org = r.org_id;
        r.org_id = Uuid::new_v4();
        r.org_slug = format!("other-{}", Uuid::new_v4());
        assert!(provision(&db, &r).await.is_err()); // foreign membership
        assert!(!sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM organizations WHERE id=$1)"
        )
        .bind(r.org_id)
        .fetch_one(&db.pool)
        .await
        .unwrap());
        r.org_id = original_org;
        sqlx::query("UPDATE memberships SET role='viewer' WHERE user_id=$1")
            .bind(r.user_id)
            .execute(&db.pool)
            .await
            .unwrap();
        assert!(provision(&db, &r).await.is_err()); // no restoration of privileges
        let mut conflict = request();
        conflict.subject = r.subject;
        assert!(provision(&db, &conflict).await.is_err());
        assert!(
            !sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM users WHERE id=$1)")
                .bind(conflict.user_id)
                .fetch_one(&db.pool)
                .await
                .unwrap()
        );
        let occupied = request();
        sqlx::query("INSERT INTO organizations(id,name,slug) VALUES($1,$2,$3)")
            .bind(occupied.org_id)
            .bind(&occupied.org_name)
            .bind(&occupied.org_slug)
            .execute(&db.pool)
            .await
            .unwrap();
        assert!(provision(&db, &occupied).await.is_err()); // never adopts a tenant
        assert!(
            !sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM users WHERE id=$1)")
                .bind(occupied.user_id)
                .fetch_one(&db.pool)
                .await
                .unwrap()
        );
        let admin = request();
        sqlx::query("INSERT INTO users(id,email,name,password_hash,is_platform_admin) VALUES($1,$2,$3,$4,true)")
            .bind(admin.user_id).bind(&admin.email).bind(&admin.user_name).bind(original_password)
            .execute(&db.pool).await.unwrap();
        assert!(provision(&db, &admin).await.is_err()); // never reuses a platform admin
    }
}
