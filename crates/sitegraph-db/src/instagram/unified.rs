use super::*;

// No Debug or Serialize: this contains an encrypted/decrypted provider grant.
#[derive(FromRow)]
pub struct PendingGrant {
    pub id: Uuid,
    pub org_id: Uuid,
    pub user_id: Uuid,
    pub session_version: i32,
    pub expected_revision: i64,
    pub app_id: String,
    pub config_id: String,
    pub client_business_id: String,
    pub provider_subject: String,
    pub token_ciphertext: String,
    pub scopes: Vec<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub authorized_at: DateTime<Utc>,
    pub accounts: Value,
    pub pending_until: DateTime<Utc>,
}

impl Db {
    pub async fn instagram_pending_create(&self, p: &PendingGrant) -> Result<bool> {
        let mut tx = self.org_pool(p.org_id)?.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,734410026))")
            .bind(p.org_id.to_string())
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM instagram_pending_grants WHERE pending_until<=now()")
            .execute(&mut *tx)
            .await?;
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM instagram_pending_grants WHERE org_id=$1")
                .bind(p.org_id)
                .fetch_one(&mut *tx)
                .await?;
        if count >= 10 {
            return Ok(false);
        }
        let token = encrypt_connector_key(&self.connector_encryption_key, &p.token_ciphertext)?;
        sqlx::query("INSERT INTO instagram_pending_grants(id,org_id,user_id,session_version,expected_revision,app_id,config_id,client_business_id,provider_subject,token_ciphertext,scopes,expires_at,authorized_at,accounts,pending_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)")
            .bind(p.id).bind(p.org_id).bind(p.user_id).bind(p.session_version).bind(p.expected_revision).bind(&p.app_id).bind(&p.config_id).bind(&p.client_business_id).bind(&p.provider_subject).bind(token).bind(&p.scopes).bind(p.expires_at).bind(p.authorized_at).bind(&p.accounts).bind(p.pending_until).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(true)
    }
    pub async fn instagram_pending(
        &self,
        org: Uuid,
        user: Uuid,
        id: Uuid,
    ) -> Result<Option<PendingGrant>> {
        let p:Option<PendingGrant>=sqlx::query_as("SELECT * FROM instagram_pending_grants WHERE org_id=$1 AND user_id=$2 AND id=$3 AND pending_until>now()")
            .bind(org).bind(user).bind(id).fetch_optional(&self.org_pool(org)?).await?;
        p.map(|mut p| {
            p.token_ciphertext =
                decrypt_connector_key(&self.connector_encryption_key, &p.token_ciphertext)?;
            Ok(p)
        })
        .transpose()
    }
    pub async fn instagram_pending_remove(&self, org: Uuid, user: Uuid, id: Uuid) -> Result<()> {
        sqlx::query(
            "DELETE FROM instagram_pending_grants WHERE org_id=$1 AND user_id=$2 AND id=$3",
        )
        .bind(org)
        .bind(user)
        .bind(id)
        .execute(&self.org_pool(org)?)
        .await?;
        Ok(())
    }
    pub async fn instagram_business_changed(
        &self,
        app: &str,
        business: &str,
        issued: DateTime<Utc>,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,734410028))")
            .bind(app)
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO instagram_business_changes(app_id,business_id,changed_at) VALUES($1,$2,$3) ON CONFLICT(app_id,business_id) DO UPDATE SET changed_at=GREATEST(instagram_business_changes.changed_at,EXCLUDED.changed_at)")
            .bind(app).bind(business).bind(issued).execute(&mut *tx).await?;
        sqlx::query("UPDATE instagram_connections SET needs_revalidation=true,revision=revision+1,updated_at=now() WHERE app_id=$1 AND client_business_id=$2 AND login_mode='unified' AND active AND NOT needs_revalidation AND last_verified_at<=$3")
            .bind(app).bind(business).bind(issued).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires explicit isolated FIRE_FLINT_INSTAGRAM_TEST_DATABASE_URL on port15433/release DB"]
    async fn instagram_unified_portfolio_pending_selection_expiry_and_delayed_updates() {
        let url = std::env::var("FIRE_FLINT_INSTAGRAM_TEST_DATABASE_URL")
            .expect("explicit isolated DB required");
        assert!(url.ends_with("/fireflint_release_test") && url.contains("@127.0.0.1:15433/"));
        let db = Db::connect(&url).await.unwrap();
        db.migrate().await.unwrap();
        let key = Uuid::new_v4();
        let org = db
            .create_organization("Unified fixture", &format!("unified-{key}"))
            .await
            .unwrap();
        let foreign = db
            .create_organization("Unified foreign fixture", &format!("unified-foreign-{key}"))
            .await
            .unwrap();
        let user = db
            .create_user(
                &format!("unified-{key}@example.test"),
                "Unified fixture",
                "unusable-test-hash",
            )
            .await
            .unwrap();
        let at = Utc::now();
        let app = rand::random::<u64>().to_string();
        let business = rand::random::<u64>().to_string();
        let mut c = Connection {
            org_id: org,
            id: Uuid::new_v4(),
            instagram_id: rand::random::<u64>().to_string(),
            app_id: app.clone(),
            authorized_at: at - chrono::Duration::minutes(1),
            username: "unified_fixture".into(),
            active: true,
            token_ciphertext: "synthetic-unified-portfolio-grant-only".into(),
            scopes: vec!["instagram_basic".into(), "instagram_content_publish".into()],
            expires_at: None,
            revision: 1,
            login_mode: "unified".into(),
            config_id: Some("987654321".into()),
            client_business_id: Some(business.clone()),
            provider_subject: rand::random::<u64>().to_string(),
            token_kind: "business_integration_system_user".into(),
            last_verified_at: at - chrono::Duration::seconds(1),
            needs_revalidation: false,
        };
        // An event received before the first connection row exists is retained.
        db.instagram_business_changed(&app, &business, at)
            .await
            .unwrap();
        assert!(db.instagram_connection_save(&c, 0).await.unwrap());
        let saved = db.instagram_connection(org).await.unwrap().unwrap();
        assert!(saved.expires_at.is_none());
        assert!(saved.needs_revalidation);
        assert_eq!(saved.client_business_id, Some(business.clone()));
        c.last_verified_at = at + chrono::Duration::seconds(1);
        assert!(db
            .instagram_connection_save(&c, saved.revision)
            .await
            .unwrap());
        let saved = db.instagram_connection(org).await.unwrap().unwrap();
        assert!(!saved.needs_revalidation);
        db.instagram_business_changed(&app, &business, at)
            .await
            .unwrap();
        assert!(
            !db.instagram_connection(org)
                .await
                .unwrap()
                .unwrap()
                .needs_revalidation,
            "old notification cannot invalidate a newer verification"
        );
        db.instagram_business_changed(&app, &business, at + chrono::Duration::seconds(2))
            .await
            .unwrap();
        let saved = db.instagram_connection(org).await.unwrap().unwrap();
        assert!(saved.needs_revalidation);
        assert!(!db
            .instagram_connection_save(&c, saved.revision - 1)
            .await
            .unwrap());
        let pending = PendingGrant {
            id: Uuid::new_v4(),
            org_id: org,
            user_id: user,
            session_version: 0,
            expected_revision: saved.revision,
            app_id: app.clone(),
            config_id: "987654321".into(),
            client_business_id: business.clone(),
            provider_subject: c.provider_subject.clone(),
            token_ciphertext: c.token_ciphertext.clone(),
            scopes: c.scopes.clone(),
            expires_at: None,
            authorized_at: c.authorized_at,
            accounts: serde_json::json!([{"id":c.instagram_id,"username":"one"},{"id":"99999999","username":"two"}]),
            pending_until: at + chrono::Duration::minutes(10),
        };
        assert!(db.instagram_pending_create(&pending).await.unwrap());
        assert!(db
            .instagram_pending(foreign, user, pending.id)
            .await
            .unwrap()
            .is_none());
        assert!(db
            .instagram_pending(org, Uuid::new_v4(), pending.id)
            .await
            .unwrap()
            .is_none());
        let loaded = db
            .instagram_pending(org, user, pending.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.token_ciphertext, c.token_ciphertext);
        assert_eq!(loaded.accounts.as_array().unwrap().len(), 2);
        let stored: String =
            sqlx::query_scalar("SELECT token_ciphertext FROM instagram_pending_grants WHERE id=$1")
                .bind(pending.id)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert!(stored.starts_with("v1:"));
        assert!(!stored.contains("synthetic-unified"));
        db.instagram_revoke_subject(&app, "unrelated-business", "business", None, at)
            .await
            .unwrap();
        assert!(db.instagram_connection(org).await.unwrap().unwrap().active);
        db.instagram_revoke_subject(&app, &business, "business", None, at)
            .await
            .unwrap();
        assert!(!db.instagram_connection(org).await.unwrap().unwrap().active);
        assert!(db
            .instagram_pending(org, user, pending.id)
            .await
            .unwrap()
            .is_none());
        let revision = db
            .instagram_connection(org)
            .await
            .unwrap()
            .unwrap()
            .revision;
        c.authorized_at = at + chrono::Duration::seconds(3);
        c.last_verified_at = at + chrono::Duration::seconds(3);
        assert!(db.instagram_connection_save(&c, revision).await.unwrap());
        db.instagram_revoke_subject(&app, &business, "business", None, at)
            .await
            .unwrap();
        assert!(
            db.instagram_connection(org).await.unwrap().unwrap().active,
            "old uninstall cannot delete explicitly newer OAuth grant"
        );
        sqlx::query("DELETE FROM organizations WHERE id=ANY($1)")
            .bind(vec![org, foreign])
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM users WHERE id=$1")
            .bind(user)
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM instagram_business_changes WHERE app_id=$1")
            .bind(&app)
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM instagram_revocations WHERE app_id=$1")
            .bind(&app)
            .execute(&db.pool)
            .await
            .unwrap();
    }
}
