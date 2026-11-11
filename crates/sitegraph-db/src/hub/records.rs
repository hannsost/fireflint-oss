use super::*;
use serde::{Deserialize, Serialize};
use sitegraph_company_hub::validate_data;

#[derive(Clone, Debug, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RecordInput {
    pub kind: String,
    pub name: String,
    pub data: Value,
    pub expected_revision: Option<i64>,
    #[serde(default)]
    pub archived: bool,
    pub source_id: Option<Uuid>,
    pub external_id: Option<String>,
}

fn validate_record(body: &RecordInput, kind: &sitegraph_company_hub::Kind) -> HubResult<String> {
    bounded(&body.name, 240, "Bezeichnung")?;
    if body.kind == "resource"
        && !body
            .data
            .get("timezone")
            .and_then(Value::as_str)
            .is_some_and(|v| v.parse::<chrono_tz::Tz>().is_ok())
    {
        return Err(HubError::Invalid(
            "Eine gültige IANA-Zeitzone ist erforderlich, zum Beispiel Europe/Berlin.".into(),
        ));
    }
    validate_data(&kind.fields, &body.data).map_err(HubError::Invalid)?;
    if body.source_id.is_some() != body.external_id.is_some() {
        return Err(HubError::Invalid(
            "Quelle und externe Kennung gehören zusammen.".into(),
        ));
    }
    if let Some(id) = &body.external_id {
        bounded(id, 240, "Externe Kennung")?;
    }
    Ok(kind.module.clone())
}

async fn record(tx: &mut Tx<'_>, org: Uuid, id: Uuid) -> HubResult<Value> {
    sqlx::query_scalar("SELECT to_jsonb(r) FROM hub_records r WHERE org_id=$1 AND id=$2")
        .bind(org)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(HubError::NotFound)
}

pub(super) async fn active_record(tx: &mut Tx<'_>, org: Uuid, id: Uuid) -> HubResult<Value> {
    let r = record(tx, org, id).await?;
    if r["archived"] == true {
        return Err(HubError::Invalid(
            "Der verknüpfte Datensatz ist archiviert.".into(),
        ));
    }
    let kind = super::kinds::resolve_kind(tx, org, r["kind"].as_str().unwrap_or("")).await?;
    enabled(tx, org, &kind.module).await?;
    Ok(r)
}

async fn snapshot(tx: &mut Tx<'_>, org: Uuid, actor: Uuid, id: Uuid) -> HubResult<Value> {
    let mut value = record(tx, org, id).await?;
    let links: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(l) FROM hub_links l WHERE org_id=$1 AND from_id=$2 ORDER BY id",
    )
    .bind(org)
    .bind(id)
    .fetch_all(&mut **tx)
    .await?;
    value["links"] = json!(links);
    sqlx::query("INSERT INTO hub_versions(org_id,record_id,revision,snapshot,actor_id) VALUES($1,$2,$3,$4,$5)")
        .bind(org).bind(id).bind(value["revision"].as_i64()).bind(&value).bind(actor).execute(&mut **tx).await?;
    Ok(value)
}

async fn changed_links(tx: &mut Tx<'_>, org: Uuid, actor: Uuid, id: Uuid) -> HubResult<()> {
    sqlx::query("UPDATE hub_records SET revision=revision+1,updated_at=now(),updated_by=$3 WHERE org_id=$1 AND id=$2").bind(org).bind(id).bind(actor).execute(&mut **tx).await?;
    snapshot(tx, org, actor, id).await?;
    Ok(())
}

async fn save(
    tx: &mut Tx<'_>,
    org: Uuid,
    actor: Uuid,
    id: Uuid,
    body: &RecordInput,
    create: bool,
) -> HubResult<Value> {
    let definition = super::kinds::resolve_kind(tx, org, &body.kind).await?;
    let key = validate_record(body, &definition)?;
    enabled(tx, org, &key).await?;
    if let Some(source) = body.source_id {
        enabled(tx, org, "integrations").await?;
        if active_record(tx, org, source).await?["kind"] != "source" {
            return Err(HubError::Invalid(
                "Die Herkunft muss eine Datenquelle sein.".into(),
            ));
        }
        let duplicate: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM hub_records WHERE org_id=$1 AND source_id=$2 AND external_id=$3 AND id<>$4)")
            .bind(org).bind(source).bind(&body.external_id).bind(id).fetch_one(&mut **tx).await?;
        if duplicate {
            return Err(HubError::Invalid(
                "Diese externe Kennung ist bereits zugeordnet.".into(),
            ));
        }
    }
    if create {
        if body.expected_revision.is_some_and(|v| v != 0) {
            return Err(HubError::Conflict(0));
        }
        sqlx::query("INSERT INTO hub_records(id,org_id,kind,name,data,created_by,updated_by,source_id,external_id,archived) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9)")
            .bind(id).bind(org).bind(&body.kind).bind(body.name.trim()).bind(&body.data).bind(actor).bind(body.source_id).bind(&body.external_id).bind(body.archived).execute(&mut **tx).await?;
    } else {
        let current = record(tx, org, id).await?;
        check_revision(
            body.expected_revision,
            current["revision"].as_i64().unwrap(),
        )?;
        if current["kind"] != body.kind {
            return Err(HubError::Invalid(
                "Der Datentyp kann nicht geändert werden.".into(),
            ));
        }
        if body.archived {
            let bookings: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM hub_bookings WHERE org_id=$1 AND resource_id=$2 AND status='confirmed' AND ends_at>now())")
                .bind(org).bind(id).fetch_one(&mut **tx).await?;
            if bookings {
                return Err(HubError::Invalid(
                    "Die Ressource besitzt noch aktive Termine.".into(),
                ));
            }
        }
        sqlx::query("UPDATE hub_records SET name=$3,data=$4,archived=$5,source_id=$6,external_id=$7,revision=revision+1,updated_by=$8,updated_at=now() WHERE org_id=$1 AND id=$2")
            .bind(org).bind(id).bind(body.name.trim()).bind(&body.data).bind(body.archived).bind(body.source_id).bind(&body.external_id).bind(actor).execute(&mut **tx).await?;
    }
    let value = snapshot(tx, org, actor, id).await?;
    event(
        tx,
        org,
        actor,
        if create {
            "de.fireflint.record.created"
        } else {
            "de.fireflint.record.updated"
        },
        &id.to_string(),
        &json!({"kind":body.kind,"revision":value["revision"]}),
    )
    .await?;
    Ok(value)
}

#[derive(Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ImportRow {
    pub external_id: String,
    pub name: String,
    pub kind: String,
    pub data: Value,
    pub expected_revision: Option<i64>,
}
#[derive(Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ImportInput {
    pub source_id: Uuid,
    pub request_key: Uuid,
    pub rows: Vec<ImportRow>,
}

impl Db {
    pub async fn hub_records(
        &self,
        org: Uuid,
        kind: &str,
        query: &str,
        archived: bool,
        offset: i64,
    ) -> HubResult<Value> {
        let mut tx = self.org_pool(org)?.begin().await?;
        let definition = super::kinds::resolve_kind(&mut tx, org, kind).await?;
        tx.commit().await?;
        self.hub_enabled(org, &definition.module).await?;
        if query.len() > 240 {
            return Err(HubError::Invalid("Suchtext ist zu lang.".into()));
        }
        let rows: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(r) FROM hub_records r WHERE org_id=$1 AND kind=$2 AND archived=$3 AND ($4='' OR strpos(lower(name),lower($4))>0 OR strpos(lower(data::text),lower($4))>0) ORDER BY updated_at DESC,id DESC LIMIT 100 OFFSET $5")
            .bind(org).bind(kind).bind(archived).bind(query).bind(offset.max(0)).fetch_all(&self.org_pool(org)?).await?;
        let total: i64 = sqlx::query_scalar("SELECT count(*) FROM hub_records WHERE org_id=$1 AND kind=$2 AND archived=$3 AND ($4='' OR strpos(lower(name),lower($4))>0 OR strpos(lower(data::text),lower($4))>0)")
            .bind(org).bind(kind).bind(archived).bind(query).fetch_one(&self.org_pool(org)?).await?;
        Ok(json!({"items":rows,"total":total,"offset":offset.max(0),"limit":100}))
    }

    pub async fn hub_record(&self, org: Uuid, id: Uuid) -> HubResult<Value> {
        let mut tx = self.org_pool(org)?.begin().await?;
        let mut value = record(&mut tx, org, id).await?;
        let kind =
            super::kinds::resolve_kind(&mut tx, org, value["kind"].as_str().unwrap_or("")).await?;
        enabled(&mut tx, org, &kind.module).await?;
        let links: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(l)||jsonb_build_object('from_name',f.name,'to_name',t.name,'from_revision',f.revision) FROM hub_links l JOIN hub_records f ON f.id=l.from_id AND f.org_id=l.org_id JOIN hub_records t ON t.id=l.to_id AND t.org_id=l.org_id WHERE l.org_id=$1 AND (l.from_id=$2 OR l.to_id=$2) ORDER BY l.created_at,l.id LIMIT 200")
            .bind(org).bind(id).fetch_all(&mut *tx).await?;
        value["links"] = json!(links);
        let total: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM hub_links WHERE org_id=$1 AND (from_id=$2 OR to_id=$2)",
        )
        .bind(org)
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        value["links_total"] = json!(total);
        value["links_limit"] = json!(200);
        value["links_offset"] = json!(0);
        Ok(value)
    }

    pub async fn hub_links(&self, org: Uuid, id: Uuid, offset: i64) -> HubResult<Value> {
        self.hub_record(org, id).await?;
        let rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(l)||jsonb_build_object('from_name',f.name,'to_name',t.name,'from_revision',f.revision) FROM hub_links l JOIN hub_records f ON f.id=l.from_id AND f.org_id=l.org_id JOIN hub_records t ON t.id=l.to_id AND t.org_id=l.org_id WHERE l.org_id=$1 AND (l.from_id=$2 OR l.to_id=$2) ORDER BY l.created_at,l.id LIMIT 200 OFFSET $3")
            .bind(org).bind(id).bind(offset.max(0)).fetch_all(&self.org_pool(org)?).await?;
        Ok(json!(rows))
    }

    /// One consistent, bounded read of explicit company relationships, both directions.
    pub async fn hub_company_dossier(&self, org: Uuid, id: Uuid, offset: i64) -> HubResult<Value> {
        let mut tx = self.org_pool(org)?.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .execute(&mut *tx)
            .await?;
        let company = record(&mut tx, org, id).await?;
        if company["kind"] != "company" {
            return Err(HubError::NotFound);
        }
        let modules: Vec<String> =
            sqlx::query_scalar("SELECT module_key FROM hub_modules WHERE org_id=$1 AND enabled")
                .bind(org)
                .fetch_all(&mut *tx)
                .await?;
        let mut allowed: Vec<String> = sitegraph_company_hub::kinds()
            .into_iter()
            .filter(|k| {
                module(&k.module).is_some_and(|m| m.required) || modules.contains(&k.module)
            })
            .map(|k| k.key)
            .collect();
        let custom: Vec<String> =
            sqlx::query_scalar("SELECT kind_key FROM hub_kinds WHERE org_id=$1")
                .bind(org)
                .fetch_all(&mut *tx)
                .await?;
        allowed.extend(custom);
        let scope = "FROM hub_records r WHERE r.org_id=$1 AND r.id<>$2 AND NOT r.archived AND r.kind=ANY($3) AND EXISTS(SELECT 1 FROM hub_links l WHERE l.org_id=$1 AND ((l.from_id=$2 AND l.to_id=r.id) OR (l.to_id=$2 AND l.from_id=r.id)))";
        let total: i64 = sqlx::query_scalar(&format!("SELECT count(*) {scope}"))
            .bind(org)
            .bind(id)
            .bind(&allowed)
            .fetch_one(&mut *tx)
            .await?;
        let items: Vec<Value> = sqlx::query_scalar(&format!(
            "SELECT to_jsonb(r) {scope} ORDER BY lower(r.name),r.id LIMIT 50 OFFSET $4"
        ))
        .bind(org)
        .bind(id)
        .bind(&allowed)
        .bind(offset.max(0))
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(json!({"company":company,"items":items,"total":total,"offset":offset.max(0),"limit":50}))
    }

    pub async fn hub_save_record(
        &self,
        org: Uuid,
        actor: Uuid,
        id: Option<Uuid>,
        body: RecordInput,
    ) -> HubResult<Value> {
        let mut tx = self.hub_begin(org, actor, "directory", false).await?;
        let value = save(
            &mut tx,
            org,
            actor,
            id.unwrap_or_else(Uuid::new_v4),
            &body,
            id.is_none(),
        )
        .await?;
        tx.commit().await?;
        Ok(value)
    }

    pub async fn hub_history(&self, org: Uuid, id: Uuid, offset: i64) -> HubResult<Value> {
        self.hub_record(org, id).await?;
        let rows: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(v) FROM hub_versions v WHERE org_id=$1 AND record_id=$2 ORDER BY revision DESC LIMIT 100 OFFSET $3")
            .bind(org).bind(id).bind(offset.max(0)).fetch_all(&self.org_pool(org)?).await?;
        Ok(json!(rows))
    }

    pub async fn hub_add_link(
        &self,
        org: Uuid,
        actor: Uuid,
        from: Uuid,
        to: Uuid,
        relation: &str,
        expected: Option<i64>,
    ) -> HubResult<Value> {
        if from == to || !sitegraph_company_hub::key_valid(relation) {
            return Err(HubError::Invalid("Ungültige Beziehung.".into()));
        }
        let mut tx = self.hub_begin(org, actor, "directory", false).await?;
        let src = active_record(&mut tx, org, from).await?;
        check_revision(expected, src["revision"].as_i64().unwrap())?;
        active_record(&mut tx, org, to).await?;
        let inserted=sqlx::query("INSERT INTO hub_links(org_id,from_id,to_id,relation) VALUES($1,$2,$3,$4) ON CONFLICT(org_id,from_id,to_id,relation) DO NOTHING")
            .bind(org).bind(from).bind(to).bind(relation).execute(&mut *tx).await?;
        if inserted.rows_affected() == 0 {
            return Err(HubError::Invalid("Diese Beziehung besteht bereits.".into()));
        }
        changed_links(&mut tx, org, actor, from).await?;
        event(
            &mut tx,
            org,
            actor,
            "de.fireflint.record.linked",
            &from.to_string(),
            &json!({"target":to,"relation":relation}),
        )
        .await?;
        tx.commit().await?;
        self.hub_record(org, from).await
    }

    pub async fn hub_remove_link(
        &self,
        org: Uuid,
        actor: Uuid,
        id: Uuid,
        expected: Option<i64>,
    ) -> HubResult<()> {
        let mut tx = self.hub_begin(org, actor, "directory", false).await?;
        let row: Option<(String, Uuid, Uuid)> = sqlx::query_as(
            "SELECT relation,from_id,to_id FROM hub_links WHERE org_id=$1 AND id=$2",
        )
        .bind(org)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
        let (relation, from, to) = row.ok_or(HubError::NotFound)?;
        let source = active_record(&mut tx, org, from).await?;
        check_revision(expected, source["revision"].as_i64().unwrap())?;
        active_record(&mut tx, org, to).await?;
        sqlx::query("DELETE FROM hub_links WHERE org_id=$1 AND id=$2")
            .bind(org)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        changed_links(&mut tx, org, actor, from).await?;
        event(
            &mut tx,
            org,
            actor,
            "de.fireflint.record.unlinked",
            &from.to_string(),
            &json!({"id":id,"target":to,"relation":relation}),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn hub_import(
        &self,
        org: Uuid,
        actor: Uuid,
        body: ImportInput,
        apply: bool,
    ) -> HubResult<Value> {
        let mut tx = self.hub_begin(org, actor, "integrations", false).await?;
        let result = import_in_tx(&mut tx, org, actor, &body, apply).await?;
        if apply {
            tx.commit().await?;
        }
        Ok(result)
    }
}

/// Shared by generic imports and saved connector plans under the caller's org lock.
pub(super) async fn import_in_tx(
    tx: &mut Tx<'_>,
    org: Uuid,
    actor: Uuid,
    body: &ImportInput,
    apply: bool,
) -> HubResult<Value> {
    use sha2::Digest;
    if body.rows.is_empty() || body.rows.len() > 100 {
        return Err(HubError::Invalid(
            "Ein Import umfasst 1 bis 100 Datensätze.".into(),
        ));
    }
    let hash = hex::encode(sha2::Sha256::digest(
        serde_json::to_vec(body).map_err(anyhow::Error::from)?,
    ));
    if let Some((old_hash, result)) = sqlx::query_as::<_, (String, Value)>(
        "SELECT request_hash,result FROM hub_imports WHERE org_id=$1 AND request_key=$2",
    )
    .bind(org)
    .bind(body.request_key)
    .fetch_optional(&mut **tx)
    .await?
    {
        if hash != old_hash {
            return Err(HubError::Invalid(
                "Dieser Importschlüssel gehört zu einer anderen Anfrage.".into(),
            ));
        }
        return Ok(result);
    }
    if active_record(tx, org, body.source_id).await?["kind"] != "source" {
        return Err(HubError::Invalid("Ungültige Datenquelle.".into()));
    }
    let mut seen = std::collections::HashSet::new();
    let mut preview = Vec::new();
    let mut planned = Vec::new();
    for row in &body.rows {
        if !seen.insert(&row.external_id) {
            return Err(HubError::Invalid(
                "Doppelte externe Kennung im Import.".into(),
            ));
        }
        let current: Option<(Uuid,i64,String)> = sqlx::query_as("SELECT id,revision,kind FROM hub_records WHERE org_id=$1 AND source_id=$2 AND external_id=$3")
            .bind(org).bind(body.source_id).bind(&row.external_id).fetch_optional(&mut **tx).await?;
        let input = RecordInput {
            kind: row.kind.clone(),
            name: row.name.clone(),
            data: row.data.clone(),
            source_id: Some(body.source_id),
            external_id: Some(row.external_id.clone()),
            expected_revision: row.expected_revision,
            archived: false,
        };
        let definition = super::kinds::resolve_kind(tx, org, &input.kind).await?;
        let key = validate_record(&input, &definition)?;
        enabled(tx, org, &key).await?;
        let revision = current.as_ref().map_or(0, |c| c.1);
        let conflict = row.expected_revision != Some(revision)
            || current.as_ref().is_some_and(|c| c.2 != row.kind);
        preview.push(json!({"external_id":row.external_id,"action":if current.is_some(){"update"}else{"create"},"current_revision":revision,"conflict":conflict,"name":row.name}));
        if apply && conflict {
            return Err(HubError::Conflict(revision));
        }
        planned.push((current.map(|c| c.0), input));
    }
    if !apply {
        return Ok(json!({"applied":false,"rows":preview}));
    }
    let mut results = Vec::new();
    for (id, input) in planned {
        results.push(
            save(
                tx,
                org,
                actor,
                id.unwrap_or_else(Uuid::new_v4),
                &input,
                id.is_none(),
            )
            .await?,
        );
    }
    let result = json!({"applied":true,"rows":results,"request_key":body.request_key});
    sqlx::query("INSERT INTO hub_imports(org_id,source_id,request_key,request_hash,result,created_by) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(org).bind(body.source_id).bind(body.request_key).bind(hash).bind(&result).bind(actor).execute(&mut **tx).await?;
    Ok(result)
}
