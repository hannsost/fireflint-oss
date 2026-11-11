use super::*;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use sitegraph_company_hub::validate_data;

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct BookingInput {
    pub resource_id: Uuid,
    pub title: String,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    #[serde(default)]
    pub cancelled: bool,
    pub expected_revision: Option<i64>,
}
#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct TranslationInput {
    pub locale: String,
    pub source_revision: i64,
    pub data: Value,
    pub expected_revision: Option<i64>,
}
#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MediaInput {
    pub title: String,
    #[serde(default)]
    pub alt_text: String,
    #[serde(default)]
    pub credit: String,
    #[serde(default)]
    pub license: String,
    #[serde(default)]
    pub collection: String,
    #[serde(default)]
    pub record_ids: Vec<Uuid>,
    pub expected_revision: Option<i64>,
}
impl Db {
    pub async fn hub_bookings(&self, org: Uuid, offset: i64) -> HubResult<Value> {
        self.hub_enabled(org, "booking").await?;
        let rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(b)||jsonb_build_object('resource_name',r.name,'timezone',r.data->>'timezone') FROM hub_bookings b JOIN hub_records r ON r.org_id=b.org_id AND r.id=b.resource_id WHERE b.org_id=$1 ORDER BY starts_at DESC,b.id LIMIT 100 OFFSET $2")
            .bind(org).bind(offset.clamp(0,100_000)).fetch_all(&self.org_pool(org)?).await?;
        Ok(json!(rows))
    }
    pub async fn hub_save_booking(
        &self,
        org: Uuid,
        actor: Uuid,
        id: Option<Uuid>,
        body: BookingInput,
    ) -> HubResult<Value> {
        if id.is_none() && body.expected_revision.is_some_and(|r| r != 0) {
            return Err(HubError::Conflict(0));
        }
        bounded(&body.title, 240, "Terminbezeichnung")?;
        if body.ends_at <= body.starts_at
            || body.ends_at.signed_duration_since(body.starts_at) > chrono::Duration::days(366)
        {
            return Err(HubError::Invalid(
                "Der Zeitraum muss positiv und höchstens 366 Tage lang sein.".into(),
            ));
        }
        let mut tx = self.hub_begin(org, actor, "booking", false).await?;
        let resource = super::records::active_record(&mut tx, org, body.resource_id).await?;
        if resource["kind"] != "resource" {
            return Err(HubError::Invalid(
                "Ein Termin benötigt eine Ressource.".into(),
            ));
        }
        let booking_id = id.unwrap_or_else(Uuid::new_v4);
        if let Some(id) = id {
            let revision: Option<i64> =
                sqlx::query_scalar("SELECT revision FROM hub_bookings WHERE org_id=$1 AND id=$2")
                    .bind(org)
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await?;
            check_revision(body.expected_revision, revision.ok_or(HubError::NotFound)?)?;
        }
        if !body.cancelled {
            let overlap:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM hub_bookings WHERE org_id=$1 AND resource_id=$2 AND id<>$3 AND status='confirmed' AND starts_at<$5 AND ends_at>$4)")
                .bind(org).bind(body.resource_id).bind(booking_id).bind(body.starts_at).bind(body.ends_at).fetch_one(&mut *tx).await?;
            if overlap {
                return Err(HubError::Invalid(
                    "Die Ressource ist in diesem Zeitraum bereits reserviert.".into(),
                ));
            }
        }
        let status = if body.cancelled {
            "cancelled"
        } else {
            "confirmed"
        };
        let value: Value = if id.is_some() {
            sqlx::query_scalar("UPDATE hub_bookings SET resource_id=$3,title=$4,starts_at=$5,ends_at=$6,status=$7,revision=revision+1,updated_at=now() WHERE org_id=$1 AND id=$2 RETURNING to_jsonb(hub_bookings)")
                .bind(org).bind(booking_id).bind(body.resource_id).bind(body.title.trim()).bind(body.starts_at).bind(body.ends_at).bind(status).fetch_one(&mut *tx).await?
        } else {
            sqlx::query_scalar("INSERT INTO hub_bookings(org_id,id,resource_id,title,starts_at,ends_at,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING to_jsonb(hub_bookings)")
                .bind(org).bind(booking_id).bind(body.resource_id).bind(body.title.trim()).bind(body.starts_at).bind(body.ends_at).bind(status).bind(actor).fetch_one(&mut *tx).await?
        };
        event(
            &mut tx,
            org,
            actor,
            "de.fireflint.booking.changed",
            &booking_id.to_string(),
            &json!({"status":status,"resource_id":body.resource_id,"revision":value["revision"]}),
        )
        .await?;
        tx.commit().await?;
        Ok(value)
    }
    pub async fn hub_translations(&self, org: Uuid, id: Uuid, offset: i64) -> HubResult<Value> {
        self.hub_enabled(org, "translations").await?;
        self.hub_record(org, id).await?;
        let rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(t)||jsonb_build_object('stale',t.source_revision<>r.revision) FROM hub_translations t JOIN hub_records r ON r.org_id=t.org_id AND r.id=t.record_id WHERE t.org_id=$1 AND t.record_id=$2 ORDER BY locale LIMIT 100 OFFSET $3")
            .bind(org).bind(id).bind(offset.max(0)).fetch_all(&self.org_pool(org)?).await?;
        Ok(json!(rows))
    }
    pub async fn hub_save_translation(
        &self,
        org: Uuid,
        actor: Uuid,
        id: Uuid,
        body: TranslationInput,
    ) -> HubResult<Value> {
        let locale = body.locale.trim().to_lowercase();
        if locale.len() > 35
            || !locale.split('-').enumerate().all(|(i, p)| {
                !p.is_empty()
                    && p.len() <= 8
                    && if i == 0 {
                        p.len() >= 2 && p.bytes().all(|b| b.is_ascii_alphabetic())
                    } else {
                        p.bytes().all(|b| b.is_ascii_alphanumeric())
                    }
            })
        {
            return Err(HubError::Invalid(
                "Ungültige Sprachkennung, zum Beispiel de oder en-gb.".into(),
            ));
        }
        let mut tx = self.hub_begin(org, actor, "translations", false).await?;
        let record = super::records::active_record(&mut tx, org, id).await?;
        check_revision(
            Some(body.source_revision),
            record["revision"].as_i64().unwrap(),
        )?;
        let kind =
            super::kinds::resolve_kind(&mut tx, org, record["kind"].as_str().unwrap_or("")).await?;
        let fields = kind
            .fields
            .into_iter()
            .filter(|f| ["text", "multiline"].contains(&f.kind.as_str()))
            .map(|mut f| {
                f.required = false;
                f
            })
            .collect::<Vec<_>>();
        validate_data(&fields, &body.data).map_err(HubError::Invalid)?;
        let revision: Option<i64> = sqlx::query_scalar(
            "SELECT revision FROM hub_translations WHERE org_id=$1 AND record_id=$2 AND locale=$3",
        )
        .bind(org)
        .bind(id)
        .bind(&locale)
        .fetch_optional(&mut *tx)
        .await?;
        check_revision(body.expected_revision, revision.unwrap_or(0))?;
        let value:Value=sqlx::query_scalar("INSERT INTO hub_translations(org_id,record_id,locale,source_revision,data,updated_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(org_id,record_id,locale) DO UPDATE SET source_revision=$4,data=$5,updated_by=$6,revision=hub_translations.revision+1,updated_at=now() RETURNING to_jsonb(hub_translations)")
            .bind(org).bind(id).bind(locale).bind(body.source_revision).bind(body.data).bind(actor).fetch_one(&mut *tx).await?;
        event(
            &mut tx,
            org,
            actor,
            "de.fireflint.translation.saved",
            &id.to_string(),
            &json!({"locale":value["locale"],"source_revision":body.source_revision}),
        )
        .await?;
        tx.commit().await?;
        Ok(value)
    }
    pub async fn hub_media(&self, org: Uuid, offset: i64) -> HubResult<Value> {
        self.hub_enabled(org, "media").await?;
        let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('asset_id',a.id,'filename',a.filename,'content_type',a.content_type,'byte_size',a.byte_size,'title',COALESCE(m.title,a.filename),'alt_text',COALESCE(m.alt_text,''),'credit',COALESCE(m.credit,''),'license',COALESCE(m.license,''),'collection',COALESCE(m.collection,''),'revision',COALESCE(m.revision,0),'record_ids',COALESCE((SELECT jsonb_agg(u.record_id) FROM hub_media_usage u WHERE u.org_id=a.org_id AND u.asset_id=a.id),'[]'::jsonb)) FROM assets a LEFT JOIN hub_media m ON m.org_id=a.org_id AND m.asset_id=a.id WHERE a.org_id=$1 ORDER BY a.created_at DESC,a.id LIMIT 100 OFFSET $2")
            .bind(org).bind(offset.max(0)).fetch_all(&self.org_pool(org)?).await?;
        Ok(json!(rows))
    }
    pub async fn hub_save_media(
        &self,
        org: Uuid,
        actor: Uuid,
        id: Uuid,
        body: MediaInput,
    ) -> HubResult<Value> {
        bounded(&body.title, 240, "Titel")?;
        if body.alt_text.len() > 2000
            || body.credit.len() > 2000
            || body.license.len() > 2000
            || body.collection.len() > 240
            || body.record_ids.len() > 100
        {
            return Err(HubError::Invalid(
                "Medienangaben sind zu umfangreich.".into(),
            ));
        }
        let mut tx = self.hub_begin(org, actor, "media", false).await?;
        let exists: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM assets WHERE org_id=$1 AND id=$2 FOR UPDATE")
                .bind(org)
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?;
        if exists.is_none() {
            return Err(HubError::NotFound);
        }
        let revision: Option<i64> =
            sqlx::query_scalar("SELECT revision FROM hub_media WHERE org_id=$1 AND asset_id=$2")
                .bind(org)
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?;
        check_revision(body.expected_revision, revision.unwrap_or(0))?;
        for record_id in &body.record_ids {
            super::records::active_record(&mut tx, org, *record_id).await?;
        }
        let value:Value=sqlx::query_scalar("INSERT INTO hub_media(org_id,asset_id,title,alt_text,credit,license,collection) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(asset_id) DO UPDATE SET title=$3,alt_text=$4,credit=$5,license=$6,collection=$7,revision=hub_media.revision+1,updated_at=now() RETURNING to_jsonb(hub_media)")
            .bind(org).bind(id).bind(body.title).bind(body.alt_text).bind(body.credit).bind(body.license).bind(body.collection).fetch_one(&mut *tx).await?;
        sqlx::query("DELETE FROM hub_media_usage WHERE org_id=$1 AND asset_id=$2")
            .bind(org)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        for record_id in &body.record_ids {
            sqlx::query("INSERT INTO hub_media_usage(org_id,asset_id,record_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING").bind(org).bind(id).bind(record_id).execute(&mut *tx).await?;
        }
        sqlx::query("INSERT INTO hub_media_versions(org_id,asset_id,revision,snapshot,actor_id) VALUES($1,$2,$3,$4,$5)")
            .bind(org).bind(id).bind(value["revision"].as_i64()).bind(json!({"metadata":value,"record_ids":body.record_ids})).bind(actor).execute(&mut *tx).await?;
        event(
            &mut tx,
            org,
            actor,
            "de.fireflint.media.annotated",
            &id.to_string(),
            &json!({"revision":value["revision"]}),
        )
        .await?;
        tx.commit().await?;
        Ok(value)
    }
}
