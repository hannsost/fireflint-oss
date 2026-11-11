use super::*;
use chrono::{DateTime, Utc};
use serde::Deserialize;

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct TaskInput {
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub assignee_id: Uuid,
    pub record_id: Option<Uuid>,
    pub subject_revision: Option<i64>,
    #[serde(default)]
    pub requires_approval: bool,
    pub due_at: Option<DateTime<Utc>>,
}

async fn notify(tx: &mut Tx<'_>, org: Uuid, user: Uuid, task: Uuid, title: &str) -> HubResult<()> {
    enabled(tx, org, "notifications").await?;
    sqlx::query("INSERT INTO hub_notifications(org_id,user_id,task_id,title) VALUES($1,$2,$3,$4)")
        .bind(org)
        .bind(user)
        .bind(task)
        .bind(title)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

impl Db {
    pub async fn hub_tasks(&self, org: Uuid, offset: i64) -> HubResult<Value> {
        self.hub_enabled(org, "work").await?;
        let rows:Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(t)||jsonb_build_object('assignee_name',u.name,'record_name',r.name,'stale',r.revision IS DISTINCT FROM t.subject_revision AND t.record_id IS NOT NULL) FROM hub_tasks t JOIN users u ON u.id=t.assignee_id LEFT JOIN hub_records r ON r.org_id=t.org_id AND r.id=t.record_id WHERE t.org_id=$1 ORDER BY (t.status='open') DESC,t.due_at NULLS LAST,t.created_at DESC LIMIT 100 OFFSET $2")
            .bind(org).bind(offset.clamp(0,100_000)).fetch_all(&self.org_pool(org)?).await?;
        Ok(json!(rows))
    }
    pub async fn hub_create_task(
        &self,
        org: Uuid,
        actor: Uuid,
        body: TaskInput,
    ) -> HubResult<Value> {
        bounded(&body.title, 240, "Titel")?;
        if body.description.len() > 16_384 {
            return Err(HubError::Invalid("Beschreibung ist zu lang.".into()));
        }
        let mut tx = self.hub_begin(org, actor, "work", false).await?;
        let member:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM memberships WHERE org_id=$1 AND user_id=$2 AND role IN ('owner','editor'))")
            .bind(org).bind(body.assignee_id).fetch_one(&mut *tx).await?;
        if !member {
            return Err(HubError::Invalid(
                "Die zuständige Person benötigt Schreibrechte in diesem Arbeitsbereich.".into(),
            ));
        }
        if let Some(id) = body.record_id {
            let record = super::records::active_record(&mut tx, org, id).await?;
            check_revision(body.subject_revision, record["revision"].as_i64().unwrap())?;
            if body.requires_approval && record["updated_by"] == body.assignee_id.to_string() {
                return Err(HubError::Invalid(
                    "Die letzte bearbeitende Person darf ihren eigenen Stand nicht freigeben."
                        .into(),
                ));
            }
        }
        if body.requires_approval && (body.record_id.is_none() || body.assignee_id == actor) {
            return Err(HubError::Invalid(
                "Eine Freigabe benötigt einen Datensatz und eine zweite Person.".into(),
            ));
        }
        let value:Value=sqlx::query_scalar("INSERT INTO hub_tasks(org_id,title,description,assignee_id,created_by,record_id,subject_revision,requires_approval,due_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING to_jsonb(hub_tasks)")
            .bind(org).bind(body.title.trim()).bind(body.description).bind(body.assignee_id).bind(actor).bind(body.record_id).bind(body.subject_revision).bind(body.requires_approval).bind(body.due_at).fetch_one(&mut *tx).await?;
        let id: Uuid = serde_json::from_value(value["id"].clone()).map_err(anyhow::Error::from)?;
        notify(
            &mut tx,
            org,
            body.assignee_id,
            id,
            &format!("Neue Aufgabe: {}", body.title),
        )
        .await?;
        event(
            &mut tx,
            org,
            actor,
            "de.fireflint.task.created",
            &id.to_string(),
            &json!({"assignee":body.assignee_id,"record_id":body.record_id}),
        )
        .await?;
        tx.commit().await?;
        Ok(value)
    }
    pub async fn hub_decide_task(
        &self,
        org: Uuid,
        actor: Uuid,
        id: Uuid,
        status: &str,
        expected: Option<i64>,
    ) -> HubResult<Value> {
        if !["done", "approved", "rejected"].contains(&status) {
            return Err(HubError::Invalid("Ungültige Entscheidung.".into()));
        }
        let mut tx = self.hub_begin(org, actor, "work", false).await?;
        let task: Value =
            sqlx::query_scalar("SELECT to_jsonb(t) FROM hub_tasks t WHERE org_id=$1 AND id=$2")
                .bind(org)
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or(HubError::NotFound)?;
        check_revision(expected, task["revision"].as_i64().unwrap())?;
        if task["status"] != "open" {
            return Err(HubError::Invalid(
                "Die Aufgabe ist bereits entschieden.".into(),
            ));
        }
        if task["assignee_id"] != actor.to_string() {
            return Err(HubError::Forbidden);
        }
        let approval = task["requires_approval"] == true;
        if approval == (status == "done") {
            return Err(HubError::Invalid(
                "Diese Entscheidung passt nicht zur Aufgabe.".into(),
            ));
        }
        if approval {
            let record_id: Uuid =
                serde_json::from_value(task["record_id"].clone()).map_err(anyhow::Error::from)?;
            let record = super::records::active_record(&mut tx, org, record_id).await?;
            check_revision(
                task["subject_revision"].as_i64(),
                record["revision"].as_i64().unwrap(),
            )?;
            if task["created_by"] == actor.to_string() || record["updated_by"] == actor.to_string()
            {
                return Err(HubError::Forbidden);
            }
        }
        let value:Value=sqlx::query_scalar("UPDATE hub_tasks SET status=$3,revision=revision+1,updated_at=now() WHERE org_id=$1 AND id=$2 RETURNING to_jsonb(hub_tasks)")
            .bind(org).bind(id).bind(status).fetch_one(&mut *tx).await?;
        let creator: Uuid =
            serde_json::from_value(task["created_by"].clone()).map_err(anyhow::Error::from)?;
        notify(
            &mut tx,
            org,
            creator,
            id,
            &format!(
                "Aufgabe entschieden: {}",
                task["title"].as_str().unwrap_or("")
            ),
        )
        .await?;
        event(
            &mut tx,
            org,
            actor,
            "de.fireflint.task.decided",
            &id.to_string(),
            &json!({"status":status,"subject_revision":task["subject_revision"]}),
        )
        .await?;
        tx.commit().await?;
        Ok(value)
    }
    pub async fn hub_comments(&self, org: Uuid, id: Uuid, offset: i64) -> HubResult<Value> {
        self.hub_enabled(org, "work").await?;
        let rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(c)||jsonb_build_object('actor_name',u.name) FROM hub_comments c JOIN users u ON u.id=c.actor_id WHERE c.org_id=$1 AND c.task_id=$2 ORDER BY c.created_at,c.id LIMIT 200 OFFSET $3")
            .bind(org).bind(id).bind(offset.max(0)).fetch_all(&self.org_pool(org)?).await?;
        Ok(json!(rows))
    }
    pub async fn hub_comment(
        &self,
        org: Uuid,
        actor: Uuid,
        id: Uuid,
        body: &str,
    ) -> HubResult<Value> {
        bounded(body, 8000, "Kommentar")?;
        let mut tx = self.hub_begin(org, actor, "work", false).await?;
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM hub_tasks WHERE org_id=$1 AND id=$2)")
                .bind(org)
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
        if !exists {
            return Err(HubError::NotFound);
        }
        let value:Value=sqlx::query_scalar("INSERT INTO hub_comments(org_id,task_id,actor_id,body) VALUES($1,$2,$3,$4) RETURNING to_jsonb(hub_comments)")
            .bind(org).bind(id).bind(actor).bind(body.trim()).fetch_one(&mut *tx).await?;
        event(
            &mut tx,
            org,
            actor,
            "de.fireflint.task.commented",
            &id.to_string(),
            &json!({"comment_id":value["id"]}),
        )
        .await?;
        tx.commit().await?;
        Ok(value)
    }
    pub async fn hub_notifications(&self, org: Uuid, actor: Uuid, offset: i64) -> HubResult<Value> {
        self.hub_enabled(org, "notifications").await?;
        let rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(n) FROM hub_notifications n WHERE org_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100 OFFSET $3")
            .bind(org).bind(actor).bind(offset.max(0)).fetch_all(&self.org_pool(org)?).await?;
        Ok(json!(rows))
    }
    pub async fn hub_read_notification(&self, org: Uuid, actor: Uuid, id: Uuid) -> HubResult<()> {
        let mut tx = self.org_pool(org)?.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,76102))")
            .bind(org.to_string())
            .execute(&mut *tx)
            .await?;
        let member: Option<String> = sqlx::query_scalar(
            "SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2 FOR SHARE",
        )
        .bind(org)
        .bind(actor)
        .fetch_optional(&mut *tx)
        .await?;
        if member.is_none() {
            return Err(HubError::Forbidden);
        }
        enabled(&mut tx, org, "notifications").await?;
        let changed=sqlx::query("UPDATE hub_notifications SET read_at=COALESCE(read_at,now()) WHERE org_id=$1 AND user_id=$2 AND id=$3")
            .bind(org).bind(actor).bind(id).execute(&mut *tx).await?;
        if changed.rows_affected() == 0 {
            return Err(HubError::NotFound);
        }
        tx.commit().await?;
        Ok(())
    }
}
