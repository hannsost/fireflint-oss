//! Editorial campaigns and tenant-scoped draft generation handoff. Nothing here
//! schedules, publishes, invokes a model, or operates a second orchestrator.
mod runtime;
mod sources;
#[cfg(test)]
mod tests;
use crate::hub::{HubError, HubResult};
use crate::Db;
use chrono::{NaiveDate, NaiveTime};
pub use runtime::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

type Tx<'a> = Transaction<'a, Postgres>;

#[derive(Clone, Debug, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CampaignInput {
    pub name: String,
    pub start_date: NaiveDate,
    pub end_date: NaiveDate,
    pub time_zone: String,
    pub platforms: Vec<String>,
    #[serde(default = "empty_object")]
    pub rules: Value,
    pub status: String,
    pub expected_revision: Option<i64>,
}

fn empty_object() -> Value {
    json!({})
}

#[derive(Clone, Debug, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CampaignEntryInput {
    pub content_id: Uuid,
    pub content_revision: i64,
    pub expected_campaign_revision: i64,
    pub desired_date: NaiveDate,
    pub desired_time: Option<String>,
    pub platform: String,
    pub status: String,
    pub expected_revision: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CampaignRunInput {
    pub expected_campaign_revision: i64,
    pub idempotency_key: String,
    pub requested_count: u16,
    #[serde(default)]
    pub instructions: String,
}

#[derive(Default, Deserialize, utoipa::ToSchema)]
#[serde(default, deny_unknown_fields)]
pub struct CalendarQuery {
    pub from: Option<NaiveDate>,
    pub to: Option<NaiveDate>,
    pub campaign_id: Option<Uuid>,
    pub platform: Option<String>,
    pub status: Option<String>,
}

fn invalid(message: &str) -> HubError {
    HubError::Invalid(message.into())
}

fn revision(expected: Option<i64>, current: i64) -> HubResult<()> {
    match expected {
        None => Err(HubError::RevisionRequired),
        Some(n) if n <= 0 => Err(invalid("Eine positive gelesene Revision ist erforderlich.")),
        Some(n) if n != current => Err(HubError::Conflict(current)),
        _ => Ok(()),
    }
}

fn text(value: &str, max: usize, required: bool) -> HubResult<()> {
    if value.len() > max
        || (required && value.trim().is_empty())
        || value
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(invalid(
            "Text ist leer, zu lang oder enthält unzulässige Steuerzeichen.",
        ));
    }
    Ok(())
}

fn time(value: Option<&str>) -> HubResult<()> {
    if let Some(value) = value {
        if value.len() != 5 || NaiveTime::parse_from_str(value, "%H:%M").is_err() {
            return Err(invalid("Die gewünschte Uhrzeit benötigt HH:MM."));
        }
    }
    Ok(())
}

fn platform(value: &str) -> HubResult<()> {
    if value.is_empty()
        || value.len() > 40
        || !value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
    {
        return Err(invalid("Ungültige Plattformkennung."));
    }
    Ok(())
}

fn validate_campaign(input: &CampaignInput) -> HubResult<()> {
    text(&input.name, 240, true)?;
    if input.name.chars().any(char::is_control)
        || input.start_date > input.end_date
        || (input.end_date - input.start_date).num_days() > 1096
    {
        return Err(invalid(
            "Der Kampagnenzeitraum muss geordnet sein und darf höchstens drei Jahre umfassen.",
        ));
    }
    input
        .time_zone
        .parse::<chrono_tz::Tz>()
        .map_err(|_| invalid("Unbekannte IANA-Zeitzone."))?;
    if input.platforms.is_empty() || input.platforms.len() > 20 {
        return Err(invalid("Eine bis zwanzig Plattformen sind erforderlich."));
    }
    let mut seen = std::collections::HashSet::new();
    for value in &input.platforms {
        platform(value)?;
        if !seen.insert(value) {
            return Err(invalid("Plattformen dürfen nicht doppelt vorkommen."));
        }
    }
    if !matches!(input.status.as_str(), "draft" | "ready" | "archived") {
        return Err(invalid("Unbekannter Kampagnenstatus."));
    }
    if !input.rules.is_object() || input.rules.to_string().len() > 16384 {
        return Err(invalid(
            "Regeln müssen ein JSON-Objekt mit höchstens 16 KiB sein.",
        ));
    }
    sources::website_filter(&input.rules)?;
    for key in ["brief", "instructions", "audience", "tone", "language"] {
        if let Some(value) = input.rules.get(key) {
            text(
                value
                    .as_str()
                    .ok_or_else(|| invalid("Kampagnentexte müssen Zeichenketten sein."))?,
                8000,
                false,
            )?;
        }
    }
    if let Some(value) = input.rules.get("interval_days") {
        if !value.as_u64().is_some_and(|v| (1..=365).contains(&v)) {
            return Err(invalid(
                "Der Beitragsabstand muss zwischen 1 und 365 Tagen liegen.",
            ));
        }
    }
    if let Some(value) = input.rules.get("preferred_time") {
        time(Some(
            value
                .as_str()
                .ok_or_else(|| invalid("Ungültige bevorzugte Uhrzeit."))?,
        ))?;
    }
    for key in ["included_dates", "excluded_dates"] {
        if let Some(value) = input.rules.get(key) {
            let dates = value.as_array().ok_or_else(|| {
                invalid("Regeltage müssen eine Liste von ISO-Datumsangaben sein.")
            })?;
            if dates.len() > 1097 {
                return Err(invalid("Zu viele Regeltage."));
            }
            for value in dates {
                let date: NaiveDate = serde_json::from_value(value.clone())
                    .map_err(|_| invalid("Ungültiger Regeltag."))?;
                if date < input.start_date || date > input.end_date {
                    return Err(invalid(
                        "Regeltage müssen innerhalb des Kampagnenzeitraums liegen.",
                    ));
                }
            }
        }
    }
    Ok(())
}

fn entry_matches(
    campaign: &Value,
    date: NaiveDate,
    clock: Option<&str>,
    target: &str,
) -> HubResult<()> {
    let start = campaign["start_date"].as_str().unwrap_or_default();
    let end = campaign["end_date"].as_str().unwrap_or_default();
    let date = date.to_string();
    if date.as_str() < start || date.as_str() > end {
        return Err(invalid(
            "Der gewünschte Beitragstag liegt außerhalb der Kampagne.",
        ));
    }
    if !campaign["platforms"]
        .as_array()
        .is_some_and(|a| a.iter().any(|p| p.as_str() == Some(target)))
    {
        return Err(invalid("Diese Plattform gehört nicht zur Kampagne."));
    }
    if campaign["status"] == "archived" {
        return Err(invalid(
            "Archivierte Kampagnen können nicht befüllt werden.",
        ));
    }
    time(clock)
}

async fn campaign_lock(tx: &mut Tx<'_>, org: Uuid, id: Uuid) -> HubResult<Value> {
    sqlx::query_scalar("SELECT to_jsonb(c) FROM campaigns c WHERE org_id=$1 AND id=$2 FOR UPDATE")
        .bind(org)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(HubError::NotFound)
}

async fn event(
    tx: &mut Tx<'_>,
    org: Uuid,
    actor: Option<Uuid>,
    action: &str,
    id: Uuid,
) -> HubResult<()> {
    sqlx::query("INSERT INTO audit_log(org_id,user_id,action,target_type,target_id) VALUES($1,$2,$3,'campaign',$4)")
        .bind(org).bind(actor).bind(action).bind(id).execute(&mut **tx).await?;
    Ok(())
}

impl Db {
    async fn campaign_begin(&self, org: Uuid, actor: Uuid) -> HubResult<Tx<'_>> {
        let mut tx = self.org_pool(org)?.begin().await?;
        let role: Option<String> = sqlx::query_scalar(
            "SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2 FOR SHARE",
        )
        .bind(org)
        .bind(actor)
        .fetch_optional(&mut *tx)
        .await?;
        if !matches!(role.as_deref(), Some("owner" | "editor")) {
            return Err(HubError::Forbidden);
        }
        Ok(tx)
    }

    pub async fn campaigns(&self, org: Uuid) -> HubResult<Value> {
        let values: Vec<Value> = sqlx::query_scalar(
            "SELECT to_jsonb(c) FROM campaigns c WHERE org_id=$1 ORDER BY start_date,id",
        )
        .bind(org)
        .fetch_all(&self.org_pool(org)?)
        .await?;
        Ok(json!(values))
    }

    pub async fn campaign(&self, org: Uuid, id: Uuid) -> HubResult<Value> {
        sqlx::query_scalar("SELECT to_jsonb(c) FROM campaigns c WHERE org_id=$1 AND id=$2")
            .bind(org)
            .bind(id)
            .fetch_optional(&self.org_pool(org)?)
            .await?
            .ok_or(HubError::NotFound)
    }

    pub async fn campaign_save(
        &self,
        org: Uuid,
        actor: Uuid,
        id: Option<Uuid>,
        input: CampaignInput,
    ) -> HubResult<Value> {
        validate_campaign(&input)?;
        let mut tx = self.campaign_begin(org, actor).await?;
        let value: Value = if let Some(id) = id {
            let current = campaign_lock(&mut tx, org, id).await?;
            revision(
                input.expected_revision,
                current["revision"].as_i64().unwrap(),
            )?;
            let incompatible: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM campaign_entries WHERE org_id=$1 AND campaign_id=$2 AND (desired_date<$3 OR desired_date>$4 OR NOT(platform=ANY($5))))")
                .bind(org).bind(id).bind(input.start_date).bind(input.end_date).bind(&input.platforms).fetch_one(&mut *tx).await?;
            if incompatible {
                return Err(invalid("Zeitraum oder Plattformen würden bestehende Beiträge ausschließen. Beiträge zuerst anpassen."));
            }
            sqlx::query_scalar("UPDATE campaigns c SET name=$3,start_date=$4,end_date=$5,time_zone=$6,platforms=$7,rules=$8,status=$9,revision=revision+1,updated_at=now() WHERE org_id=$1 AND id=$2 RETURNING to_jsonb(c)")
                .bind(org).bind(id).bind(input.name.trim()).bind(input.start_date).bind(input.end_date).bind(input.time_zone).bind(input.platforms).bind(input.rules).bind(input.status).fetch_one(&mut *tx).await?
        } else {
            sqlx::query_scalar("INSERT INTO campaigns AS c(org_id,name,start_date,end_date,time_zone,platforms,rules,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING to_jsonb(c)")
                .bind(org).bind(input.name.trim()).bind(input.start_date).bind(input.end_date).bind(input.time_zone).bind(input.platforms).bind(input.rules).bind(input.status).fetch_one(&mut *tx).await?
        };
        let id = serde_json::from_value(value["id"].clone())
            .map_err(|e| HubError::Internal(e.into()))?;
        event(&mut tx, org, Some(actor), "campaign.save", id).await?;
        tx.commit().await?;
        Ok(value)
    }

    pub async fn campaign_delete(
        &self,
        org: Uuid,
        actor: Uuid,
        id: Uuid,
        expected: Option<i64>,
    ) -> HubResult<()> {
        let mut tx = self.campaign_begin(org, actor).await?;
        let current = campaign_lock(&mut tx, org, id).await?;
        revision(expected, current["revision"].as_i64().unwrap())?;
        let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM campaign_generation_runs WHERE org_id=$1 AND campaign_id=$2 AND status IN ('queued','running'))")
            .bind(org).bind(id).fetch_one(&mut *tx).await?;
        if active {
            return Err(invalid(
                "Zuerst die laufende Entwurfserstellung beenden oder abbrechen.",
            ));
        }
        sqlx::query("DELETE FROM campaigns WHERE org_id=$1 AND id=$2")
            .bind(org)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        event(&mut tx, org, Some(actor), "campaign.delete", id).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn campaign_calendar(&self, org: Uuid, query: CalendarQuery) -> HubResult<Value> {
        if query
            .from
            .zip(query.to)
            .is_some_and(|(from, to)| from > to || (to - from).num_days() > 1096)
        {
            return Err(invalid("Ungültiger Kalenderzeitraum."));
        }
        if let Some(target) = &query.platform {
            platform(target)?;
        }
        if query
            .status
            .as_ref()
            .is_some_and(|s| !matches!(s.as_str(), "draft" | "ready"))
        {
            return Err(invalid("Unbekannter Beitragsstatus."));
        }
        let rows: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(e) || jsonb_build_object('campaign_name',c.name,'time_zone',c.time_zone,'content_type_key',ct.key,'content_data',co.data,'content_revision',co.revision,'content_status',co.status,'publish_at',co.publish_at,'unpublish_at',co.unpublish_at,'schedule_revision',co.schedule_revision,'status',CASE WHEN e.status='ready' AND e.reviewed_content_revision<>co.revision THEN 'draft' ELSE e.status END) FROM campaign_entries e JOIN campaigns c ON c.org_id=e.org_id AND c.id=e.campaign_id JOIN content_objects co ON co.org_id=e.org_id AND co.id=e.content_id JOIN content_types ct ON ct.org_id=co.org_id AND ct.id=co.content_type_id WHERE e.org_id=$1 AND ($2::date IS NULL OR e.desired_date >= $2) AND ($3::date IS NULL OR e.desired_date <= $3) AND ($4::uuid IS NULL OR e.campaign_id=$4) AND ($5::text IS NULL OR e.platform=$5) AND ($6::text IS NULL OR CASE WHEN e.status='ready' AND e.reviewed_content_revision<>co.revision THEN 'draft' ELSE e.status END=$6) ORDER BY e.desired_date,e.desired_time NULLS LAST,e.id LIMIT 10001")
            .bind(org).bind(query.from).bind(query.to).bind(query.campaign_id).bind(query.platform).bind(query.status).fetch_all(&self.org_pool(org)?).await?;
        if rows.len() > 10000 {
            return Err(invalid("Bitte den Kalenderzeitraum weiter eingrenzen."));
        }
        Ok(json!(rows))
    }

    pub async fn campaign_entry_save(
        &self,
        org: Uuid,
        actor: Uuid,
        campaign_id: Uuid,
        id: Option<Uuid>,
        input: CampaignEntryInput,
    ) -> HubResult<Value> {
        let mut tx = self.campaign_begin(org, actor).await?;
        let campaign = campaign_lock(&mut tx, org, campaign_id).await?;
        revision(
            Some(input.expected_campaign_revision),
            campaign["revision"].as_i64().unwrap(),
        )?;
        entry_matches(
            &campaign,
            input.desired_date,
            input.desired_time.as_deref(),
            &input.platform,
        )?;
        if !matches!(input.status.as_str(), "draft" | "ready") {
            return Err(invalid("Unbekannter Beitragsstatus."));
        }
        if let Some(id) = id {
            let old: Value = sqlx::query_scalar("SELECT to_jsonb(e) FROM campaign_entries e WHERE org_id=$1 AND campaign_id=$2 AND id=$3 FOR UPDATE")
                .bind(org).bind(campaign_id).bind(id).fetch_optional(&mut *tx).await?.ok_or(HubError::NotFound)?;
            revision(input.expected_revision, old["revision"].as_i64().unwrap())?;
            if old["content_id"] != json!(input.content_id) {
                return Err(invalid(
                    "Die Inhaltszuordnung eines Beitrags ist unveränderlich.",
                ));
            }
        }
        let content: Option<(i64,)> = sqlx::query_as("SELECT co.revision FROM content_objects co JOIN content_types ct ON ct.org_id=co.org_id AND ct.id=co.content_type_id WHERE co.org_id=$1 AND co.id=$2 FOR UPDATE OF co")
            .bind(org).bind(input.content_id).fetch_optional(&mut *tx).await?;
        revision(
            Some(input.content_revision),
            content.ok_or(HubError::NotFound)?.0,
        )?;
        let duplicate: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM campaign_entries WHERE org_id=$1 AND content_id=$2 AND (campaign_id<>$4 OR (platform=$5 AND ($3::uuid IS NULL OR id<>$3))))")
            .bind(org).bind(input.content_id).bind(id).bind(campaign_id).bind(&input.platform).fetch_one(&mut *tx).await?;
        if duplicate {
            return Err(invalid("Dieser Inhalt gehört bereits zu einer Kampagne."));
        }
        let row: Value = if let Some(id) = id {
            sqlx::query_scalar("UPDATE campaign_entries e SET desired_date=$4,desired_time=$5,platform=$6,status=$7,reviewed_content_revision=$8,revision=revision+1,updated_at=now() WHERE org_id=$1 AND campaign_id=$2 AND id=$3 RETURNING to_jsonb(e)")
                .bind(org).bind(campaign_id).bind(id).bind(input.desired_date).bind(input.desired_time).bind(input.platform).bind(input.status).bind(input.content_revision).fetch_one(&mut *tx).await?
        } else {
            sqlx::query_scalar("INSERT INTO campaign_entries AS e(org_id,campaign_id,content_id,desired_date,desired_time,platform,status,reviewed_content_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING to_jsonb(e)")
                .bind(org).bind(campaign_id).bind(input.content_id).bind(input.desired_date).bind(input.desired_time).bind(input.platform).bind(input.status).bind(input.content_revision).fetch_one(&mut *tx).await?
        };
        event(
            &mut tx,
            org,
            Some(actor),
            "campaign.entry.save",
            campaign_id,
        )
        .await?;
        tx.commit().await?;
        Ok(row)
    }

    pub async fn campaign_entry_delete(
        &self,
        org: Uuid,
        actor: Uuid,
        campaign: Uuid,
        id: Uuid,
        expected: Option<i64>,
    ) -> HubResult<()> {
        let mut tx = self.campaign_begin(org, actor).await?;
        campaign_lock(&mut tx, org, campaign).await?;
        let current: i64 = sqlx::query_scalar("SELECT revision FROM campaign_entries WHERE org_id=$1 AND campaign_id=$2 AND id=$3 FOR UPDATE")
            .bind(org).bind(campaign).bind(id).fetch_optional(&mut *tx).await?.ok_or(HubError::NotFound)?;
        revision(expected, current)?;
        sqlx::query("DELETE FROM campaign_entries WHERE org_id=$1 AND campaign_id=$2 AND id=$3")
            .bind(org)
            .bind(campaign)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        event(&mut tx, org, Some(actor), "campaign.entry.delete", campaign).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn campaign_run_create(
        &self,
        org: Uuid,
        actor: Uuid,
        campaign_id: Uuid,
        input: CampaignRunInput,
    ) -> HubResult<Value> {
        text(&input.idempotency_key, 128, true)?;
        text(&input.instructions, 8000, false)?;
        if !(1..=100).contains(&input.requested_count) {
            return Err(invalid("Pro Auftrag sind 1 bis 100 Entwürfe möglich."));
        }
        let mut tx = self.campaign_begin(org, actor).await?;
        let campaign = campaign_lock(&mut tx, org, campaign_id).await?;
        let request = serde_json::to_value(&input).map_err(|e| HubError::Internal(e.into()))?;
        let old: Option<Value> = sqlx::query_scalar("SELECT to_jsonb(r) FROM campaign_generation_runs r WHERE org_id=$1 AND campaign_id=$2 AND idempotency_key=$3")
            .bind(org).bind(campaign_id).bind(&input.idempotency_key).fetch_optional(&mut *tx).await?;
        if let Some(old) = old {
            if old["request"] != request {
                return Err(HubError::Conflict(old["revision"].as_i64().unwrap()));
            }
            return Ok(public_run(old));
        }
        revision(
            Some(input.expected_campaign_revision),
            campaign["revision"].as_i64().unwrap(),
        )?;
        if campaign["status"] == "archived" {
            return Err(invalid(
                "Archivierte Kampagnen können nicht befüllt werden.",
            ));
        }
        let entries: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(e) || jsonb_build_object('content_data',co.data,'content_revision',co.revision) FROM campaign_entries e JOIN content_objects co ON co.org_id=e.org_id AND co.id=e.content_id WHERE e.org_id=$1 AND e.campaign_id=$2 ORDER BY e.desired_date,e.id")
            .bind(org).bind(campaign_id).fetch_all(&mut *tx).await?;
        let sources = sources::published_sources(&mut tx, org, &campaign["rules"]).await?;
        let snapshot = json!({"campaign":campaign,"entries":entries,"sources":sources,"request":request,"output":"campaign_post","publication":"draft_only"});
        let row: Value = sqlx::query_scalar("INSERT INTO campaign_generation_runs AS r(org_id,campaign_id,created_by,idempotency_key,request,snapshot,campaign_revision) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING to_jsonb(r)")
            .bind(org).bind(campaign_id).bind(actor).bind(input.idempotency_key).bind(request).bind(snapshot).bind(input.expected_campaign_revision).fetch_one(&mut *tx).await?;
        event(
            &mut tx,
            org,
            Some(actor),
            "campaign.run.request",
            campaign_id,
        )
        .await?;
        tx.commit().await?;
        Ok(public_run(row))
    }

    pub async fn campaign_runs(&self, org: Uuid, campaign: Uuid) -> HubResult<Value> {
        self.campaign(org, campaign).await?;
        let rows: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(r) FROM campaign_generation_runs r WHERE org_id=$1 AND campaign_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100")
            .bind(org).bind(campaign).fetch_all(&self.org_pool(org)?).await?;
        Ok(Value::Array(rows.into_iter().map(public_run).collect()))
    }

    pub async fn campaign_run(&self, org: Uuid, campaign: Uuid, run: Uuid) -> HubResult<Value> {
        let row: Value = sqlx::query_scalar("SELECT to_jsonb(r) FROM campaign_generation_runs r WHERE org_id=$1 AND campaign_id=$2 AND id=$3")
            .bind(org).bind(campaign).bind(run).fetch_optional(&self.org_pool(org)?).await?.ok_or(HubError::NotFound)?;
        Ok(public_run(row))
    }

    pub async fn campaign_run_cancel(
        &self,
        org: Uuid,
        actor: Uuid,
        campaign: Uuid,
        run: Uuid,
        expected: Option<i64>,
    ) -> HubResult<Value> {
        let mut tx = self.campaign_begin(org, actor).await?;
        campaign_lock(&mut tx, org, campaign).await?;
        let row: Value = sqlx::query_scalar("SELECT to_jsonb(r) FROM campaign_generation_runs r WHERE org_id=$1 AND campaign_id=$2 AND id=$3 FOR UPDATE")
            .bind(org).bind(campaign).bind(run).fetch_optional(&mut *tx).await?.ok_or(HubError::NotFound)?;
        revision(expected, row["revision"].as_i64().unwrap())?;
        if !matches!(row["status"].as_str(), Some("queued" | "running")) {
            return Err(invalid("Dieser Auftrag ist bereits abgeschlossen."));
        }
        let row: Value = sqlx::query_scalar("UPDATE campaign_generation_runs r SET status='cancelled',revision=revision+1,updated_at=now() WHERE org_id=$1 AND campaign_id=$2 AND id=$3 RETURNING to_jsonb(r)")
            .bind(org).bind(campaign).bind(run).fetch_one(&mut *tx).await?;
        event(&mut tx, org, Some(actor), "campaign.run.cancel", campaign).await?;
        tx.commit().await?;
        Ok(public_run(row))
    }
}

fn public_run(mut row: Value) -> Value {
    row["requested_count"] = row["request"]["requested_count"].clone();
    if let Some(object) = row.as_object_mut() {
        for key in ["claim_key", "claim_nonce", "heartbeat_key", "result_hash"] {
            object.remove(key);
        }
    }
    row
}
