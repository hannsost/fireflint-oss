//! Deterministic, bounded quality scans. Source records are read-only here.
use super::*;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

const RECORD_CAP: usize = 1000;
const STEP_SIZE: usize = 100;
const PAGE_SIZE: i64 = 100;
const SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum QualityNormalization {
    Text,
    Identifier,
    Email,
    Phone,
}

#[derive(Clone, Debug, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct QualityDuplicateKey {
    pub fields: Vec<String>,
    pub normalization: QualityNormalization,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct QualityDefinition {
    /// Every group requires at least one present field (AND of OR groups).
    #[serde(default)]
    pub required_any: Vec<Vec<String>>,
    pub max_age_days: Option<i64>,
    #[serde(default)]
    pub duplicate_names: bool,
    #[serde(default)]
    pub duplicate_keys: Vec<QualityDuplicateKey>,
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct QualityRuleInput {
    pub definition: QualityDefinition,
    pub expected_revision: Option<i64>,
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct QualityScanInput {
    pub kind: String,
    pub expected_rule_revision: Option<i64>,
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct QualityRevisionInput {
    pub expected_revision: Option<i64>,
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct QualityReviewInput {
    pub expected_revision: Option<i64>,
    pub status: String,
    pub assignee_id: Option<Uuid>,
    pub comment: String,
}

fn validate_definition(
    definition: &QualityDefinition,
    kind: &sitegraph_company_hub::Kind,
) -> HubResult<()> {
    if definition.required_any.len() > 16
        || definition.duplicate_keys.len() > 8
        || definition
            .max_age_days
            .is_some_and(|v| !(1..=36500).contains(&v))
    {
        return Err(HubError::Invalid(
            "Maximal 16 Pflichtfeldgruppen, 8 Vergleichsschlüssel und ein Alter von 1 bis 36500 Tagen sind erlaubt.".into(),
        ));
    }
    for (fields, duplicate) in definition.required_any.iter().map(|f| (f, false)).chain(
        definition
            .duplicate_keys
            .iter()
            .map(|key| (&key.fields, true)),
    ) {
        let mut unique = HashSet::new();
        if fields.is_empty() || fields.len() > 8 {
            return Err(HubError::Invalid(
                "Eine Feldgruppe benötigt 1 bis 8 Felder.".into(),
            ));
        }
        for field in fields {
            let known = kind.fields.iter().any(|f| {
                f.key == *field && (!duplicate || !matches!(f.kind.as_str(), "boolean" | "number"))
            }) || (duplicate && field == "$external_id");
            if !known || !unique.insert(field) {
                return Err(HubError::Invalid(format!(
                    "Unbekanntes, ungeeignetes oder doppeltes Feld: {field}"
                )));
            }
        }
    }
    Ok(())
}

fn present(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::String(value) => !value.trim().is_empty(),
        Value::Array(value) => !value.is_empty(),
        Value::Object(value) => !value.is_empty(),
        _ => true, // false and numeric zero are supplied values.
    }
}

fn normalize(value: &str, mode: &QualityNormalization) -> String {
    match mode {
        QualityNormalization::Text => value
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase(),
        QualityNormalization::Identifier => value
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '-')
            .flat_map(char::to_lowercase)
            .collect(),
        QualityNormalization::Email => value.trim().to_lowercase(),
        // No country-code inference or extension stripping. Preserve every other character.
        QualityNormalization::Phone => value
            .chars()
            .filter(|c| !c.is_whitespace() && !matches!(c, '(' | ')' | '-'))
            .collect(),
    }
}

fn field_value<'a>(record: &'a Value, field: &str) -> &'a Value {
    if field == "$external_id" {
        &record["external_id"]
    } else {
        &record["data"][field]
    }
}

fn duplicate_key(record: &Value, key: &QualityDuplicateKey) -> Option<Vec<String>> {
    let mut values = Vec::new();
    for field in &key.fields {
        let normalized = normalize(field_value(record, field).as_str()?, &key.normalization);
        if normalized.is_empty() {
            return None;
        }
        values.push(normalized);
        if field == "$external_id" {
            // External IDs are only comparable inside the same source namespace.
            values.push(record["source_id"].as_str()?.to_string());
        }
    }
    Some(values)
}

fn reference(record: &Value, fields: &[String]) -> Value {
    let values: serde_json::Map<String, Value> = fields
        .iter()
        .map(|key| (key.clone(), field_value(record, key).clone()))
        .collect();
    json!({"id":record["id"],"kind":record["kind"],"name":record["name"],
        "revision":record["revision"],"updated_at":record["updated_at"],
        "source_id":record["source_id"],"external_id":record["external_id"],"values":values})
}

struct Finding {
    anchor_id: Uuid,
    rule_key: String,
    category: &'static str,
    explanation: String,
    evidence: Value,
    refs: Value,
}

fn evaluate(
    records: &[Value],
    definition: &QualityDefinition,
    at: DateTime<Utc>,
    start: usize,
    end: usize,
) -> HubResult<Vec<Finding>> {
    let mut findings = Vec::new();
    for record in &records[start..end] {
        let anchor_id = record["id"]
            .as_str()
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| HubError::Invalid("Ungültiger Prüfsnapshot.".into()))?;
        for (i, fields) in definition.required_any.iter().enumerate() {
            if !fields.iter().any(|f| present(field_value(record, f))) {
                findings.push(Finding { anchor_id, rule_key: format!("required:{i}"), category: "completeness",
                    explanation: format!("Mindestens eines dieser Felder muss befüllt sein: {}. Im geprüften Stand fehlt jedes davon.", fields.join(" oder ")),
                    evidence: json!({"fields":fields,"operator":"any_present"}), refs: json!([reference(record, fields)]) });
            }
        }
        if let Some(days) = definition.max_age_days {
            let updated = record["updated_at"]
                .as_str()
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .ok_or_else(|| HubError::Invalid("Ungültiger Prüfzeitpunkt.".into()))?;
            if updated < at - Duration::days(days) {
                findings.push(Finding { anchor_id, rule_key: "freshness".into(), category: "freshness",
                    explanation: format!("Der Datensatz wurde seit mehr als {days} Tagen nicht aktualisiert. Fachliche Aktualität bitte prüfen."),
                    evidence: json!({"max_age_days":days,"updated_at":record["updated_at"],"evaluated_at":at}), refs: json!([reference(record, &[])]) });
            }
        }
    }
    // One group per equal key, anchored at its first record. All snapshot records
    // participate, including records on other processing pages; no pair explosion.
    type DuplicateGroup<'a> = (
        String,
        Option<&'a QualityDuplicateKey>,
        BTreeMap<Vec<String>, Vec<usize>>,
    );
    let mut groups: Vec<DuplicateGroup<'_>> = Vec::new();
    if definition.duplicate_names {
        groups.push(("name".into(), None, BTreeMap::new()));
    }
    for (i, key) in definition.duplicate_keys.iter().enumerate() {
        groups.push((format!("duplicate:{i}"), Some(key), BTreeMap::new()));
    }
    for (rule_key, key, index) in &mut groups {
        for (i, record) in records.iter().enumerate() {
            let value = if let Some(key) = key {
                duplicate_key(record, key)
            } else {
                let name = normalize(
                    record["name"].as_str().unwrap_or(""),
                    &QualityNormalization::Text,
                );
                if name.is_empty() {
                    None
                } else {
                    Some(vec![name])
                }
            };
            if let Some(value) = value {
                index.entry(value).or_default().push(i);
            }
        }
        for (normalized, members) in index
            .iter()
            .filter(|(_, members)| members.len() > 1 && (start..end).contains(&members[0]))
        {
            let first = &records[members[0]];
            let anchor_id = first["id"]
                .as_str()
                .and_then(|s| s.parse().ok())
                .ok_or_else(|| HubError::Invalid("Ungültiger Prüfsnapshot.".into()))?;
            let fields = key.map_or(&[][..], |key| key.fields.as_slice());
            let refs: Vec<Value> = members
                .iter()
                .map(|i| reference(&records[*i], fields))
                .collect();
            findings.push(Finding { anchor_id, rule_key: rule_key.clone(), category: if key.is_some() { "duplicate_hint" } else { "name_hint" },
                explanation: if key.is_some() { format!("{} Datensätze besitzen denselben normalisierten Vergleichsschlüssel ({}). Das ist ein Dublettenhinweis, kein Identitätsnachweis.", members.len(), fields.join(" + ")) }
                    else { format!("{} Datensätze besitzen denselben normalisierten Namen. Gleiche Namen allein belegen keine Dublette.", members.len()) },
                evidence: json!({"normalized":normalized,"comparison":key,"match_count":members.len(),"identity_confirmed":false}), refs: json!(refs) });
        }
    }
    Ok(findings)
}

fn page_offset(offset: i64) -> HubResult<i64> {
    if !(0..=100_000).contains(&offset) {
        return Err(HubError::Invalid("Seitengrenze: 0 bis 100000.".into()));
    }
    Ok(offset)
}

async fn kind_revision(tx: &mut Tx<'_>, org: Uuid, kind: &str) -> HubResult<i64> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT revision FROM hub_kinds WHERE org_id=$1 AND kind_key=$2",
    )
    .bind(org)
    .bind(kind)
    .fetch_optional(&mut **tx)
    .await?
    .unwrap_or(0))
}

async fn check_kind(
    tx: &mut Tx<'_>,
    org: Uuid,
    kind: &str,
) -> HubResult<sitegraph_company_hub::Kind> {
    let definition = super::kinds::resolve_kind(tx, org, kind).await?;
    enabled(tx, org, &definition.module).await?;
    Ok(definition)
}

async fn rule(tx: &mut Tx<'_>, org: Uuid, kind: &str) -> HubResult<Value> {
    sqlx::query_scalar("SELECT to_jsonb(r) FROM hub_quality_rules r WHERE org_id=$1 AND kind=$2")
        .bind(org)
        .bind(kind)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(HubError::NotFound)
}

// Live staleness: rule/schema revisions, source-record revisions/archive/deletion,
// and additions/removals in this kind. Incomplete snapshots stay explicitly partial.
async fn scan(tx: &mut Tx<'_>, org: Uuid, id: Uuid) -> HubResult<Value> {
    let mut value: Value = sqlx::query_scalar("SELECT (to_jsonb(s)-'records') || jsonb_build_object('rules_stale',q.revision<>s.rule_revision,'schema_stale',COALESCE(k.revision,0)<>s.kind_revision,'records_stale',EXISTS(SELECT 1 FROM jsonb_array_elements(s.records) ref LEFT JOIN hub_records r ON r.org_id=s.org_id AND r.id=(ref->>'id')::uuid WHERE r.id IS NULL OR r.archived OR r.revision<>(ref->>'revision')::bigint) OR (SELECT count(*) FROM hub_records r WHERE r.org_id=s.org_id AND r.kind=s.kind AND NOT r.archived)<>s.total_records,'finding_count',(SELECT count(*) FROM hub_quality_findings f WHERE f.org_id=s.org_id AND f.scan_id=s.id)) FROM hub_quality_scans s JOIN hub_quality_rules q ON q.org_id=s.org_id AND q.kind=s.kind LEFT JOIN hub_kinds k ON k.org_id=s.org_id AND k.kind_key=s.kind WHERE s.org_id=$1 AND s.id=$2")
        .bind(org).bind(id).fetch_optional(&mut **tx).await?.ok_or(HubError::NotFound)?;
    check_kind(tx, org, value["kind"].as_str().unwrap_or("")).await?;
    let done = value["processed_records"] == value["captured_records"];
    let capped = value["captured_records"].as_i64().unwrap_or(0)
        < value["total_records"].as_i64().unwrap_or(0);
    value["stale"] = json!(
        value["rules_stale"] == true
            || value["schema_stale"] == true
            || value["records_stale"] == true
    );
    value["completed"] = json!(done);
    value["capped"] = json!(capped);
    value["complete"] = json!(done && !capped && value["stale"] == false);
    value["record_limit"] = json!(RECORD_CAP);
    value["step_size"] = json!(STEP_SIZE);
    Ok(value)
}

async fn finding(tx: &mut Tx<'_>, org: Uuid, id: Uuid) -> HubResult<Value> {
    let mut value: Value = sqlx::query_scalar(
        "SELECT to_jsonb(f) FROM hub_quality_findings f WHERE org_id=$1 AND id=$2",
    )
    .bind(org)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(HubError::NotFound)?;
    let scan_id = value["scan_id"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .ok_or(HubError::NotFound)?;
    let state = scan(tx, org, scan_id).await?;
    value["stale"] = state["stale"].clone();
    value["scan_complete"] = state["complete"].clone();
    value["scan_created_at"] = state["created_at"].clone();
    value["rule_revision"] = state["rule_revision"].clone();
    Ok(value)
}

async fn finding_version(tx: &mut Tx<'_>, org: Uuid, actor: Uuid, id: Uuid) -> HubResult<()> {
    sqlx::query("INSERT INTO hub_quality_finding_versions(org_id,finding_id,revision,snapshot,actor_id) SELECT org_id,id,revision,to_jsonb(f),$3 FROM hub_quality_findings f WHERE org_id=$1 AND id=$2")
        .bind(org).bind(id).bind(actor).execute(&mut **tx).await?;
    Ok(())
}

async fn step(
    tx: &mut Tx<'_>,
    org: Uuid,
    actor: Uuid,
    id: Uuid,
    current: &Value,
) -> HubResult<Value> {
    if current["stale"] == true {
        return Err(HubError::Conflict(
            current["revision"].as_i64().unwrap_or(0),
        ));
    }
    if current["completed"] == true {
        return Ok(current.clone());
    }
    let snapshot: Value =
        sqlx::query_scalar("SELECT records FROM hub_quality_scans WHERE org_id=$1 AND id=$2")
            .bind(org)
            .bind(id)
            .fetch_one(&mut **tx)
            .await?;
    let records = snapshot
        .as_array()
        .ok_or_else(|| HubError::Invalid("Ungültiger Prüfsnapshot.".into()))?;
    let definition: QualityDefinition =
        serde_json::from_value(current["definition"].clone()).map_err(anyhow::Error::from)?;
    let start = current["processed_records"].as_u64().unwrap_or(0) as usize;
    let end = (start + STEP_SIZE).min(records.len());
    let at: DateTime<Utc> =
        serde_json::from_value(current["created_at"].clone()).map_err(anyhow::Error::from)?;
    let findings = evaluate(records, &definition, at, start, end)?;
    // Bounded by 100 records * 17 unary rules + at most 9 duplicate groups per record.
    for f in findings {
        let finding_id: Uuid = sqlx::query_scalar("INSERT INTO hub_quality_findings(org_id,scan_id,rule_key,anchor_id,category,explanation,evidence,refs,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id")
            .bind(org).bind(id).bind(&f.rule_key).bind(f.anchor_id).bind(f.category).bind(&f.explanation).bind(&f.evidence).bind(&f.refs).bind(actor).fetch_one(&mut **tx).await?;
        finding_version(tx, org, actor, finding_id).await?;
    }
    sqlx::query("UPDATE hub_quality_scans SET processed_records=$3,revision=revision+1,finished_at=CASE WHEN $3=captured_records THEN now() ELSE NULL END WHERE org_id=$1 AND id=$2")
        .bind(org).bind(id).bind(end as i32).execute(&mut **tx).await?;
    event(
        tx,
        org,
        actor,
        "de.fireflint.quality.scanned",
        &id.to_string(),
        &json!({"processed_records":end,"captured_records":records.len()}),
    )
    .await?;
    scan(tx, org, id).await
}

impl Db {
    pub async fn hub_quality_rule(&self, org: Uuid, kind: &str) -> HubResult<Value> {
        let mut tx = self.org_pool(org)?.begin().await?;
        enabled(&mut tx, org, "quality").await?;
        check_kind(&mut tx, org, kind).await?;
        match rule(&mut tx, org, kind).await {
            Ok(value) => Ok(value),
            Err(HubError::NotFound) => Ok(
                json!({"org_id":org,"kind":kind,"revision":0,"definition":QualityDefinition::default()}),
            ),
            Err(error) => Err(error),
        }
    }

    pub async fn hub_quality_save_rule(
        &self,
        org: Uuid,
        actor: Uuid,
        kind: &str,
        body: QualityRuleInput,
    ) -> HubResult<Value> {
        let mut tx = self.hub_begin(org, actor, "quality", false).await?;
        let definition = check_kind(&mut tx, org, kind).await?;
        validate_definition(&body.definition, &definition)?;
        let current: Option<i64> = sqlx::query_scalar(
            "SELECT revision FROM hub_quality_rules WHERE org_id=$1 AND kind=$2",
        )
        .bind(org)
        .bind(kind)
        .fetch_optional(&mut *tx)
        .await?;
        check_revision(body.expected_revision, current.unwrap_or(0))?;
        let value = serde_json::to_value(&body.definition).map_err(anyhow::Error::from)?;
        sqlx::query("INSERT INTO hub_quality_rules(org_id,kind,definition,updated_by) VALUES($1,$2,$3,$4) ON CONFLICT(org_id,kind) DO UPDATE SET definition=$3,updated_by=$4,revision=hub_quality_rules.revision+1,updated_at=now()")
            .bind(org).bind(kind).bind(value).bind(actor).execute(&mut *tx).await?;
        let saved = rule(&mut tx, org, kind).await?;
        sqlx::query("INSERT INTO hub_quality_rule_versions(org_id,kind,revision,snapshot,actor_id) VALUES($1,$2,$3,$4,$5)")
            .bind(org).bind(kind).bind(current.unwrap_or(0)+1).bind(&saved).bind(actor).execute(&mut *tx).await?;
        event(
            &mut tx,
            org,
            actor,
            "de.fireflint.quality.rule.saved",
            kind,
            &json!({"revision":saved["revision"]}),
        )
        .await?;
        tx.commit().await?;
        Ok(saved)
    }

    pub async fn hub_quality_rule_history(
        &self,
        org: Uuid,
        kind: &str,
        offset: i64,
    ) -> HubResult<Value> {
        self.hub_quality_rule(org, kind).await?;
        let offset = page_offset(offset)?;
        let rows: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(v) FROM hub_quality_rule_versions v WHERE org_id=$1 AND kind=$2 ORDER BY revision DESC LIMIT 100 OFFSET $3")
            .bind(org).bind(kind).bind(offset).fetch_all(&self.org_pool(org)?).await?;
        let total: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM hub_quality_rule_versions WHERE org_id=$1 AND kind=$2",
        )
        .bind(org)
        .bind(kind)
        .fetch_one(&self.org_pool(org)?)
        .await?;
        Ok(json!({"items":rows,"offset":offset,"limit":PAGE_SIZE,"total":total}))
    }

    pub async fn hub_quality_start(
        &self,
        org: Uuid,
        actor: Uuid,
        body: QualityScanInput,
    ) -> HubResult<Value> {
        let mut tx = self.hub_begin(org, actor, "quality", false).await?;
        check_kind(&mut tx, org, &body.kind).await?;
        let config = rule(&mut tx, org, &body.kind).await?;
        check_revision(
            body.expected_rule_revision,
            config["revision"].as_i64().unwrap_or(0),
        )?;
        let definition: QualityDefinition =
            serde_json::from_value(config["definition"].clone()).map_err(anyhow::Error::from)?;
        if definition.required_any.is_empty()
            && definition.max_age_days.is_none()
            && !definition.duplicate_names
            && definition.duplicate_keys.is_empty()
        {
            return Err(HubError::Invalid(
                "Zuerst mindestens eine Prüfregel konfigurieren.".into(),
            ));
        }
        // Keep durable accumulation bounded. Existing scans/evidence are never deleted automatically.
        let existing: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM hub_quality_scans WHERE org_id=$1 AND kind=$2",
        )
        .bind(org)
        .bind(&body.kind)
        .fetch_one(&mut *tx)
        .await?;
        if existing >= 100 {
            return Err(HubError::Invalid("Die Grenze von 100 Prüfläufen je Datentyp ist erreicht. Ein Inhaber kann abgeschlossene Prüfläufe ausdrücklich entfernen.".into()));
        }
        let total: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM hub_records WHERE org_id=$1 AND kind=$2 AND NOT archived",
        )
        .bind(org)
        .bind(&body.kind)
        .fetch_one(&mut *tx)
        .await?;
        let records: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',id,'kind',kind,'name',name,'data',data,'revision',revision,'source_id',source_id,'external_id',external_id,'updated_at',updated_at) FROM hub_records WHERE org_id=$1 AND kind=$2 AND NOT archived ORDER BY id LIMIT 1000")
            .bind(org).bind(&body.kind).fetch_all(&mut *tx).await?;
        let snapshot = json!(records);
        if snapshot.to_string().len() > SNAPSHOT_BYTES {
            return Err(HubError::Invalid("Der Prüfsnapshot überschreitet 8 MiB; dieser Datentyp benötigt einen kleineren Datenumfang.".into()));
        }
        let schema_revision = kind_revision(&mut tx, org, &body.kind).await?;
        let id: Uuid = sqlx::query_scalar("INSERT INTO hub_quality_scans(org_id,kind,rule_revision,kind_revision,definition,records,total_records,captured_records,created_by,finished_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $8=0 THEN now() ELSE NULL END) RETURNING id")
            .bind(org).bind(&body.kind).bind(config["revision"].as_i64()).bind(schema_revision).bind(&config["definition"]).bind(snapshot).bind(total).bind(records.len() as i32).bind(actor).fetch_one(&mut *tx).await?;
        event(&mut tx, org, actor, "de.fireflint.quality.scan.started", &id.to_string(), &json!({"kind":body.kind,"rule_revision":config["revision"],"total_records":total,"captured_records":records.len()})).await?;
        let current = scan(&mut tx, org, id).await?;
        let value = step(&mut tx, org, actor, id, &current).await?;
        tx.commit().await?;
        Ok(value)
    }

    pub async fn hub_quality_step(
        &self,
        org: Uuid,
        actor: Uuid,
        id: Uuid,
        expected: Option<i64>,
    ) -> HubResult<Value> {
        let mut tx = self.hub_begin(org, actor, "quality", false).await?;
        let current = scan(&mut tx, org, id).await?;
        check_revision(expected, current["revision"].as_i64().unwrap_or(0))?;
        let value = step(&mut tx, org, actor, id, &current).await?;
        tx.commit().await?;
        Ok(value)
    }

    pub async fn hub_quality_scan(&self, org: Uuid, id: Uuid) -> HubResult<Value> {
        let mut tx = self.org_pool(org)?.begin().await?;
        enabled(&mut tx, org, "quality").await?;
        scan(&mut tx, org, id).await
    }

    pub async fn hub_quality_delete_scan(
        &self,
        org: Uuid,
        actor: Uuid,
        id: Uuid,
        expected: Option<i64>,
    ) -> HubResult<()> {
        let mut tx = self.hub_begin(org, actor, "quality", true).await?;
        let current = scan(&mut tx, org, id).await?;
        check_revision(expected, current["revision"].as_i64().unwrap_or(0))?;
        if current["completed"] != true && current["stale"] != true {
            return Err(HubError::Invalid(
                "Nur abgeschlossene oder veraltete Prüfläufe können entfernt werden.".into(),
            ));
        }
        let reviews: i64 = sqlx::query_scalar("SELECT count(*) FROM hub_quality_finding_versions v JOIN hub_quality_findings f ON f.org_id=v.org_id AND f.id=v.finding_id WHERE f.org_id=$1 AND f.scan_id=$2 AND v.revision>1")
            .bind(org).bind(id).fetch_one(&mut *tx).await?;
        sqlx::query("DELETE FROM hub_quality_scans WHERE org_id=$1 AND id=$2")
            .bind(org)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        event(&mut tx, org, actor, "de.fireflint.quality.scan.deleted", &id.to_string(),
            &json!({"kind":current["kind"],"revision":current["revision"],"rule_revision":current["rule_revision"],"findings_removed":current["finding_count"],"reviews_removed":reviews,"source_records_changed":0})).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn hub_quality_scans(&self, org: Uuid, kind: &str, offset: i64) -> HubResult<Value> {
        let mut tx = self.org_pool(org)?.begin().await?;
        enabled(&mut tx, org, "quality").await?;
        check_kind(&mut tx, org, kind).await?;
        let offset = page_offset(offset)?;
        // Only IDs are fetched here; snapshots are never returned by listing APIs.
        let ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM hub_quality_scans WHERE org_id=$1 AND kind=$2 ORDER BY created_at DESC,id DESC LIMIT 100 OFFSET $3").bind(org).bind(kind).bind(offset).fetch_all(&mut *tx).await?;
        let total: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM hub_quality_scans WHERE org_id=$1 AND kind=$2",
        )
        .bind(org)
        .bind(kind)
        .fetch_one(&mut *tx)
        .await?;
        let mut rows = Vec::new();
        for id in ids {
            rows.push(scan(&mut tx, org, id).await?);
        }
        Ok(json!({"items":rows,"offset":offset,"limit":PAGE_SIZE,"total":total}))
    }

    pub async fn hub_quality_findings(
        &self,
        org: Uuid,
        scan_id: Uuid,
        status: &str,
        offset: i64,
    ) -> HubResult<Value> {
        let mut tx = self.org_pool(org)?.begin().await?;
        enabled(&mut tx, org, "quality").await?;
        let current = scan(&mut tx, org, scan_id).await?;
        if !["", "open", "in_review", "resolved", "dismissed"].contains(&status) {
            return Err(HubError::Invalid("Unbekannter Prüfstatus.".into()));
        }
        let offset = page_offset(offset)?;
        let mut rows: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(f) FROM hub_quality_findings f WHERE org_id=$1 AND scan_id=$2 AND ($3='' OR status=$3) ORDER BY created_at,id LIMIT 100 OFFSET $4")
            .bind(org).bind(scan_id).bind(status).bind(offset).fetch_all(&mut *tx).await?;
        for row in &mut rows {
            row["stale"] = current["stale"].clone();
            row["scan_complete"] = current["complete"].clone();
            row["scan_created_at"] = current["created_at"].clone();
            row["rule_revision"] = current["rule_revision"].clone();
        }
        let total: i64 = sqlx::query_scalar("SELECT count(*) FROM hub_quality_findings WHERE org_id=$1 AND scan_id=$2 AND ($3='' OR status=$3)").bind(org).bind(scan_id).bind(status).fetch_one(&mut *tx).await?;
        Ok(json!({"items":rows,"offset":offset,"limit":PAGE_SIZE,"total":total,"scan":current}))
    }

    pub async fn hub_quality_finding(&self, org: Uuid, id: Uuid) -> HubResult<Value> {
        let mut tx = self.org_pool(org)?.begin().await?;
        enabled(&mut tx, org, "quality").await?;
        finding(&mut tx, org, id).await
    }

    pub async fn hub_quality_review(
        &self,
        org: Uuid,
        actor: Uuid,
        id: Uuid,
        body: QualityReviewInput,
    ) -> HubResult<Value> {
        let mut tx = self.hub_begin(org, actor, "quality", false).await?;
        let current = finding(&mut tx, org, id).await?;
        check_revision(
            body.expected_revision,
            current["revision"].as_i64().unwrap_or(0),
        )?;
        if current["stale"] == true {
            return Err(HubError::Conflict(
                current["revision"].as_i64().unwrap_or(0),
            ));
        }
        if !["open", "in_review", "resolved", "dismissed"].contains(&body.status.as_str()) {
            return Err(HubError::Invalid("Unbekannter Prüfstatus.".into()));
        }
        bounded(&body.comment, 4000, "Prüfkommentar")?;
        if body.status != "open" && body.assignee_id.is_none() {
            return Err(HubError::Invalid(
                "Für diesen Status muss eine zuständige Person gewählt werden.".into(),
            ));
        }
        if let Some(assignee) = body.assignee_id {
            let member: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM memberships WHERE org_id=$1 AND user_id=$2 AND role IN ('owner','editor'))").bind(org).bind(assignee).fetch_one(&mut *tx).await?;
            if !member {
                return Err(HubError::Invalid(
                    "Die zuständige Person benötigt Bearbeitungsrechte in diesem Arbeitsbereich."
                        .into(),
                ));
            }
        }
        sqlx::query("UPDATE hub_quality_findings SET status=$3,assignee_id=$4,comment=$5,revision=revision+1,updated_by=$6,updated_at=now() WHERE org_id=$1 AND id=$2")
            .bind(org).bind(id).bind(&body.status).bind(body.assignee_id).bind(body.comment.trim()).bind(actor).execute(&mut *tx).await?;
        finding_version(&mut tx, org, actor, id).await?;
        // New comments invalidate an owner's previously displayed deletion revision.
        sqlx::query("UPDATE hub_quality_scans SET revision=revision+1 WHERE org_id=$1 AND id=$2")
            .bind(org)
            .bind(
                current["scan_id"]
                    .as_str()
                    .and_then(|id| id.parse::<Uuid>().ok())
                    .ok_or(HubError::NotFound)?,
            )
            .execute(&mut *tx)
            .await?;
        let saved = finding(&mut tx, org, id).await?;
        event(&mut tx, org, actor, "de.fireflint.quality.reviewed", &id.to_string(), &json!({"revision":saved["revision"],"status":body.status,"assignee_id":body.assignee_id})).await?;
        tx.commit().await?;
        Ok(saved)
    }

    pub async fn hub_quality_finding_history(
        &self,
        org: Uuid,
        id: Uuid,
        offset: i64,
    ) -> HubResult<Value> {
        self.hub_quality_finding(org, id).await?;
        let offset = page_offset(offset)?;
        let rows: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(v) FROM hub_quality_finding_versions v WHERE org_id=$1 AND finding_id=$2 ORDER BY revision DESC LIMIT 100 OFFSET $3").bind(org).bind(id).bind(offset).fetch_all(&self.org_pool(org)?).await?;
        let total: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM hub_quality_finding_versions WHERE org_id=$1 AND finding_id=$2",
        )
        .bind(org)
        .bind(id)
        .fetch_one(&self.org_pool(org)?)
        .await?;
        Ok(json!({"items":rows,"offset":offset,"limit":PAGE_SIZE,"total":total}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conservative_normalization_preserves_meaningful_differences() {
        assert_eq!(
            normalize(" DE 123-45 ", &QualityNormalization::Identifier),
            "de12345"
        );
        assert_ne!(
            normalize("A/1", &QualityNormalization::Identifier),
            normalize("A1", &QualityNormalization::Identifier)
        );
        assert_ne!(
            normalize("Müller", &QualityNormalization::Text),
            normalize("Muller", &QualityNormalization::Text)
        );
        assert_eq!(
            normalize("Ada\n  Lovelace", &QualityNormalization::Text),
            "ada lovelace"
        );
        assert_ne!(
            normalize("030123", &QualityNormalization::Phone),
            normalize("+4930123", &QualityNormalization::Phone)
        );
        assert!(present(&json!(false)) && present(&json!(0)) && !present(&json!(" \n")));
    }

    #[test]
    fn name_groups_are_hints_and_cross_processing_pages() {
        let at = Utc::now();
        let records = vec![
            json!({"id":Uuid::new_v4(),"name":"Ada  Lovelace","data":{"email":"one@example.test"}}),
            json!({"id":Uuid::new_v4(),"name":"ADA Lovelace","data":{"email":"two@example.test"}}),
        ];
        let definition = QualityDefinition {
            duplicate_names: true,
            ..Default::default()
        };
        let first = evaluate(&records, &definition, at, 0, 1).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].category, "name_hint");
        assert_eq!(first[0].evidence["identity_confirmed"], false);
        assert_eq!(first[0].refs.as_array().unwrap().len(), 2);
        assert!(evaluate(&records, &definition, at, 1, 2)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn external_identifiers_are_scoped_and_empty_keys_do_not_match() {
        let key = QualityDuplicateKey {
            fields: vec!["$external_id".into()],
            normalization: QualityNormalization::Identifier,
        };
        let a = json!({"external_id":" AB-12 ","source_id":"one"});
        let b = json!({"external_id":"ab12","source_id":"two"});
        assert_ne!(duplicate_key(&a, &key), duplicate_key(&b, &key));
        assert!(duplicate_key(&json!({"external_id":"--","source_id":"one"}), &key).is_none());
    }
}
