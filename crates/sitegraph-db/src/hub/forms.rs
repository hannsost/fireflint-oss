use super::*;
use serde::Deserialize;
use sitegraph_company_hub::{validate_data, validate_fields, Field};

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct FormInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub fields: Vec<Field>,
    #[serde(default)]
    pub published: bool,
    pub expected_revision: Option<i64>,
}
#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SubmissionInput {
    pub expected_revision: Option<i64>,
    pub submission_key: Uuid,
    pub data: Value,
    #[serde(default)]
    pub website: String,
}
impl Db {
    pub async fn hub_forms(&self, org: Uuid, offset: i64) -> HubResult<Value> {
        self.hub_enabled(org, "forms").await?;
        let rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(f)||(SELECT jsonb_build_object('submission_count',count(*)) FROM hub_submissions s WHERE s.org_id=f.org_id AND s.form_id=f.id) FROM hub_forms f WHERE org_id=$1 ORDER BY updated_at DESC,id LIMIT 100 OFFSET $2")
            .bind(org).bind(offset.max(0)).fetch_all(&self.org_pool(org)?).await?;
        Ok(json!(rows))
    }
    pub async fn hub_save_form(
        &self,
        org: Uuid,
        actor: Uuid,
        id: Option<Uuid>,
        body: FormInput,
    ) -> HubResult<Value> {
        if id.is_none() && body.expected_revision.is_some_and(|r| r != 0) {
            return Err(HubError::Conflict(0));
        }
        bounded(&body.name, 240, "Formularname")?;
        if body.description.len() > 4000 {
            return Err(HubError::Invalid("Beschreibung ist zu lang.".into()));
        }
        validate_fields(&body.fields).map_err(HubError::Invalid)?;
        let fields = serde_json::to_value(&body.fields).map_err(anyhow::Error::from)?;
        let mut tx = self.hub_begin(org, actor, "forms", false).await?;
        let value: Value = if let Some(id) = id {
            let revision: Option<i64> =
                sqlx::query_scalar("SELECT revision FROM hub_forms WHERE org_id=$1 AND id=$2")
                    .bind(org)
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await?;
            check_revision(body.expected_revision, revision.ok_or(HubError::NotFound)?)?;
            sqlx::query_scalar("UPDATE hub_forms SET name=$3,description=$4,fields=$5,published=$6,revision=revision+1,updated_at=now() WHERE org_id=$1 AND id=$2 RETURNING to_jsonb(hub_forms)")
                .bind(org).bind(id).bind(body.name.trim()).bind(body.description).bind(fields).bind(body.published).fetch_one(&mut *tx).await?
        } else {
            sqlx::query_scalar("INSERT INTO hub_forms(org_id,name,description,fields,published,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING to_jsonb(hub_forms)")
                .bind(org).bind(body.name.trim()).bind(body.description).bind(fields).bind(body.published).bind(actor).fetch_one(&mut *tx).await?
        };
        let form_id: Uuid =
            serde_json::from_value(value["id"].clone()).map_err(anyhow::Error::from)?;
        sqlx::query("INSERT INTO hub_form_versions(org_id,form_id,revision,snapshot,actor_id) VALUES($1,$2,$3,$4,$5)")
            .bind(org).bind(form_id).bind(value["revision"].as_i64()).bind(&value).bind(actor).execute(&mut *tx).await?;
        event(
            &mut tx,
            org,
            actor,
            "de.fireflint.form.saved",
            value["id"].as_str().unwrap(),
            &json!({"revision":value["revision"],"published":body.published}),
        )
        .await?;
        tx.commit().await?;
        Ok(value)
    }
    pub async fn hub_form_history(&self, org: Uuid, id: Uuid, offset: i64) -> HubResult<Value> {
        self.hub_enabled(org, "forms").await?;
        let rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(v) FROM hub_form_versions v WHERE org_id=$1 AND form_id=$2 ORDER BY revision DESC LIMIT 100 OFFSET $3")
            .bind(org).bind(id).bind(offset.max(0)).fetch_all(&self.org_pool(org)?).await?;
        Ok(json!(rows))
    }
    pub async fn hub_public_form(&self, public_id: Uuid) -> HubResult<Value> {
        let value:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',public_id,'name',name,'description',description,'fields',fields,'revision',revision) FROM hub_forms f WHERE public_id=$1 AND published AND EXISTS(SELECT 1 FROM hub_modules WHERE org_id=f.org_id AND module_key='forms' AND enabled)")
            .bind(public_id).fetch_optional(&self.pool).await?;
        value.ok_or(HubError::NotFound)
    }
    pub async fn hub_submit_form(
        &self,
        public_id: Uuid,
        body: SubmissionInput,
    ) -> HubResult<Value> {
        if !body.website.is_empty() {
            return Err(HubError::Invalid(
                "Die Eingabe wurde nicht angenommen.".into(),
            ));
        }
        let org: Uuid = sqlx::query_scalar("SELECT org_id FROM hub_forms WHERE public_id=$1")
            .bind(public_id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or(HubError::NotFound)?;
        let mut tx = self.org_pool(org)?.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,76102))")
            .bind(org.to_string())
            .execute(&mut *tx)
            .await?;
        enabled(&mut tx, org, "forms")
            .await
            .map_err(|_| HubError::NotFound)?;
        let form: Value = sqlx::query_scalar(
            "SELECT to_jsonb(f) FROM hub_forms f WHERE org_id=$1 AND public_id=$2 AND published",
        )
        .bind(org)
        .bind(public_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(HubError::NotFound)?;
        let form_id: Uuid =
            serde_json::from_value(form["id"].clone()).map_err(anyhow::Error::from)?;
        if let Some((id,data,revision))=sqlx::query_as::<_,(Uuid,Value,i64)>("SELECT id,data,form_revision FROM hub_submissions WHERE org_id=$1 AND form_id=$2 AND submission_key=$3")
            .bind(org).bind(form_id).bind(body.submission_key).fetch_optional(&mut *tx).await? {
            if data!=body.data || body.expected_revision!=Some(revision) {return Err(HubError::Invalid("Dieser Einreichungsschlüssel wurde bereits verwendet.".into()));}
            return Ok(json!({"id":id,"accepted":true}));
        }
        check_revision(body.expected_revision, form["revision"].as_i64().unwrap())?;
        let fields: Vec<Field> =
            serde_json::from_value(form["fields"].clone()).map_err(anyhow::Error::from)?;
        validate_data(&fields, &body.data).map_err(HubError::Invalid)?;
        let id:Uuid=sqlx::query_scalar("INSERT INTO hub_submissions(org_id,form_id,form_revision,form_snapshot,data,submission_key) VALUES($1,$2,$3,$4,$5,$6) RETURNING id")
            .bind(org).bind(form_id).bind(form["revision"].as_i64()).bind(json!({"name":form["name"],"description":form["description"],"fields":form["fields"]})).bind(body.data).bind(body.submission_key).fetch_one(&mut *tx).await?;
        sqlx::query("INSERT INTO hub_events(org_id,event_type,subject,data) VALUES($1,'de.fireflint.form.submitted',$2,$3)")
            .bind(org).bind(id.to_string()).bind(json!({"form_id":form_id,"form_revision":form["revision"],"actor_type":"public"})).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(json!({"id":id,"accepted":true}))
    }
    pub async fn hub_submissions(&self, org: Uuid, form_id: Uuid, offset: i64) -> HubResult<Value> {
        self.hub_enabled(org, "forms").await?;
        let rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(s)-'submission_key' FROM hub_submissions s WHERE org_id=$1 AND form_id=$2 ORDER BY created_at DESC,id LIMIT 100 OFFSET $3")
            .bind(org).bind(form_id).bind(offset.clamp(0,100_000)).fetch_all(&self.org_pool(org)?).await?;
        Ok(json!(rows))
    }
    pub async fn hub_submission_status(
        &self,
        org: Uuid,
        actor: Uuid,
        id: Uuid,
        status: &str,
        expected: Option<i64>,
    ) -> HubResult<Value> {
        if !["new", "processing", "closed"].contains(&status) {
            return Err(HubError::Invalid("Ungültiger Bearbeitungsstand.".into()));
        }
        let mut tx = self.hub_begin(org, actor, "forms", false).await?;
        let revision: Option<i64> =
            sqlx::query_scalar("SELECT revision FROM hub_submissions WHERE org_id=$1 AND id=$2")
                .bind(org)
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?;
        check_revision(expected, revision.ok_or(HubError::NotFound)?)?;
        let value:Value=sqlx::query_scalar("UPDATE hub_submissions SET status=$3,revision=revision+1 WHERE org_id=$1 AND id=$2 RETURNING to_jsonb(hub_submissions)-'submission_key'")
            .bind(org).bind(id).bind(status).fetch_one(&mut *tx).await?;
        event(
            &mut tx,
            org,
            actor,
            "de.fireflint.submission.changed",
            &id.to_string(),
            &json!({"status":status}),
        )
        .await?;
        tx.commit().await?;
        Ok(value)
    }
}
