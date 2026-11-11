//! Global identity/session storage; organization membership is never written here.
use crate::{decrypt_connector_key, encrypt_connector_key, Db};
use anyhow::Result;
use chrono::{DateTime, Utc};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(FromRow)]
pub struct OidcFlow {
    pub state_hash: String,
    pub browser_hash: String,
    pub issuer: String,
    pub nonce_hash: String,
    /// Plain only in process memory; encrypted before persistence.
    pub verifier_ciphertext: String,
    pub user_id: Option<Uuid>,
    pub session_version: Option<i32>,
    pub expires_at: DateTime<Utc>,
}

#[derive(FromRow)]
pub struct OidcSession {
    pub id: Uuid,
    pub user_id: Uuid,
    pub issuer: String,
    pub subject: String,
    pub provider_sid: Option<String>,
    pub session_version: i32,
    /// Plain only in process memory; encrypted before persistence.
    pub access_ciphertext: String,
    pub refresh_ciphertext: Option<String>,
    pub refresh_version: i32,
    pub expires_at: DateTime<Utc>,
}

pub enum OidcRefreshClaim {
    Claimed { session: OidcSession, nonce: Uuid },
    Busy,
    Invalid,
}

impl Db {
    pub async fn oidc_create_flow(&self, flow: &OidcFlow) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        // Bound anonymous state storage even when many starts arrive together.
        sqlx::query("SELECT pg_advisory_xact_lock(734410021)")
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM oidc_flows WHERE expires_at <= now()")
            .execute(&mut *tx)
            .await?;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM oidc_flows")
            .fetch_one(&mut *tx)
            .await?;
        if count >= 1000 {
            return Ok(false);
        }
        let encrypted =
            encrypt_connector_key(&self.connector_encryption_key, &flow.verifier_ciphertext)?;
        sqlx::query("INSERT INTO oidc_flows (state_hash,browser_hash,issuer,nonce_hash,verifier_ciphertext,user_id,session_version,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)")
            .bind(&flow.state_hash).bind(&flow.browser_hash).bind(&flow.issuer)
            .bind(&flow.nonce_hash).bind(encrypted).bind(flow.user_id)
            .bind(flow.session_version).bind(flow.expires_at).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(true)
    }

    /// Atomically consume once, only for the originating browser and issuer.
    pub async fn oidc_consume_flow(
        &self,
        state_hash: &str,
        browser_hash: &str,
        issuer: &str,
    ) -> Result<Option<OidcFlow>> {
        let row = sqlx::query_as::<_, OidcFlow>("DELETE FROM oidc_flows WHERE state_hash=$1 AND browser_hash=$2 AND issuer=$3 AND expires_at>now() RETURNING *")
            .bind(state_hash).bind(browser_hash).bind(issuer).fetch_optional(&self.pool).await?;
        row.map(|mut row| {
            row.verifier_ciphertext =
                decrypt_connector_key(&self.connector_encryption_key, &row.verifier_ciphertext)?;
            Ok(row)
        })
        .transpose()
    }

    pub async fn oidc_identity_user(&self, issuer: &str, subject: &str) -> Result<Option<Uuid>> {
        Ok(
            sqlx::query_scalar(
                "SELECT user_id FROM oidc_identities WHERE issuer=$1 AND subject=$2",
            )
            .bind(issuer)
            .bind(subject)
            .fetch_optional(&self.pool)
            .await?,
        )
    }

    pub async fn oidc_is_linked(&self, user_id: Uuid, issuer: &str) -> Result<bool> {
        Ok(sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM oidc_identities WHERE user_id=$1 AND issuer=$2)",
        )
        .bind(user_id)
        .bind(issuer)
        .fetch_one(&self.pool)
        .await?)
    }

    pub async fn oidc_link(
        &self,
        user_id: Uuid,
        session_version: i32,
        issuer: &str,
        subject: &str,
    ) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        let current: Option<i32> =
            sqlx::query_scalar("SELECT session_version FROM users WHERE id=$1 FOR UPDATE")
                .bind(user_id)
                .fetch_optional(&mut *tx)
                .await?;
        if current != Some(session_version) {
            return Ok(false);
        }
        sqlx::query("INSERT INTO oidc_identities (issuer,subject,user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING")
            .bind(issuer).bind(subject).bind(user_id).execute(&mut *tx).await?;
        let linked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM oidc_identities WHERE issuer=$1 AND subject=$2 AND user_id=$3)")
            .bind(issuer).bind(subject).bind(user_id).fetch_one(&mut *tx).await?;
        tx.commit().await?;
        Ok(linked)
    }

    /// Serializes with backchannel logout so an in-flight exchange cannot revive
    /// the provider session after a signed logout notification was accepted.
    pub async fn oidc_create_session(&self, session: &OidcSession, issued_at: i64) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,734410022))")
            .bind(&session.issuer)
            .execute(&mut *tx)
            .await?;
        let current: Option<i32> =
            sqlx::query_scalar("SELECT session_version FROM users WHERE id=$1 FOR UPDATE")
                .bind(session.user_id)
                .fetch_optional(&mut *tx)
                .await?;
        if current != Some(session.session_version) {
            return Ok(false);
        }
        let linked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM oidc_identities WHERE issuer=$1 AND subject=$2 AND user_id=$3)")
            .bind(&session.issuer).bind(&session.subject).bind(session.user_id).fetch_one(&mut *tx).await?;
        let logged_out: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM oidc_logout_events WHERE issuer=$1 AND issued_at >= $4 AND ((provider_sid IS NOT NULL AND provider_sid=$2 AND (subject IS NULL OR subject=$3)) OR (provider_sid IS NULL AND subject=$3)))")
            .bind(&session.issuer).bind(&session.provider_sid).bind(&session.subject).bind(issued_at).fetch_one(&mut *tx).await?;
        if !linked || logged_out {
            return Ok(false);
        }
        let access =
            encrypt_connector_key(&self.connector_encryption_key, &session.access_ciphertext)?;
        let refresh = session
            .refresh_ciphertext
            .as_ref()
            .map(|value| encrypt_connector_key(&self.connector_encryption_key, value))
            .transpose()?;
        sqlx::query("DELETE FROM oidc_sessions WHERE expires_at < now() - interval '1 day'")
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO oidc_sessions (id,user_id,issuer,subject,provider_sid,session_version,access_ciphertext,refresh_ciphertext,refresh_version,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
            .bind(session.id).bind(session.user_id).bind(&session.issuer).bind(&session.subject)
            .bind(&session.provider_sid).bind(session.session_version).bind(access).bind(refresh)
            .bind(session.refresh_version).bind(session.expires_at).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(true)
    }

    pub async fn oidc_session(
        &self,
        id: Uuid,
        user_id: Uuid,
        version: i32,
    ) -> Result<Option<OidcSession>> {
        let row = sqlx::query_as::<_, OidcSession>("SELECT * FROM oidc_sessions WHERE id=$1 AND user_id=$2 AND session_version=$3 AND revoked_at IS NULL AND expires_at>now()")
            .bind(id).bind(user_id).bind(version).fetch_optional(&self.pool).await?;
        row.map(|mut row| {
            row.access_ciphertext =
                decrypt_connector_key(&self.connector_encryption_key, &row.access_ciphertext)?;
            row.refresh_ciphertext = row
                .refresh_ciphertext
                .as_ref()
                .map(|value| decrypt_connector_key(&self.connector_encryption_key, value))
                .transpose()?;
            Ok(row)
        })
        .transpose()
    }

    pub async fn oidc_revoke_session(&self, id: Uuid) -> Result<()> {
        sqlx::query("UPDATE oidc_sessions SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Atomically reserves the current provider refresh token. Keycloak may
    /// invalidate it on first use, so only one worker may take it to the token
    /// endpoint. A stale claim can be recovered after one minute; callers must
    /// revoke locally after every ambiguous exchange result.
    pub async fn oidc_claim_refresh(
        &self,
        id: Uuid,
        user_id: Uuid,
        session_version: i32,
        refresh_version: i32,
    ) -> Result<OidcRefreshClaim> {
        let nonce = Uuid::new_v4();
        let row = sqlx::query_as::<_, OidcSession>(
            "UPDATE oidc_sessions SET refresh_nonce=$5, refresh_started_at=now() \
             WHERE id=$1 AND user_id=$2 AND session_version=$3 AND refresh_version=$4 \
               AND revoked_at IS NULL AND expires_at>now() AND refresh_ciphertext IS NOT NULL \
               AND (refresh_nonce IS NULL OR refresh_started_at < now() - interval '1 minute') \
             RETURNING id,user_id,issuer,subject,provider_sid,session_version,access_ciphertext,refresh_ciphertext,refresh_version,expires_at",
        )
        .bind(id)
        .bind(user_id)
        .bind(session_version)
        .bind(refresh_version)
        .bind(nonce)
        .fetch_optional(&self.pool)
        .await?;
        if let Some(mut session) = row {
            session.access_ciphertext =
                decrypt_connector_key(&self.connector_encryption_key, &session.access_ciphertext)?;
            session.refresh_ciphertext = session
                .refresh_ciphertext
                .as_ref()
                .map(|value| decrypt_connector_key(&self.connector_encryption_key, value))
                .transpose()?;
            return Ok(OidcRefreshClaim::Claimed { session, nonce });
        }
        let busy: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM oidc_sessions WHERE id=$1 AND user_id=$2 \
             AND session_version=$3 AND refresh_version=$4 AND revoked_at IS NULL \
             AND expires_at>now() AND refresh_ciphertext IS NOT NULL \
             AND refresh_nonce IS NOT NULL AND refresh_started_at >= now() - interval '1 minute')",
        )
        .bind(id)
        .bind(user_id)
        .bind(session_version)
        .bind(refresh_version)
        .fetch_one(&self.pool)
        .await?;
        Ok(if busy {
            OidcRefreshClaim::Busy
        } else {
            OidcRefreshClaim::Invalid
        })
    }

    /// Commits a rotated provider token pair only if the same claim is still
    /// current and neither local nor backchannel logout won the race.
    pub async fn oidc_complete_refresh(
        &self,
        claimed: &OidcSession,
        nonce: Uuid,
        access_token: &str,
        refresh_token: &str,
    ) -> Result<Option<i32>> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,734410022))")
            .bind(&claimed.issuer)
            .execute(&mut *tx)
            .await?;
        let current_user_version: Option<i32> =
            sqlx::query_scalar("SELECT session_version FROM users WHERE id=$1 FOR UPDATE")
                .bind(claimed.user_id)
                .fetch_optional(&mut *tx)
                .await?;
        if current_user_version != Some(claimed.session_version) {
            return Ok(None);
        }
        let valid = sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM oidc_sessions WHERE id=$1 AND user_id=$2 \
             AND issuer=$3 AND subject=$4 AND provider_sid IS NOT DISTINCT FROM $5 \
             AND session_version=$6 AND refresh_version=$7 AND refresh_nonce=$8 \
             AND revoked_at IS NULL AND expires_at>now() FOR UPDATE",
        )
        .bind(claimed.id)
        .bind(claimed.user_id)
        .bind(&claimed.issuer)
        .bind(&claimed.subject)
        .bind(&claimed.provider_sid)
        .bind(claimed.session_version)
        .bind(claimed.refresh_version)
        .bind(nonce)
        .fetch_optional(&mut *tx)
        .await?;
        if valid.is_none() {
            return Ok(None);
        }
        let access = encrypt_connector_key(&self.connector_encryption_key, access_token)?;
        let refresh = encrypt_connector_key(&self.connector_encryption_key, refresh_token)?;
        let next_version: i32 = sqlx::query_scalar(
            "UPDATE oidc_sessions SET access_ciphertext=$2, refresh_ciphertext=$3, \
             refresh_version=refresh_version+1, refresh_nonce=NULL, refresh_started_at=NULL \
             WHERE id=$1 AND refresh_nonce=$4 AND revoked_at IS NULL \
             RETURNING refresh_version",
        )
        .bind(claimed.id)
        .bind(access)
        .bind(refresh)
        .bind(nonce)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(Some(next_version))
    }

    /// All local JWTs are revoked before any provider network request is made.
    /// Optional unlink is atomic with revocation; memberships are untouched.
    pub async fn oidc_logout_user(&self, user_id: Uuid, unlink_issuer: Option<&str>) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE users SET session_version=session_version+1 WHERE id=$1")
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "UPDATE oidc_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
        )
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM oidc_flows WHERE user_id=$1")
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        if let Some(issuer) = unlink_issuer {
            sqlx::query("DELETE FROM oidc_identities WHERE user_id=$1 AND issuer=$2")
                .bind(user_id)
                .bind(issuer)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn oidc_backchannel_logout(
        &self,
        issuer: &str,
        jti: &str,
        subject: Option<&str>,
        sid: Option<&str>,
        issued_at: i64,
    ) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,734410022))")
            .bind(issuer)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM oidc_logout_events WHERE received_at < now() - interval '1 day'")
            .execute(&mut *tx)
            .await?;
        let inserted = sqlx::query("INSERT INTO oidc_logout_events (issuer,jti,subject,provider_sid,issued_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING")
            .bind(issuer).bind(jti).bind(subject).bind(sid).bind(issued_at).execute(&mut *tx).await?.rows_affected();
        if inserted == 0 {
            return Ok(false);
        }
        sqlx::query("UPDATE oidc_sessions SET revoked_at=now() WHERE issuer=$1 AND revoked_at IS NULL AND (($2::text IS NOT NULL AND provider_sid=$2 AND ($3::text IS NULL OR subject=$3)) OR ($2::text IS NULL AND subject=$3))")
            .bind(issuer).bind(sid).bind(subject).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "requires isolated FIRE_FLINT_OIDC_TEST_DATABASE_URL with migrations through 0030 applied"]
    async fn oidc_storage_encrypts_proofs_consumes_once_and_serializes_logout() {
        let url = std::env::var("FIRE_FLINT_OIDC_TEST_DATABASE_URL")
            .expect("explicit isolated OIDC DB required");
        assert!(url.ends_with("/fireflint_hub_test"));
        assert!(url.contains("@127.0.0.1:25433/") || url.contains("@localhost:25433/"));
        let db = Db::connect(&url).await.unwrap();
        let suffix = Uuid::new_v4();
        let user = db
            .create_user(
                &format!("oidc-storage-{suffix}@example.test"),
                "OIDC storage",
                "not-a-usable-password-hash",
            )
            .await
            .unwrap();
        let issuer = format!("https://oidc-{suffix}.example.test");
        let mut flow = OidcFlow {
            state_hash: format!("state-{suffix}"),
            browser_hash: format!("browser-{suffix}"),
            issuer: issuer.clone(),
            nonce_hash: "hashed-nonce".into(),
            verifier_ciphertext: "plain-pkce-verifier".into(),
            user_id: Some(user),
            session_version: Some(0),
            expires_at: Utc::now() + chrono::Duration::minutes(5),
        };
        assert!(db.oidc_create_flow(&flow).await.unwrap());
        let encrypted: String =
            sqlx::query_scalar("SELECT verifier_ciphertext FROM oidc_flows WHERE state_hash=$1")
                .bind(&flow.state_hash)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert!(encrypted.starts_with("v1:"));
        assert!(!encrypted.contains("plain-pkce-verifier"));
        assert!(db
            .oidc_consume_flow(&flow.state_hash, "wrong-browser", &issuer)
            .await
            .unwrap()
            .is_none());
        let (first, second) = tokio::join!(
            db.oidc_consume_flow(&flow.state_hash, &flow.browser_hash, &issuer),
            db.oidc_consume_flow(&flow.state_hash, &flow.browser_hash, &issuer)
        );
        let winners: Vec<_> = [first.unwrap(), second.unwrap()]
            .into_iter()
            .flatten()
            .collect();
        assert_eq!(winners.len(), 1);
        assert_eq!(winners[0].verifier_ciphertext, "plain-pkce-verifier");
        flow.state_hash = format!("expired-{suffix}");
        flow.expires_at = Utc::now() - chrono::Duration::seconds(1);
        assert!(db.oidc_create_flow(&flow).await.unwrap());
        assert!(db
            .oidc_consume_flow(&flow.state_hash, &flow.browser_hash, &issuer)
            .await
            .unwrap()
            .is_none());
        assert!(!db.oidc_link(user, 1, &issuer, "subject").await.unwrap());
        assert!(db.oidc_link(user, 0, &issuer, "subject").await.unwrap());
        let session = OidcSession {
            id: Uuid::new_v4(),
            user_id: user,
            issuer: issuer.clone(),
            subject: "subject".into(),
            provider_sid: Some("provider-session".into()),
            session_version: 0,
            access_ciphertext: "plain-access".into(),
            refresh_ciphertext: Some("plain-refresh".into()),
            refresh_version: 0,
            expires_at: Utc::now() + chrono::Duration::minutes(5),
        };
        let iat = Utc::now().timestamp();
        assert!(db.oidc_create_session(&session, iat).await.unwrap());
        let raw: (String, String) = sqlx::query_as(
            "SELECT access_ciphertext,refresh_ciphertext FROM oidc_sessions WHERE id=$1",
        )
        .bind(session.id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert!(raw.0.starts_with("v1:") && raw.1.starts_with("v1:"));
        assert_ne!(raw.0, session.access_ciphertext);
        assert_ne!(raw.1, "plain-refresh");
        assert_eq!(
            db.oidc_session(session.id, user, 0)
                .await
                .unwrap()
                .unwrap()
                .access_ciphertext,
            "plain-access"
        );
        let (first, second) = tokio::join!(
            db.oidc_claim_refresh(session.id, user, 0, 0),
            db.oidc_claim_refresh(session.id, user, 0, 0)
        );
        let mut claimed = None;
        let mut busy = 0;
        for result in [first.unwrap(), second.unwrap()] {
            match result {
                OidcRefreshClaim::Claimed { session, nonce } => {
                    assert!(claimed.replace((session, nonce)).is_none());
                }
                OidcRefreshClaim::Busy => busy += 1,
                OidcRefreshClaim::Invalid => panic!("current refresh unexpectedly invalid"),
            }
        }
        assert_eq!(busy, 1);
        let (claimed, nonce) = claimed.unwrap();
        assert_eq!(claimed.refresh_ciphertext.as_deref(), Some("plain-refresh"));
        assert_eq!(
            db.oidc_complete_refresh(&claimed, nonce, "rotated-access", "rotated-refresh")
                .await
                .unwrap(),
            Some(1)
        );
        let rotated = db.oidc_session(session.id, user, 0).await.unwrap().unwrap();
        assert_eq!(rotated.access_ciphertext, "rotated-access");
        assert_eq!(
            rotated.refresh_ciphertext.as_deref(),
            Some("rotated-refresh")
        );
        assert_eq!(rotated.refresh_version, 1);
        assert!(matches!(
            db.oidc_claim_refresh(session.id, user, 0, 0).await.unwrap(),
            OidcRefreshClaim::Invalid
        ));
        assert!(db
            .oidc_backchannel_logout(
                &issuer,
                "event",
                Some("subject"),
                Some("provider-session"),
                iat
            )
            .await
            .unwrap());
        assert!(!db
            .oidc_backchannel_logout(
                &issuer,
                "event",
                Some("subject"),
                Some("provider-session"),
                iat
            )
            .await
            .unwrap());
        assert!(db
            .oidc_session(session.id, user, 0)
            .await
            .unwrap()
            .is_none());
        let mut racing = session;
        racing.id = Uuid::new_v4();
        assert!(!db.oidc_create_session(&racing, iat).await.unwrap());
        racing.provider_sid = Some("fresh-session".into());
        assert!(db.oidc_create_session(&racing, iat).await.unwrap());
        db.oidc_logout_user(user, Some(&issuer)).await.unwrap();
        assert_eq!(db.user_session(user).await.unwrap().unwrap().0, 1);
        assert!(!db.oidc_is_linked(user, &issuer).await.unwrap());
        assert!(db.oidc_session(racing.id, user, 0).await.unwrap().is_none());
        sqlx::query("DELETE FROM oidc_logout_events WHERE issuer=$1")
            .bind(&issuer)
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM users WHERE id=$1")
            .bind(user)
            .execute(&db.pool)
            .await
            .unwrap();
    }
}
