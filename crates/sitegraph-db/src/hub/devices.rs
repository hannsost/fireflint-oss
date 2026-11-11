//! Owner-maintained inventory. Human statements are never device telemetry.
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(default, deny_unknown_fields)]
pub struct DeviceDetails {
    pub manufacturer: String,
    pub model: String,
    pub serial_number: String,
    pub architecture: String,
    pub omarchy_version: String,
    pub kernel_version: String,
    pub notes: String,
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct DeviceInput {
    pub name: String,
    pub inventory_number: String,
    pub lifecycle: String,
    pub company_id: Option<Uuid>,
    pub contact_id: Option<Uuid>,
    pub location_id: Option<Uuid>,
    #[serde(default)]
    pub details: DeviceDetails,
    #[serde(default)]
    pub archived: bool,
    pub expected_revision: Option<i64>,
}

fn clean(value: &mut String, max: usize, multiline: bool) -> HubResult<()> {
    *value = value.trim().to_owned();
    if value.len() > max
        || value
            .chars()
            .any(|c| c.is_control() && !(multiline && matches!(c, '\n' | '\r' | '\t')))
    {
        return Err(HubError::Invalid(format!(
            "Inventarangaben dürfen höchstens {max} Bytes und keine unzulässigen Steuerzeichen enthalten."
        )));
    }
    Ok(())
}

fn validate(input: &mut DeviceInput) -> HubResult<()> {
    clean(&mut input.name, 240, false)?;
    bounded(&input.name, 240, "Gerätename")?;
    input.inventory_number = input.inventory_number.trim().to_ascii_uppercase();
    let number = input.inventory_number.as_bytes();
    if number.is_empty()
        || number.len() > 64
        || !number[0].is_ascii_alphanumeric()
        || !number
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err(HubError::Invalid(
            "Die Inventarnummer benötigt 1–64 Zeichen: A–Z, 0–9, Punkt, Unterstrich oder Bindestrich; zuerst einen Buchstaben oder eine Zahl.".into(),
        ));
    }
    if !matches!(
        input.lifecycle.as_str(),
        "in_stock" | "in_use" | "repair" | "retired"
    ) {
        return Err(HubError::Invalid("Unbekannter Gerätestatus.".into()));
    }
    let details = &mut input.details;
    for value in [
        &mut details.manufacturer,
        &mut details.model,
        &mut details.serial_number,
        &mut details.omarchy_version,
        &mut details.kernel_version,
    ] {
        clean(value, 160, false)?;
    }
    clean(&mut details.notes, 4096, true)?;
    if !matches!(details.architecture.as_str(), "" | "x86_64" | "aarch64") {
        return Err(HubError::Invalid("Unbekannte Gerätearchitektur.".into()));
    }
    Ok(())
}

fn public_device(mut value: Value) -> Value {
    value["platform"] = json!("omarchy");
    value["inventory_source"] = json!("manual");
    value["connection_status"] = json!("not_connected");
    value
}

impl Db {
    pub async fn hub_devices(
        &self,
        org: Uuid,
        query: &str,
        archived: bool,
        offset: i64,
    ) -> HubResult<Value> {
        self.hub_enabled(org, "devices").await?;
        if query.len() > 160
            || query.chars().any(char::is_control)
            || !(0..=100_000).contains(&offset)
        {
            return Err(HubError::Invalid(
                "Ungültige Suche oder Ergebnisseite.".into(),
            ));
        }
        // One SQL statement gives count and rows the same snapshot. Search is
        // literal, including percent and underscore, and never interpolated.
        let mut page: Value = sqlx::query_scalar(
            "WITH matching AS (SELECT * FROM hub_devices WHERE org_id=$1 AND archived=$2 AND ($3='' OR strpos(lower(concat_ws(' ',name,inventory_number,details->>'serial_number',details->>'model')),lower($3))>0)), page AS (SELECT * FROM matching ORDER BY inventory_number,id LIMIT 100 OFFSET $4) SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY inventory_number,id) FROM page p),'[]'::jsonb),'total',(SELECT count(*) FROM matching),'offset',$4,'limit',100)",
        ).bind(org).bind(archived).bind(query.trim()).bind(offset)
            .fetch_one(&self.org_pool(org)?).await?;
        if let Some(rows) = page["items"].as_array_mut() {
            for row in rows {
                *row = public_device(row.take());
            }
        }
        Ok(page)
    }

    pub async fn hub_device(&self, org: Uuid, id: Uuid) -> HubResult<Value> {
        self.hub_enabled(org, "devices").await?;
        let row: Value =
            sqlx::query_scalar("SELECT to_jsonb(d) FROM hub_devices d WHERE org_id=$1 AND id=$2")
                .bind(org)
                .bind(id)
                .fetch_optional(&self.org_pool(org)?)
                .await?
                .ok_or(HubError::NotFound)?;
        Ok(public_device(row))
    }

    pub async fn hub_device_history(&self, org: Uuid, id: Uuid, offset: i64) -> HubResult<Value> {
        self.hub_device(org, id).await?;
        if !(0..=100_000).contains(&offset) {
            return Err(HubError::Invalid("Ungültige Ergebnisseite.".into()));
        }
        let rows: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('revision',revision,'snapshot',snapshot,'actor_id',actor_id,'created_at',created_at) FROM hub_device_versions WHERE org_id=$1 AND device_id=$2 ORDER BY revision DESC LIMIT 100 OFFSET $3")
            .bind(org).bind(id).bind(offset).fetch_all(&self.org_pool(org)?).await?;
        Ok(json!(rows))
    }

    pub async fn hub_save_device(
        &self,
        org: Uuid,
        actor: Uuid,
        id: Uuid,
        mut input: DeviceInput,
    ) -> HubResult<Value> {
        let mut tx = self.hub_begin(org, actor, "devices", true).await?;
        validate(&mut input)?;
        let old: Option<Value> = sqlx::query_scalar(
            "SELECT to_jsonb(d) FROM hub_devices d WHERE org_id=$1 AND id=$2 FOR UPDATE",
        )
        .bind(org)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
        let revision = old
            .as_ref()
            .and_then(|r| r["revision"].as_i64())
            .unwrap_or(0);
        check_revision(input.expected_revision, revision)?;
        if old.is_none() {
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM hub_devices WHERE org_id=$1")
                .bind(org)
                .fetch_one(&mut *tx)
                .await?;
            if count >= 5000 {
                return Err(HubError::Invalid(
                    "Der Inventarbestand ist auf 5000 Geräte je Organisation begrenzt.".into(),
                ));
            }
        }
        for (key, target, kind) in [
            ("company_id", input.company_id, "company"),
            ("contact_id", input.contact_id, "contact"),
            ("location_id", input.location_id, "location"),
        ] {
            if let Some(target) = target {
                let unchanged =
                    old.as_ref().and_then(|r| r[key].as_str()) == Some(target.to_string().as_str());
                let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM hub_records WHERE org_id=$1 AND id=$2 AND kind=$3 AND (NOT archived OR $4))")
                    .bind(org).bind(target).bind(kind).bind(unchanged).fetch_one(&mut *tx).await?;
                if !valid {
                    return Err(HubError::Invalid("Eine Zuordnung verweist nicht auf einen aktiven Datensatz des passenden Typs in dieser Organisation.".into()));
                }
            }
        }
        let duplicate: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM hub_devices WHERE org_id=$1 AND inventory_number=$2 AND id<>$3)")
            .bind(org).bind(&input.inventory_number).bind(id).fetch_one(&mut *tx).await?;
        if duplicate {
            return Err(HubError::Invalid("Diese Inventarnummer ist in diesem Arbeitsbereich bereits vergeben, möglicherweise im Archiv.".into()));
        }
        let row: Value = sqlx::query_scalar("INSERT INTO hub_devices AS d(org_id,id,name,inventory_number,lifecycle,company_id,contact_id,location_id,details,archived,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) ON CONFLICT(org_id,id) DO UPDATE SET name=$3,inventory_number=$4,lifecycle=$5,company_id=$6,contact_id=$7,location_id=$8,details=$9,archived=$10,revision=d.revision+1,updated_by=$11,updated_at=now() RETURNING to_jsonb(d)")
            .bind(org).bind(id).bind(&input.name).bind(&input.inventory_number).bind(&input.lifecycle)
            .bind(input.company_id).bind(input.contact_id).bind(input.location_id)
            .bind(json!(input.details)).bind(input.archived).bind(actor).fetch_one(&mut *tx).await?;
        let row = public_device(row);
        sqlx::query("INSERT INTO hub_device_versions(org_id,device_id,revision,snapshot,actor_id) VALUES($1,$2,$3,$4,$5)")
            .bind(org).bind(id).bind(revision+1).bind(&row).bind(actor).execute(&mut *tx).await?;
        event(
            &mut tx,
            org,
            actor,
            if revision == 0 {
                "de.fireflint.device.created"
            } else {
                "de.fireflint.device.updated"
            },
            &id.to_string(),
            &json!({"revision":revision+1,"archived":input.archived}),
        )
        .await?;
        tx.commit().await?;
        Ok(row)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> DeviceInput {
        serde_json::from_value(json!({"name":" Laptop ","inventory_number":" pc-01 ","lifecycle":"in_use","expected_revision":0})).unwrap()
    }
    #[test]
    fn canonical_inventory_number_and_explicit_manual_state() {
        let mut value = input();
        assert!(validate(&mut value).is_ok());
        assert_eq!(value.name, "Laptop");
        assert_eq!(value.inventory_number, "PC-01");
        assert_eq!(
            public_device(json!({}))["connection_status"],
            "not_connected"
        );
    }
    #[test]
    fn rejects_invalid_identifiers_statuses_and_control_characters() {
        for invalid in ["", "-abc", "abc def", "ä", "a/b", "a\n"] {
            let mut value = input();
            value.inventory_number = invalid.into();
            if invalid == "a\n" {
                value.name = "Laptop\0".into();
            }
            assert!(validate(&mut value).is_err(), "{invalid:?}");
        }
        let mut value = input();
        value.lifecycle = "online".into();
        assert!(validate(&mut value).is_err());
        let mut value = input();
        value.details.architecture = "unsupported".into();
        assert!(validate(&mut value).is_err());
    }
    #[test]
    fn bounds_details_and_rejects_fake_telemetry() {
        let mut value = input();
        value.details.notes = "x".repeat(4097);
        assert!(validate(&mut value).is_err());
        value.details.notes = "Mehrere\nZeilen".into();
        assert!(validate(&mut value).is_ok());
        let mut body = json!({"name":"A","inventory_number":"A","lifecycle":"in_use","last_seen_at":"2026-09-22"});
        assert!(serde_json::from_value::<DeviceInput>(body.clone()).is_err());
        body.as_object_mut().unwrap().remove("last_seen_at");
        body["details"] = json!({"agent_token":"must-not-be-accepted"});
        assert!(serde_json::from_value::<DeviceInput>(body).is_err());
    }
}
