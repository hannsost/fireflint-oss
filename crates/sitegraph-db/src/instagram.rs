//! Organization-bound OAuth grants and immutable publication reservations.
mod unified;
use crate::{decrypt_connector_key, encrypt_connector_key, Db};
use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use sqlx::FromRow;
pub use unified::PendingGrant;
use uuid::Uuid;

#[derive(FromRow)]
pub struct Flow {
    pub state_hash: String,
    pub browser_hash: String,
    pub org_id: Uuid,
    pub user_id: Uuid,
    pub session_version: i32,
    pub app_id: String,
    pub login_mode: String,
    pub config_id: Option<String>,
    pub expected_revision: i64,
    pub expires_at: DateTime<Utc>,
}

// Deliberately no Debug/Serialize: the decrypted token must never be exposed.
#[derive(FromRow)]
pub struct Connection {
    pub org_id: Uuid,
    pub id: Uuid,
    pub instagram_id: String,
    pub app_id: String,
    pub authorized_at: DateTime<Utc>,
    pub username: String,
    pub active: bool,
    pub token_ciphertext: String,
    pub scopes: Vec<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub revision: i64,
    pub login_mode: String,
    pub config_id: Option<String>,
    pub client_business_id: Option<String>,
    pub provider_subject: String,
    pub token_kind: String,
    pub last_verified_at: DateTime<Utc>,
    pub needs_revalidation: bool,
}

#[derive(FromRow, Serialize)]
pub struct Publication {
    pub id: Uuid,
    pub org_id: Uuid,
    pub connection_id: Uuid,
    pub instagram_id: String,
    pub content_id: Uuid,
    pub content_revision: i64,
    pub website_id: Uuid,
    pub payload: Value,
    pub state: String,
    pub revision: i64,
    pub container_id: Option<String>,
    pub media_id: Option<String>,
    pub error_code: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub enum Reservation {
    Created(Publication),
    Existing(Publication),
    Conflict,
    SourceChanged,
}

impl Db {
    pub async fn instagram_flow_create(&self, f: &Flow) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(734410025)")
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM instagram_flows WHERE expires_at <= now()")
            .execute(&mut *tx)
            .await?;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM instagram_flows")
            .fetch_one(&mut *tx)
            .await?;
        if count >= 1000 {
            return Ok(false);
        }
        sqlx::query("INSERT INTO instagram_flows(state_hash,browser_hash,org_id,user_id,session_version,app_id,expected_revision,expires_at,login_mode,config_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
            .bind(&f.state_hash).bind(&f.browser_hash).bind(f.org_id).bind(f.user_id).bind(f.session_version)
            .bind(&f.app_id).bind(f.expected_revision).bind(f.expires_at).bind(&f.login_mode).bind(&f.config_id).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(true)
    }

    pub async fn instagram_flow_consume(
        &self,
        state: &str,
        browser: &str,
        app: &str,
    ) -> Result<Option<Flow>> {
        Ok(sqlx::query_as("DELETE FROM instagram_flows WHERE state_hash=$1 AND browser_hash=$2 AND app_id=$3 AND expires_at>now() RETURNING *")
            .bind(state).bind(browser).bind(app).fetch_optional(&self.pool).await?)
    }

    pub async fn instagram_connection(&self, org: Uuid) -> Result<Option<Connection>> {
        let row: Option<Connection> =
            sqlx::query_as("SELECT * FROM instagram_connections WHERE org_id=$1")
                .bind(org)
                .fetch_optional(&self.org_pool(org)?)
                .await?;
        row.map(|mut r| {
            r.token_ciphertext =
                decrypt_connector_key(&self.connector_encryption_key, &r.token_ciphertext)?;
            Ok(r)
        })
        .transpose()
    }

    pub async fn instagram_connection_save(&self, c: &Connection, expected: i64) -> Result<bool> {
        let mut tx = self.org_pool(c.org_id)?.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,734410026))")
            .bind(c.org_id.to_string())
            .execute(&mut *tx)
            .await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,734410028))")
            .bind(&c.app_id)
            .execute(&mut *tx)
            .await?;
        let revoked:Option<DateTime<Utc>>=sqlx::query_scalar("SELECT max(revoked_at) FROM instagram_revocations WHERE app_id=$1 AND ((subject_kind=$2 AND instagram_id=$3) OR ($4::text IS NOT NULL AND subject_kind='business' AND instagram_id=$4))")
            .bind(&c.app_id).bind(if c.login_mode=="unified"{"system_user"}else{"instagram_account"}).bind(&c.provider_subject).bind(&c.client_business_id).fetch_one(&mut *tx).await?;
        if revoked.is_some_and(|at| at >= c.authorized_at) {
            return Ok(false);
        }
        let revision: Option<i64> = sqlx::query_scalar(
            "SELECT revision FROM instagram_connections WHERE org_id=$1 FOR UPDATE",
        )
        .bind(c.org_id)
        .fetch_optional(&mut *tx)
        .await?;
        if revision.unwrap_or(0) != expected {
            return Ok(false);
        }
        let changed:Option<DateTime<Utc>>=sqlx::query_scalar("SELECT max(changed_at) FROM instagram_business_changes WHERE app_id=$1 AND business_id=$2")
            .bind(&c.app_id).bind(&c.client_business_id).fetch_one(&mut *tx).await?;
        let needs_revalidation = changed.is_some_and(|at| at >= c.last_verified_at);
        let encrypted = encrypt_connector_key(&self.connector_encryption_key, &c.token_ciphertext)?;
        sqlx::query("INSERT INTO instagram_connections(org_id,id,instagram_id,app_id,authorized_at,username,active,token_ciphertext,scopes,expires_at,revision,login_mode,config_id,client_business_id,provider_subject,token_kind,last_verified_at,needs_revalidation) VALUES($1,$2,$3,$4,$5,$6,true,$7,$8,$9,1,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT(org_id) DO UPDATE SET id=$2,instagram_id=$3,app_id=$4,authorized_at=$5,username=$6,active=true,token_ciphertext=$7,scopes=$8,expires_at=$9,revision=instagram_connections.revision+1,login_mode=$10,config_id=$11,client_business_id=$12,provider_subject=$13,token_kind=$14,last_verified_at=$15,needs_revalidation=$16,updated_at=now()")
            .bind(c.org_id).bind(c.id).bind(&c.instagram_id).bind(&c.app_id).bind(c.authorized_at).bind(&c.username).bind(encrypted).bind(&c.scopes).bind(c.expires_at).bind(&c.login_mode).bind(&c.config_id).bind(&c.client_business_id).bind(&c.provider_subject).bind(&c.token_kind).bind(c.last_verified_at).bind(needs_revalidation).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(true)
    }

    pub async fn instagram_disconnect(&self, org: Uuid, expected: i64) -> Result<bool> {
        let mut tx = self.org_pool(org)?.begin().await?;
        let empty = encrypt_connector_key(&self.connector_encryption_key, "")?;
        let n=sqlx::query("UPDATE instagram_connections SET active=false,token_ciphertext=$3,scopes=ARRAY[]::text[],expires_at=now(),revision=revision+1,updated_at=now() WHERE org_id=$1 AND revision=$2 AND active").bind(org).bind(expected).bind(empty).execute(&mut *tx).await?.rows_affected();
        if n == 0 {
            return Ok(false);
        }
        sqlx::query("DELETE FROM instagram_flows WHERE org_id=$1")
            .bind(org)
            .execute(&mut *tx)
            .await?;
        // The durable record remains visible; a new OAuth connection never resumes it.
        sqlx::query("UPDATE instagram_publications SET state='outcome_unknown',revision=revision+1,error_code='connection_removed',updated_at=now() WHERE org_id=$1 AND state IN ('creating','prepared','publishing')")
            .bind(org).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(true)
    }

    /// Signed provider deauthorization/data-deletion callbacks are keyed by
    /// the verified Meta app and Instagram identity, never a caller's org UUID.
    pub async fn instagram_provider_revoke(
        &self,
        app: &str,
        instagram: &str,
        receipt: Option<&str>,
        issued_at: DateTime<Utc>,
    ) -> Result<()> {
        self.instagram_revoke_subject(app, instagram, "instagram_account", receipt, issued_at)
            .await
    }
    pub async fn instagram_revoke_subject(
        &self,
        app: &str,
        subject: &str,
        kind: &str,
        receipt: Option<&str>,
        issued_at: DateTime<Utc>,
    ) -> Result<()> {
        anyhow::ensure!(
            ["instagram_account", "system_user", "business"].contains(&kind),
            "invalid provider subject kind"
        );
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,734410028))")
            .bind(app)
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO instagram_revocations(app_id,subject_kind,instagram_id,revoked_at) VALUES($1,$2,$3,$4) ON CONFLICT(app_id,subject_kind,instagram_id) DO UPDATE SET revoked_at=GREATEST(instagram_revocations.revoked_at,EXCLUDED.revoked_at)")
            .bind(app).bind(kind).bind(subject).bind(issued_at).execute(&mut *tx).await?;
        let orgs:Vec<Uuid>=sqlx::query_scalar("SELECT org_id FROM instagram_connections WHERE app_id=$1 AND authorized_at<=$4 AND (($2='instagram_account' AND login_mode='instagram_login' AND provider_subject=$3) OR ($2='system_user' AND login_mode='unified' AND provider_subject=$3) OR ($2='business' AND login_mode='unified' AND client_business_id=$3)) FOR UPDATE")
            .bind(app).bind(kind).bind(subject).bind(issued_at).fetch_all(&mut *tx).await?;
        for org in orgs {
            let empty = encrypt_connector_key(&self.connector_encryption_key, "")?;
            sqlx::query("UPDATE instagram_connections SET active=false,token_ciphertext=$2,scopes=ARRAY[]::text[],expires_at=now(),revision=revision+1,updated_at=now() WHERE org_id=$1").bind(org).bind(empty).execute(&mut *tx).await?;
            sqlx::query("DELETE FROM instagram_flows WHERE org_id=$1")
                .bind(org)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM instagram_pending_grants WHERE org_id=$1")
                .bind(org)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM instagram_publications WHERE org_id=$1")
                .bind(org)
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE instagram_connections SET username='',instagram_id=$2,provider_subject=$2,client_business_id=CASE WHEN login_mode='unified' THEN $2 ELSE NULL END WHERE org_id=$1")
                .bind(org).bind(format!("removed-{}",Uuid::new_v4())).execute(&mut *tx).await?;
        }
        sqlx::query("DELETE FROM instagram_pending_grants WHERE app_id=$1 AND authorized_at<=$4 AND (($2='system_user' AND provider_subject=$3) OR ($2='business' AND client_business_id=$3))")
            .bind(app).bind(kind).bind(subject).bind(issued_at).execute(&mut *tx).await?;
        if let Some(hash) = receipt {
            sqlx::query("DELETE FROM instagram_deletion_receipts WHERE completed_at<now()-interval '30 days'").execute(&mut *tx).await?;
            sqlx::query("INSERT INTO instagram_deletion_receipts(confirmation_hash) VALUES($1) ON CONFLICT DO NOTHING").bind(hash).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn instagram_deletion_receipt(&self, hash: &str) -> Result<Option<DateTime<Utc>>> {
        Ok(sqlx::query_scalar("SELECT completed_at FROM instagram_deletion_receipts WHERE confirmation_hash=$1 AND completed_at>now()-interval '30 days'").bind(hash).fetch_optional(&self.pool).await?)
    }

    pub async fn instagram_publication(&self, org: Uuid, id: Uuid) -> Result<Option<Publication>> {
        Ok(
            sqlx::query_as("SELECT * FROM instagram_publications WHERE org_id=$1 AND id=$2")
                .bind(org)
                .bind(id)
                .fetch_optional(&self.org_pool(org)?)
                .await?,
        )
    }

    pub async fn instagram_publications(&self, org: Uuid) -> Result<Vec<Publication>> {
        Ok(sqlx::query_as("SELECT * FROM instagram_publications WHERE org_id=$1 ORDER BY created_at DESC LIMIT 100").bind(org).fetch_all(&self.org_pool(org)?).await?)
    }

    pub async fn instagram_publication_by_key(
        &self,
        org: Uuid,
        key: &str,
    ) -> Result<Option<(Publication, String)>> {
        let row: Option<(Uuid,String)>=sqlx::query_as("SELECT id,request_hash FROM instagram_publications WHERE org_id=$1 AND idempotency_key=$2").bind(org).bind(key).fetch_optional(&self.org_pool(org)?).await?;
        match row {
            Some((id, hash)) => Ok(self
                .instagram_publication(org, id)
                .await?
                .map(|p| (p, hash))),
            None => Ok(None),
        }
    }

    pub async fn instagram_claim_publication(
        &self,
        p: &Publication,
    ) -> Result<Option<Publication>> {
        let mut tx = self.org_pool(p.org_id)?.begin().await?;
        let source:Option<Uuid>=sqlx::query_scalar("SELECT id FROM content_objects WHERE org_id=$1 AND id=$2 AND revision=$3 AND published_revision=$3 AND status='published' FOR UPDATE")
            .bind(p.org_id).bind(p.content_id).bind(p.content_revision).fetch_optional(&mut *tx).await?;
        let connection:Option<Uuid>=sqlx::query_scalar("SELECT id FROM instagram_connections WHERE org_id=$1 AND id=$2 AND active AND NOT needs_revalidation AND (expires_at IS NULL OR expires_at>now()) FOR UPDATE")
            .bind(p.org_id).bind(p.connection_id).fetch_optional(&mut *tx).await?;
        if source.is_none() || connection.is_none() {
            return Ok(None);
        }
        let result=sqlx::query_as("UPDATE instagram_publications SET state='publishing',revision=revision+1,updated_at=now() WHERE org_id=$1 AND id=$2 AND revision=$3 AND state='prepared' RETURNING *")
            .bind(p.org_id).bind(p.id).bind(p.revision).fetch_optional(&mut *tx).await?;
        tx.commit().await?;
        Ok(result)
    }

    pub async fn instagram_reserve(
        &self,
        p: &Publication,
        key: &str,
        hash: &str,
    ) -> Result<Reservation> {
        let mut tx = self.org_pool(p.org_id)?.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,734410027))")
            .bind(p.org_id.to_string())
            .execute(&mut *tx)
            .await?;
        let existing: Option<(Uuid,String)>=sqlx::query_as("SELECT id,request_hash FROM instagram_publications WHERE org_id=$1 AND (idempotency_key=$2 OR (instagram_id=$3 AND content_id=$4 AND content_revision=$5 AND website_id=$6)) ORDER BY (idempotency_key=$2) DESC LIMIT 1")
            .bind(p.org_id).bind(key).bind(&p.instagram_id).bind(p.content_id).bind(p.content_revision).bind(p.website_id).fetch_optional(&mut *tx).await?;
        if let Some((id, prior_hash)) = existing {
            if prior_hash != hash {
                return Ok(Reservation::Conflict);
            }
            let row =
                sqlx::query_as("SELECT * FROM instagram_publications WHERE org_id=$1 AND id=$2")
                    .bind(p.org_id)
                    .bind(id)
                    .fetch_one(&mut *tx)
                    .await?;
            return Ok(Reservation::Existing(row));
        }
        let valid_source: Option<Uuid>=sqlx::query_scalar("SELECT id FROM content_objects WHERE org_id=$1 AND id=$2 AND revision=$3 AND published_revision=$3 AND status='published' FOR UPDATE")
            .bind(p.org_id).bind(p.content_id).bind(p.content_revision).fetch_optional(&mut *tx).await?;
        let valid_connection: Option<Uuid>=sqlx::query_scalar("SELECT id FROM instagram_connections WHERE org_id=$1 AND id=$2 AND instagram_id=$3 AND active AND NOT needs_revalidation AND (expires_at IS NULL OR expires_at>now()) FOR UPDATE")
            .bind(p.org_id).bind(p.connection_id).bind(&p.instagram_id).fetch_optional(&mut *tx).await?;
        if valid_source.is_none() || valid_connection.is_none() {
            return Ok(Reservation::SourceChanged);
        }
        sqlx::query("INSERT INTO instagram_publications(id,org_id,connection_id,instagram_id,content_id,content_revision,website_id,idempotency_key,request_hash,payload,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'creating')")
            .bind(p.id).bind(p.org_id).bind(p.connection_id).bind(&p.instagram_id).bind(p.content_id).bind(p.content_revision).bind(p.website_id).bind(key).bind(hash).bind(&p.payload).execute(&mut *tx).await?;
        let row = sqlx::query_as("SELECT * FROM instagram_publications WHERE org_id=$1 AND id=$2")
            .bind(p.org_id)
            .bind(p.id)
            .fetch_one(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(Reservation::Created(row))
    }

    // One atomic transition binds its state and optional provider receipts.
    #[allow(clippy::too_many_arguments)]
    pub async fn instagram_transition(
        &self,
        org: Uuid,
        id: Uuid,
        revision: i64,
        from: &str,
        to: &str,
        container: Option<&str>,
        media: Option<&str>,
        error: Option<&str>,
    ) -> Result<Option<Publication>> {
        Ok(sqlx::query_as("UPDATE instagram_publications SET state=$5,container_id=COALESCE($6,container_id),media_id=COALESCE($7,media_id),error_code=$8,revision=revision+1,updated_at=now() WHERE org_id=$1 AND id=$2 AND revision=$3 AND state=$4 RETURNING *")
            .bind(org).bind(id).bind(revision).bind(from).bind(to).bind(container).bind(media).bind(error).fetch_optional(&self.org_pool(org)?).await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sitegraph_domain::Status;

    #[tokio::test]
    #[ignore = "requires explicit isolated FIRE_FLINT_INSTAGRAM_TEST_DATABASE_URL on port15433/release DB"]
    async fn instagram_flows_encryption_revisions_and_idempotent_publication() {
        let url = std::env::var("FIRE_FLINT_INSTAGRAM_TEST_DATABASE_URL")
            .expect("explicit isolated database required");
        assert!(url.ends_with("/fireflint_release_test"));
        assert!(url.contains("@127.0.0.1:15433/") || url.contains("@localhost:15433/"));
        let db = Db::connect(&url).await.unwrap();
        db.migrate().await.unwrap();
        let key = Uuid::new_v4();
        let org = db
            .create_organization("Instagram isolated test", &format!("instagram-{key}"))
            .await
            .unwrap();
        let foreign = db
            .create_organization(
                "Instagram foreign test",
                &format!("instagram-foreign-{key}"),
            )
            .await
            .unwrap();
        let actor = db
            .create_user(
                &format!("instagram-{key}@example.test"),
                "Instagram fixture",
                "unusable-test-hash",
            )
            .await
            .unwrap();
        let flow = Flow {
            state_hash: format!("state-{key}"),
            browser_hash: "test-browser".into(),
            org_id: org,
            user_id: actor,
            session_version: 0,
            app_id: "123456".into(),
            login_mode: "instagram_login".into(),
            config_id: None,
            expected_revision: 0,
            expires_at: Utc::now() + chrono::Duration::minutes(10),
        };
        assert!(db.instagram_flow_create(&flow).await.unwrap());
        assert!(db
            .instagram_flow_consume(&flow.state_hash, "wrong-browser", &flow.app_id)
            .await
            .unwrap()
            .is_none());
        assert!(db
            .instagram_flow_consume(&flow.state_hash, &flow.browser_hash, "other-app")
            .await
            .unwrap()
            .is_none());
        assert!(db
            .instagram_flow_consume(&flow.state_hash, &flow.browser_hash, &flow.app_id)
            .await
            .unwrap()
            .is_some());
        assert!(db
            .instagram_flow_consume(&flow.state_hash, &flow.browser_hash, &flow.app_id)
            .await
            .unwrap()
            .is_none());
        let mut connection = Connection {
            org_id: org,
            id: Uuid::new_v4(),
            instagram_id: format!("{}", rand::random::<u64>()),
            app_id: flow.app_id.clone(),
            authorized_at: Utc::now() - chrono::Duration::minutes(1),
            username: "synthetic_fixture".into(),
            active: true,
            token_ciphertext: "synthetic-instagram-token-should-be-encrypted".into(),
            scopes: vec![
                "instagram_business_basic".into(),
                "instagram_business_content_publish".into(),
            ],
            expires_at: Some(Utc::now() + chrono::Duration::days(50)),
            revision: 1,
            login_mode: "instagram_login".into(),
            config_id: None,
            client_business_id: None,
            provider_subject: "fixture-subject".into(),
            token_kind: "instagram_user".into(),
            last_verified_at: Utc::now(),
            needs_revalidation: false,
        };
        connection.provider_subject = connection.instagram_id.clone();
        assert!(db.instagram_connection_save(&connection, 0).await.unwrap());
        let encrypted: String = sqlx::query_scalar(
            "SELECT token_ciphertext FROM instagram_connections WHERE org_id=$1",
        )
        .bind(org)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert!(encrypted.starts_with("v1:"));
        assert!(!encrypted.contains("synthetic-instagram"));
        assert_eq!(
            db.instagram_connection(org)
                .await
                .unwrap()
                .unwrap()
                .token_ciphertext,
            connection.token_ciphertext
        );
        assert!(db.instagram_connection(foreign).await.unwrap().is_none());
        assert!(!db.instagram_connection_save(&connection, 0).await.unwrap());
        let typ = db
            .create_content_type(
                org,
                "instagram_fixture",
                "Instagram fixture",
                &serde_json::json!({"fields":[]}),
            )
            .await
            .unwrap();
        let content = db
            .create_content(
                org,
                typ.id,
                &serde_json::json!({"instagram":"A synthetic caption"}),
            )
            .await
            .unwrap();
        let published = db
            .set_status(org, content.id, Status::Published)
            .await
            .unwrap()
            .unwrap();
        let now = Utc::now();
        let p = Publication {
            id: Uuid::new_v4(),
            org_id: org,
            connection_id: connection.id,
            instagram_id: connection.instagram_id.clone(),
            content_id: content.id,
            content_revision: published.revision,
            website_id: Uuid::new_v4(),
            payload: serde_json::json!({"caption":"A synthetic caption","image_url":"https://example.test/test.jpg"}),
            state: "creating".into(),
            revision: 1,
            container_id: None,
            media_id: None,
            error_code: None,
            created_at: now,
            updated_at: now,
        };
        let r = db
            .instagram_reserve(&p, "synthetic-request", "request-hash")
            .await
            .unwrap();
        assert!(matches!(r, Reservation::Created(_)));
        assert!(matches!(
            db.instagram_reserve(&p, "synthetic-request", "request-hash")
                .await
                .unwrap(),
            Reservation::Existing(_)
        ));
        assert!(matches!(
            db.instagram_reserve(&p, "synthetic-request", "changed-request")
                .await
                .unwrap(),
            Reservation::Conflict
        ));
        assert!(matches!(
            db.instagram_reserve(&p, "different-request", "request-hash")
                .await
                .unwrap(),
            Reservation::Existing(_)
        ));
        assert!(db
            .instagram_publication(foreign, p.id)
            .await
            .unwrap()
            .is_none());
        let prepared = db
            .instagram_transition(
                org,
                p.id,
                1,
                "creating",
                "prepared",
                Some("12345678"),
                None,
                None,
            )
            .await
            .unwrap()
            .unwrap();
        assert!(db
            .instagram_transition(
                org,
                p.id,
                1,
                "creating",
                "prepared",
                Some("12345678"),
                None,
                None
            )
            .await
            .unwrap()
            .is_none());
        let (a, b) = tokio::join!(
            db.instagram_claim_publication(&prepared),
            db.instagram_claim_publication(&prepared)
        );
        let a = a.unwrap();
        let b = b.unwrap();
        assert_ne!(a.is_some(), b.is_some());
        let claimed = a.or(b).unwrap();
        let unknown = db
            .instagram_transition(
                org,
                p.id,
                claimed.revision,
                "publishing",
                "outcome_unknown",
                None,
                None,
                Some("synthetic_transport_failure"),
            )
            .await
            .unwrap()
            .unwrap();
        assert!(db
            .instagram_claim_publication(&unknown)
            .await
            .unwrap()
            .is_none());
        assert!(db.instagram_disconnect(org, 1).await.unwrap());
        assert_eq!(
            db.instagram_connection(org)
                .await
                .unwrap()
                .unwrap()
                .revision,
            2
        );
        assert!(!db.instagram_connection_save(&connection, 1).await.unwrap());
        assert!(db.instagram_connection_save(&connection, 2).await.unwrap());
        let revoked = Utc::now();
        db.instagram_provider_revoke(
            &connection.app_id,
            &connection.instagram_id,
            Some("synthetic-confirmation-hash"),
            revoked,
        )
        .await
        .unwrap();
        assert!(!db.instagram_connection(org).await.unwrap().unwrap().active);
        assert!(db.instagram_publication(org, p.id).await.unwrap().is_none());
        assert!(db
            .instagram_deletion_receipt("synthetic-confirmation-hash")
            .await
            .unwrap()
            .is_some());
        let current = db
            .instagram_connection(org)
            .await
            .unwrap()
            .unwrap()
            .revision;
        assert!(!db
            .instagram_connection_save(&connection, current)
            .await
            .unwrap());
        let new_grant = Connection {
            authorized_at: revoked + chrono::Duration::seconds(1),
            ..connection
        };
        assert!(db
            .instagram_connection_save(&new_grant, current)
            .await
            .unwrap());
        // Replaying an old signed callback cannot delete a subsequently granted connection.
        db.instagram_provider_revoke(&new_grant.app_id, &new_grant.instagram_id, None, revoked)
            .await
            .unwrap();
        assert!(db.instagram_connection(org).await.unwrap().unwrap().active);
        sqlx::query("DELETE FROM organizations WHERE id=ANY($1)")
            .bind(vec![org, foreign])
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM users WHERE id=$1")
            .bind(actor)
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM instagram_deletion_receipts WHERE confirmation_hash='synthetic-confirmation-hash'").execute(&db.pool).await.unwrap();
        sqlx::query("DELETE FROM instagram_revocations WHERE app_id=$1 AND instagram_id=$2")
            .bind(new_grant.app_id)
            .bind(new_grant.instagram_id)
            .execute(&db.pool)
            .await
            .unwrap();
    }
}
