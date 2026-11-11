//! Narrow durable Symphony contract. Symphony owns all work and retry decisions.
use super::*;
use chrono::{DateTime, Utc};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CampaignClaim {
    pub owner_id: Uuid,
    pub idempotency_key: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CampaignLease {
    pub owner_id: Uuid,
    pub lease_version: i64,
    pub idempotency_key: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CampaignDraft {
    pub key: String,
    pub desired_date: NaiveDate,
    pub desired_time: Option<String>,
    pub platform: String,
    pub title: String,
    pub caption: String,
    pub asset_id: Option<Uuid>,
    #[serde(default)]
    pub alt_text: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CampaignCompletion {
    pub owner_id: Uuid,
    pub lease_version: i64,
    pub idempotency_key: String,
    pub drafts: Vec<CampaignDraft>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CampaignFailure {
    pub owner_id: Uuid,
    pub lease_version: i64,
    pub idempotency_key: String,
    pub error_code: String,
}

fn identity(row: &Value) -> HubResult<(Uuid, Uuid, Uuid)> {
    let parse = |key: &str| {
        serde_json::from_value(row[key].clone()).map_err(|e| HubError::Internal(e.into()))
    };
    Ok((parse("org_id")?, parse("campaign_id")?, parse("id")?))
}

pub fn campaign_run_metadata(row: &Value) -> Value {
    json!({"run_id":row["id"],"org_id":row["org_id"],"campaign_id":row["campaign_id"],"campaign_revision":row["campaign_revision"],"revision":row["revision"],"status":row["status"],"lease_version":row["lease_version"],"lease_expires_at":row["lease_expires_at"]})
}

async fn locked_run(tx: &mut Tx<'_>, org: Uuid, campaign: Uuid, run: Uuid) -> HubResult<Value> {
    sqlx::query_scalar("SELECT to_jsonb(r) FROM campaign_generation_runs r WHERE org_id=$1 AND campaign_id=$2 AND id=$3 FOR UPDATE")
        .bind(org).bind(campaign).bind(run).fetch_optional(&mut **tx).await?.ok_or(HubError::NotFound)
}

fn valid_owner(row: &Value, owner: Uuid, lease_version: i64) -> HubResult<()> {
    if row["claim_owner"] != json!(owner)
        || row["lease_version"].as_i64() != Some(lease_version)
        || lease_version < 1
    {
        return Err(HubError::Forbidden);
    }
    Ok(())
}

fn active_lease(row: &Value) -> HubResult<()> {
    let expires: DateTime<Utc> =
        serde_json::from_value(row["lease_expires_at"].clone()).map_err(|_| HubError::Forbidden)?;
    if row["status"] != "running" || expires <= Utc::now() {
        return Err(HubError::Conflict(row["revision"].as_i64().unwrap_or(1)));
    }
    Ok(())
}

fn body_hash<T: Serialize>(body: &T) -> HubResult<String> {
    Ok(hex::encode(Sha256::digest(
        serde_json::to_vec(body).map_err(|e| HubError::Internal(e.into()))?,
    )))
}

fn prior_result(row: &Value, hash: &str) -> HubResult<Option<Value>> {
    if let Some(old) = row["result_hash"].as_str() {
        if old == hash {
            return Ok(Some(row["result"].clone()));
        }
        return Err(HubError::Conflict(row["revision"].as_i64().unwrap()));
    }
    Ok(None)
}

impl Db {
    /// Dispatch credential can inspect only these metadata, never customer text.
    pub async fn campaign_machine_queue(&self, active: bool) -> HubResult<Value> {
        // Persist expiry without requeueing or starting any execution. Symphony
        // can adopt a valid claimed job after restart; expired work stays blocked.
        sqlx::query("UPDATE campaign_generation_runs SET status='blocked',error='lease_expired',revision=revision+1,updated_at=now() WHERE status='running' AND lease_expires_at<=now()")
            .execute(&self.pool).await?;
        // The reviewed configuration is immutable. A queued request whose
        // campaign changed cannot become runnable by adopting a new revision.
        sqlx::query("UPDATE campaign_generation_runs r SET status='blocked',error='campaign_changed',revision=r.revision+1,updated_at=now() FROM campaigns c WHERE r.org_id=c.org_id AND r.campaign_id=c.id AND r.status='queued' AND r.campaign_revision<>c.revision")
            .execute(&self.pool).await?;
        let rows: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('run_id',id,'org_id',org_id,'campaign_id',campaign_id,'campaign_revision',campaign_revision,'revision',revision,'status',status,'lease_version',lease_version,'lease_expires_at',lease_expires_at) FROM campaign_generation_runs WHERE status='queued' OR ($1 AND status='running') ORDER BY created_at,id LIMIT 100")
            .bind(active).fetch_all(&self.pool).await?;
        Ok(json!(rows))
    }

    /// Internal lookup for authenticating the one-run capability. Callers must
    /// project metadata or prove the run capability before returning its text.
    pub async fn campaign_machine_run(&self, id: Uuid) -> HubResult<Value> {
        let org: Uuid =
            sqlx::query_scalar("SELECT org_id FROM campaign_generation_runs WHERE id=$1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?
                .ok_or(HubError::NotFound)?;
        sqlx::query_scalar(
            "SELECT to_jsonb(r) FROM campaign_generation_runs r WHERE org_id=$1 AND id=$2",
        )
        .bind(org)
        .bind(id)
        .fetch_optional(&self.org_pool(org)?)
        .await?
        .ok_or(HubError::NotFound)
    }

    pub async fn campaign_machine_claim(
        &self,
        run: Uuid,
        claim: CampaignClaim,
    ) -> HubResult<Value> {
        text(&claim.idempotency_key, 128, true)?;
        let found = self.campaign_machine_run(run).await?;
        let (org, campaign, run) = identity(&found)?;
        let mut tx = self.org_pool(org)?.begin().await?;
        let current_campaign = campaign_lock(&mut tx, org, campaign).await?;
        let row = locked_run(&mut tx, org, campaign, run).await?;
        if row["claim_owner"] == json!(claim.owner_id) && row["claim_key"] == claim.idempotency_key
        {
            // Stable replay includes the same nonce; expired or terminal leases
            // stay expired/terminal and are never silently rescheduled.
            return Ok(row);
        }
        if row["status"] != "queued" {
            return Err(HubError::Conflict(row["revision"].as_i64().unwrap()));
        }
        revision(
            row["campaign_revision"].as_i64(),
            current_campaign["revision"].as_i64().unwrap(),
        )?;
        let row: Value = sqlx::query_scalar("UPDATE campaign_generation_runs r SET status='running',claim_owner=$4,claim_key=$5,claim_nonce=$6,lease_version=lease_version+1,lease_expires_at=now()+interval '1 hour',revision=revision+1,updated_at=now() WHERE org_id=$1 AND campaign_id=$2 AND id=$3 RETURNING to_jsonb(r)")
            .bind(org).bind(campaign).bind(run).bind(claim.owner_id).bind(claim.idempotency_key).bind(Uuid::new_v4()).fetch_one(&mut *tx).await?;
        event(&mut tx, org, None, "campaign.run.claim", campaign).await?;
        tx.commit().await?;
        Ok(row)
    }

    pub async fn campaign_machine_heartbeat(
        &self,
        run: Uuid,
        input: CampaignLease,
    ) -> HubResult<Value> {
        text(&input.idempotency_key, 128, true)?;
        let found = self.campaign_machine_run(run).await?;
        let (org, campaign, run) = identity(&found)?;
        let mut tx = self.org_pool(org)?.begin().await?;
        let row = locked_run(&mut tx, org, campaign, run).await?;
        valid_owner(&row, input.owner_id, input.lease_version)?;
        active_lease(&row)?;
        if row["heartbeat_key"] == input.idempotency_key {
            return Ok(campaign_run_metadata(&row));
        }
        let row: Value = sqlx::query_scalar("UPDATE campaign_generation_runs r SET heartbeat_key=$4,lease_expires_at=now()+interval '1 hour',revision=revision+1,updated_at=now() WHERE org_id=$1 AND campaign_id=$2 AND id=$3 RETURNING to_jsonb(r)")
            .bind(org).bind(campaign).bind(run).bind(input.idempotency_key).fetch_one(&mut *tx).await?;
        tx.commit().await?;
        Ok(campaign_run_metadata(&row))
    }

    pub async fn campaign_machine_complete(
        &self,
        run: Uuid,
        input: CampaignCompletion,
    ) -> HubResult<Value> {
        text(&input.idempotency_key, 128, true)?;
        let hash = body_hash(&input)?;
        let found = self.campaign_machine_run(run).await?;
        let (org, campaign, run) = identity(&found)?;
        let mut tx = self.org_pool(org)?.begin().await?;
        let current_campaign = campaign_lock(&mut tx, org, campaign).await?;
        let row = locked_run(&mut tx, org, campaign, run).await?;
        valid_owner(&row, input.owner_id, input.lease_version)?;
        if let Some(result) = prior_result(&row, &hash)? {
            return Ok(result);
        }
        active_lease(&row)?;
        revision(
            row["campaign_revision"].as_i64(),
            current_campaign["revision"].as_i64().unwrap(),
        )?;
        if input.drafts.is_empty()
            || input.drafts.len() > row["request"]["requested_count"].as_u64().unwrap_or(0) as usize
        {
            return Err(invalid(
                "Die Zahl der erzeugten Entwürfe überschreitet den Auftrag oder ist leer.",
            ));
        }
        // Context revisions must still be the ones actually given to Symphony.
        // Existing drafts are never changed by generation.
        let context: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',e.id,'revision',e.revision,'content_revision',co.revision) FROM campaign_entries e JOIN content_objects co ON co.org_id=e.org_id AND co.id=e.content_id WHERE e.org_id=$1 AND e.campaign_id=$2 ORDER BY e.desired_date,e.id FOR SHARE OF co")
            .bind(org).bind(campaign).fetch_all(&mut *tx).await?;
        let expected: Vec<Value> = row["snapshot"]["entries"].as_array().unwrap().iter()
            .map(|e| json!({"id":e["id"],"revision":e["revision"],"content_revision":e["content_revision"]})).collect();
        if context != expected {
            return Err(HubError::Conflict(
                current_campaign["revision"].as_i64().unwrap(),
            ));
        }
        if let Some(expected_sources) = row["snapshot"].get("sources") {
            let current_sources =
                sources::published_sources(&mut tx, org, &current_campaign["rules"]).await?;
            if &current_sources != expected_sources {
                return Err(HubError::Conflict(
                    current_campaign["revision"].as_i64().unwrap(),
                ));
            }
        }
        let mut keys = std::collections::HashSet::new();
        let mut slots = std::collections::HashSet::new();
        for entry in row["snapshot"]["entries"].as_array().unwrap() {
            slots.insert((
                entry["desired_date"].as_str().unwrap().to_owned(),
                entry["platform"].as_str().unwrap().to_owned(),
            ));
        }
        for draft in &input.drafts {
            text(&draft.key, 128, true)?;
            text(&draft.title, 240, true)?;
            text(&draft.caption, 16000, true)?;
            text(&draft.alt_text, 2000, false)?;
            if !keys.insert(&draft.key) {
                return Err(invalid("Doppelte Ergebnisschlüssel."));
            }
            entry_matches(
                &current_campaign,
                draft.desired_date,
                draft.desired_time.as_deref(),
                &draft.platform,
            )?;
            validate_slot(&current_campaign, draft)?;
            if !slots.insert((draft.desired_date.to_string(), draft.platform.clone())) {
                return Err(invalid("Der gewünschte Plattformtag ist bereits belegt."));
            }
            if let Some(asset) = draft.asset_id {
                let exists: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM assets WHERE org_id=$1 AND id=$2)",
                )
                .bind(org)
                .bind(asset)
                .fetch_one(&mut *tx)
                .await?;
                if !exists {
                    return Err(HubError::NotFound);
                }
                if let Some(sources) = row["snapshot"].get("sources") {
                    if !sources["assets"]
                        .as_array()
                        .is_some_and(|assets| assets.iter().any(|a| a["asset_id"] == json!(asset)))
                    {
                        return Err(invalid(
                            "Dieses Bild gehört nicht zu den freigegebenen Auftragsquellen.",
                        ));
                    }
                }
            }
        }
        let schema = json!({"fields":[
            {"key":"title","label":"Titel","type":"text","required":true},
            {"key":"caption","label":"Beitragstext","type":"text","required":true},
            {"key":"image","label":"Bild","type":"media","required":false},
            {"key":"alt_text","label":"Bildbeschreibung","type":"text","required":false}
        ]});
        sqlx::query("INSERT INTO content_types(org_id,key,name,schema) VALUES($1,'campaign_post','Kampagnenbeitrag',$2) ON CONFLICT(org_id,key) DO NOTHING")
            .bind(org).bind(schema).execute(&mut *tx).await?;
        let (typ, schema): (Uuid, Value) = sqlx::query_as(
            "SELECT id,schema FROM content_types WHERE org_id=$1 AND key='campaign_post' FOR SHARE",
        )
        .bind(org)
        .fetch_one(&mut *tx)
        .await?;
        let mut content_ids = Vec::new();
        let mut entry_ids = Vec::new();
        for draft in input.drafts {
            let mut data =
                json!({"title":draft.title,"caption":draft.caption,"alt_text":draft.alt_text});
            if let Some(sources) = row["snapshot"].get("sources") {
                data["source_revisions"] = sources::source_references(sources);
            }
            if let Some(asset) = draft.asset_id {
                data["image"] = json!(format!("/assets/{org}/{asset}"));
                data["asset_id"] = json!(asset);
            }
            if !sitegraph_domain::validate(&schema, &data).is_empty() {
                return Err(invalid("Der Inhaltstyp campaign_post wurde geändert und akzeptiert das Ergebnis nicht."));
            }
            let content: Uuid = sqlx::query_scalar("INSERT INTO content_objects(org_id,content_type_id,status,data) VALUES($1,$2,'draft',$3) RETURNING id")
                .bind(org).bind(typ).bind(&data).fetch_one(&mut *tx).await?;
            crate::insert_version(&mut tx, content, &data).await?;
            let entry: Uuid = sqlx::query_scalar("INSERT INTO campaign_entries(org_id,campaign_id,content_id,desired_date,desired_time,platform,status,reviewed_content_revision) VALUES($1,$2,$3,$4,$5,$6,'draft',1) RETURNING id")
                .bind(org).bind(campaign).bind(content).bind(draft.desired_date).bind(draft.desired_time).bind(draft.platform).fetch_one(&mut *tx).await?;
            content_ids.push(content);
            entry_ids.push(entry);
        }
        let mut result = json!({"run_id":run,"status":"completed","content_ids":content_ids,"entry_ids":entry_ids});
        if let Some(sources) = row["snapshot"].get("sources") {
            result["source_revisions"] = sources::source_references(sources);
        }
        sqlx::query("UPDATE campaign_generation_runs SET status='completed',result_hash=$4,result=$5,revision=revision+1,updated_at=now() WHERE org_id=$1 AND campaign_id=$2 AND id=$3")
            .bind(org).bind(campaign).bind(run).bind(hash).bind(&result).execute(&mut *tx).await?;
        event(&mut tx, org, None, "campaign.run.complete", campaign).await?;
        tx.commit().await?;
        Ok(result)
    }

    pub async fn campaign_machine_fail(
        &self,
        run: Uuid,
        input: CampaignFailure,
    ) -> HubResult<Value> {
        text(&input.idempotency_key, 128, true)?;
        let status = match input.error_code.as_str() {
            "model_provider_unavailable"
            | "cluster_transport_unavailable"
            | "model_result_unknown" => "blocked",
            "campaign_generation_failed" | "invalid_result" => "failed",
            _ => return Err(invalid("Unbekannter Fehlercode.")),
        };
        let hash = body_hash(&input)?;
        let found = self.campaign_machine_run(run).await?;
        let (org, campaign, run) = identity(&found)?;
        let mut tx = self.org_pool(org)?.begin().await?;
        let row = locked_run(&mut tx, org, campaign, run).await?;
        valid_owner(&row, input.owner_id, input.lease_version)?;
        if let Some(result) = prior_result(&row, &hash)? {
            return Ok(result);
        }
        active_lease(&row)?;
        let result = json!({"run_id":run,"status":status,"error_code":input.error_code});
        sqlx::query("UPDATE campaign_generation_runs SET status=$4,error=$5,result_hash=$6,result=$7,revision=revision+1,updated_at=now() WHERE org_id=$1 AND campaign_id=$2 AND id=$3")
            .bind(org).bind(campaign).bind(run).bind(status).bind(input.error_code).bind(hash).bind(&result).execute(&mut *tx).await?;
        event(&mut tx, org, None, "campaign.run.fail", campaign).await?;
        tx.commit().await?;
        Ok(result)
    }
}

fn validate_slot(campaign: &Value, draft: &CampaignDraft) -> HubResult<()> {
    let rules = &campaign["rules"];
    let date = json!(draft.desired_date);
    if rules["excluded_dates"]
        .as_array()
        .is_some_and(|dates| dates.contains(&date))
        || rules["included_dates"]
            .as_array()
            .is_some_and(|dates| !dates.contains(&date))
    {
        return Err(invalid("Der Ergebnistag widerspricht den Kampagnenregeln."));
    }
    if let Some(interval) = rules["interval_days"].as_u64() {
        let start: NaiveDate = serde_json::from_value(campaign["start_date"].clone())
            .map_err(|e| HubError::Internal(e.into()))?;
        if interval == 0 || (draft.desired_date - start).num_days() % interval as i64 != 0 {
            return Err(invalid(
                "Der Ergebnistag entspricht nicht dem Beitragsabstand.",
            ));
        }
    }
    if let Some(clock) = rules["preferred_time"].as_str() {
        if draft.desired_time.as_deref() != Some(clock) {
            return Err(invalid(
                "Die Ergebnisuhrzeit entspricht nicht der Kampagnenregel.",
            ));
        }
    }
    Ok(())
}
