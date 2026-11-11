//! Explicit public brand/page inputs for one immutable campaign generation run.
//! The projection never serializes working-copy fields or private asset storage.
use super::*;
use std::collections::{BTreeMap, BTreeSet};

const MAX_SOURCE_ROWS: usize = 128;
const MAX_SOURCE_BYTES: usize = 128 * 1024;

pub(super) fn website_filter(rules: &Value) -> HubResult<Option<Uuid>> {
    rules
        .get("website_id")
        .map(|value| {
            value
                .as_str()
                .and_then(|value| Uuid::parse_str(value).ok())
                .ok_or_else(|| invalid("Die Website-Regel benötigt eine gültige Website-ID."))
        })
        .transpose()
}

fn public_fields(kind: &str, data: &Value, overrides: &Value) -> HubResult<Value> {
    let fields: &[(&str, usize)] = match kind {
        "brand_profile" => &[
            ("name", 200),
            ("tagline", 300),
            ("description", 3000),
            ("logo", 2048),
            ("primary_image", 2048),
            ("primary_image_alt", 500),
            ("brand_color", 7),
            ("instagram_name", 100),
            ("instagram_bio", 1000),
        ],
        "website_page" => &[
            ("path", 240),
            ("title", 200),
            ("heading", 300),
            ("body", 60000),
            ("hero_image", 2048),
            ("hero_alt", 500),
            ("instagram_text", 2200),
            ("instagram_image", 2048),
            ("instagram_image_alt", 500),
            ("instagram_image_source", 10000),
        ],
        _ => return Err(invalid("Unbekannte veröffentlichte Markenquelle.")),
    };
    let data = sitegraph_domain::merge_overrides(data, Some(overrides));
    let mut result = serde_json::Map::new();
    for (field, limit) in fields {
        if let Some(value) = data.get(*field) {
            let value = value
                .as_str()
                .ok_or_else(|| invalid("Marken- und Seitentexte müssen Zeichenketten sein."))?;
            if value.chars().count() > *limit
                || value
                    .chars()
                    .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
            {
                return Err(invalid(
                    "Eine Markenquelle überschreitet die zulässige Textlänge.",
                ));
            }
            result.insert((*field).to_owned(), json!(value));
        }
    }
    Ok(Value::Object(result))
}

fn asset_reference(org: Uuid, value: &str) -> Option<Uuid> {
    let path = value.strip_prefix(&format!("/assets/{org}/"))?;
    // No query, fragment, remote host, or filename suffix is interpreted as an
    // asset identity. The DB resolves every referenced UUID in this org only.
    Uuid::parse_str(path).ok()
}

pub(super) fn source_references(sources: &Value) -> Value {
    json!(sources["content"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|row| {
            json!({"content_id":row["content_id"],"content_type":row["content_type"],
            "publication_revision":row["publication_revision"],"website_id":row["website_id"]})
        })
        .collect::<Vec<_>>())
}

pub(super) async fn published_sources(
    tx: &mut Tx<'_>,
    org: Uuid,
    rules: &Value,
) -> HubResult<Value> {
    let website = website_filter(rules)?;
    if let Some(website) = website {
        let exists: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM websites WHERE org_id=$1 AND id=$2 FOR SHARE")
                .bind(org)
                .bind(website)
                .fetch_optional(&mut **tx)
                .await?;
        if exists.is_none() {
            return Err(HubError::NotFound);
        }
    }
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('content_id',co.id,'content_type',ct.key,'publication_revision',co.published_revision,'website_id',w.id,'data',co.published_data,'overrides',a.value->'overrides') \
         FROM content_objects co JOIN content_types ct ON ct.org_id=co.org_id AND ct.id=co.content_type_id \
         CROSS JOIN LATERAL jsonb_array_elements(co.published_channels) AS a(value) \
         JOIN websites w ON w.org_id=co.org_id AND w.id=(a.value->>'website_id')::uuid \
         WHERE co.org_id=$1 AND co.status='published' AND ct.key IN ('brand_profile','website_page') \
         AND ($2::uuid IS NULL OR w.id=$2) ORDER BY w.id,ct.key,co.id LIMIT 129 FOR SHARE OF co,w",
    )
    .bind(org)
    .bind(website)
    .fetch_all(&mut **tx)
    .await?;
    if rows.len() > MAX_SOURCE_ROWS {
        return Err(invalid(
            "Zu viele Markenquellen. Bitte die Kampagne einer Website zuordnen.",
        ));
    }
    let mut content = Vec::new();
    let mut counts = BTreeMap::<String, (usize, usize)>::new();
    let mut page_paths = BTreeSet::new();
    let mut referenced = BTreeSet::new();
    for row in rows {
        let kind = row["content_type"].as_str().unwrap_or_default();
        let data = public_fields(kind, &row["data"], &row["overrides"])?;
        let site = row["website_id"].to_string();
        let count = counts.entry(site.clone()).or_default();
        if kind == "brand_profile" {
            count.0 += 1;
        } else {
            count.1 += 1;
            if !page_paths.insert((site, data["path"].to_string())) {
                return Err(invalid(
                    "Mehrere veröffentlichte Quellen verwenden dieselbe Seitenadresse.",
                ));
            }
        }
        if count.0 > 1 || count.1 > 14 {
            return Err(invalid(
                "Pro Website sind ein Markenprofil und höchstens 14 Seitenquellen zulässig.",
            ));
        }
        for key in ["logo", "primary_image", "hero_image", "instagram_image"] {
            if let Some(asset) = data[key].as_str().and_then(|v| asset_reference(org, v)) {
                referenced.insert(asset);
            }
        }
        content.push(json!({"content_id":row["content_id"],"content_type":kind,
            "publication_revision":row["publication_revision"],"website_id":row["website_id"],"data":data}));
    }
    let ids: Vec<_> = referenced.into_iter().collect();
    let assets: Vec<Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('asset_id',id,'url','/assets/' || org_id::text || '/' || id::text,'filename',filename,'content_type',content_type,'byte_size',byte_size) \
         FROM assets WHERE org_id=$1 AND id=ANY($2) ORDER BY id FOR SHARE",
    )
    .bind(org)
    .bind(&ids)
    .fetch_all(&mut **tx)
    .await?;
    if assets.len() != ids.len()
        || assets.iter().any(|a| {
            !matches!(
                a["content_type"].as_str(),
                Some("image/jpeg" | "image/png" | "image/webp" | "image/avif")
            )
        })
    {
        return Err(invalid(
            "Eine veröffentlichte Bildquelle fehlt oder ist kein unterstütztes Bild.",
        ));
    }
    let result = json!({"website_id":website,"content":content,"assets":assets,
        "instructions":"Use the effective published sources for the identified website. Instagram text and image overrides are explicit source variants. Adapt text to the campaign and platform; never rewrite existing posts. Only listed asset_id values are permitted; prefer image/jpeg for Instagram."});
    if serde_json::to_vec(&result)
        .map_err(|e| HubError::Internal(e.into()))?
        .len()
        > MAX_SOURCE_BYTES
    {
        return Err(invalid("Markenquellen sind größer als 128 KiB. Bitte Quellen kürzen oder eine Website auswählen."));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projection_allowlists_fields_and_applies_explicit_site_overrides() {
        let data = public_fields(
            "brand_profile",
            &json!({"name":"Central", "internal_secret":"never"}),
            &json!({"name":"Local", "internal_secret":"also never"}),
        )
        .unwrap();
        assert_eq!(data, json!({"name":"Local"}));
        assert!(public_fields("website_page", &json!({"body":{}}), &Value::Null).is_err());
        assert!(public_fields(
            "website_page",
            &json!({"instagram_text":"a".repeat(2201)}),
            &Value::Null
        )
        .is_err());
    }

    #[test]
    fn only_explicit_local_current_org_image_ids_are_exposed() {
        let org = Uuid::new_v4();
        let image = Uuid::new_v4();
        assert_eq!(
            asset_reference(org, &format!("/assets/{org}/{image}")),
            Some(image)
        );
        assert_eq!(
            asset_reference(Uuid::new_v4(), &format!("/assets/{org}/{image}")),
            None
        );
        assert_eq!(
            asset_reference(org, &format!("/assets/{org}/{image}?token=x")),
            None
        );
        assert_eq!(
            asset_reference(org, &format!("https://elsewhere/assets/{org}/{image}")),
            None
        );
        assert!(website_filter(&json!({"website_id":"not-a-uuid"})).is_err());
    }

    #[tokio::test]
    #[ignore = "requires explicit isolated FIRE_FLINT_CAMPAIGN_TEST_DATABASE_URL on port15433/release DB"]
    async fn published_sources_are_scoped_immutable_and_checked_at_completion() {
        use sitegraph_domain::{ChannelAssignment, Role, Status};
        let url = std::env::var("FIRE_FLINT_CAMPAIGN_TEST_DATABASE_URL")
            .expect("explicit isolated database required");
        assert!(url.ends_with("/fireflint_release_test"));
        assert!(url.contains("@127.0.0.1:15433/") || url.contains("@localhost:15433/"));
        let db = Db::connect(&url).await.unwrap();
        let campaign_input = || CampaignInput {
            name: "Source campaign".into(),
            start_date: "2026-11-08".parse().unwrap(),
            end_date: "2026-12-31".parse().unwrap(),
            time_zone: "Europe/Berlin".into(),
            platforms: vec!["instagram".into()],
            rules: json!({"interval_days":1,"preferred_time":"18:00"}),
            status: "draft".into(),
            expected_revision: None,
        };
        // The fixture owner migrates its database. This branch must not reject
        // a newer migration installed by a parallel, isolated feature test.
        let ready: bool =
            sqlx::query_scalar("SELECT to_regclass('campaign_generation_runs') IS NOT NULL")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert!(ready, "release fixture must include campaign migration0031");
        let key = Uuid::new_v4();
        let org = db
            .create_organization("Brand sources fixture", &format!("brand-source-{key}"))
            .await
            .unwrap();
        let foreign = db
            .create_organization("Foreign brand fixture", &format!("brand-foreign-{key}"))
            .await
            .unwrap();
        let actor = db
            .create_user(
                &format!("brand-source-{key}@example.test"),
                "Source editor",
                "unusable-fixture-hash",
            )
            .await
            .unwrap();
        db.upsert_membership(org, actor, Role::Owner).await.unwrap();
        let a = db
            .create_website(org, "Website A", "a", None)
            .await
            .unwrap();
        let b = db
            .create_website(org, "Website B", "b", None)
            .await
            .unwrap();
        let other = db
            .create_website(foreign, "Foreign website", "foreign", None)
            .await
            .unwrap();
        let brand_type = db
            .create_content_type(org, "brand_profile", "Brand", &json!({"fields":[]}))
            .await
            .unwrap();
        let page_type = db
            .create_content_type(org, "website_page", "Pages", &json!({"fields":[]}))
            .await
            .unwrap();
        let image = db
            .create_asset(
                org,
                "source.jpg",
                "image/jpeg",
                123,
                "private-storage-key-never-serialized",
            )
            .await
            .unwrap();
        let unreferenced = db
            .create_asset(
                org,
                "unreferenced.jpg",
                "image/jpeg",
                50,
                "other-private-storage-key",
            )
            .await
            .unwrap();
        let brand_data = json!({"name":"Published brand","tagline":"Central tagline","internal_secret":"never-serialize-private-field"});
        let brand = db
            .create_content(org, brand_type.id, &brand_data)
            .await
            .unwrap();
        db.set_channel_assignments(
            org,
            brand.id,
            &[
                ChannelAssignment {
                    website_id: a.id,
                    overrides: Some(json!({"tagline":"Website A tagline"})),
                },
                ChannelAssignment {
                    website_id: b.id,
                    overrides: Some(json!({"tagline":"Website B tagline"})),
                },
            ],
        )
        .await
        .unwrap();
        let brand = db
            .set_status(org, brand.id, Status::Published)
            .await
            .unwrap()
            .unwrap();
        let page=db.create_content(org,page_type.id,&json!({"path":"/leistungen/","title":"Services","heading":"Our services",
            "body":"Published introduction","instagram_text":"Published platform text","instagram_image":format!("/assets/{org}/{}",image.id)})).await.unwrap();
        db.set_channel_assignments(
            org,
            page.id,
            &[ChannelAssignment {
                website_id: a.id,
                overrides: None,
            }],
        )
        .await
        .unwrap();
        db.set_status(org, page.id, Status::Published)
            .await
            .unwrap();
        let draft = db
            .create_content(
                org,
                page_type.id,
                &json!({"path":"/private/","body":"DO_NOT_LEAK_DRAFT"}),
            )
            .await
            .unwrap();
        db.set_channel_assignments(
            org,
            draft.id,
            &[ChannelAssignment {
                website_id: a.id,
                overrides: None,
            }],
        )
        .await
        .unwrap();
        let foreign_type = db
            .create_content_type(
                foreign,
                "brand_profile",
                "Foreign brand",
                &json!({"fields":[]}),
            )
            .await
            .unwrap();
        let foreign_content = db
            .create_content(
                foreign,
                foreign_type.id,
                &json!({"name":"DO_NOT_LEAK_OTHER_ORG"}),
            )
            .await
            .unwrap();
        db.set_channel_assignments(
            foreign,
            foreign_content.id,
            &[ChannelAssignment {
                website_id: other.id,
                overrides: None,
            }],
        )
        .await
        .unwrap();
        db.set_status(foreign, foreign_content.id, Status::Published)
            .await
            .unwrap();
        let mut definition = campaign_input();
        definition.rules["website_id"] = json!(a.id);
        let campaign = db
            .campaign_save(org, actor, None, definition)
            .await
            .unwrap();
        let campaign_id: Uuid = serde_json::from_value(campaign["id"].clone()).unwrap();
        let request = CampaignRunInput {
            expected_campaign_revision: 1,
            idempotency_key: format!("brand-once-{key}"),
            requested_count: 1,
            instructions: String::new(),
        };
        let run = db
            .campaign_run_create(org, actor, campaign_id, request.clone())
            .await
            .unwrap();
        let run_id: Uuid = serde_json::from_value(run["id"].clone()).unwrap();
        let snapshot = &run["snapshot"]["sources"];
        assert_eq!(snapshot["content"].as_array().unwrap().len(), 2);
        assert_eq!(snapshot["assets"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["assets"][0]["asset_id"], json!(image.id));
        let rendered = snapshot.to_string();
        for forbidden in [
            "never-serialize-private-field",
            "private-storage-key",
            "DO_NOT_LEAK_DRAFT",
            "DO_NOT_LEAK_OTHER_ORG",
            "Website B tagline",
            &unreferenced.id.to_string(),
        ] {
            assert!(!rendered.contains(forbidden), "{forbidden}");
        }
        assert!(rendered.contains("Website A tagline"));
        let grouped_campaign = db
            .campaign_save(org, actor, None, campaign_input())
            .await
            .unwrap();
        let grouped_campaign_id: Uuid =
            serde_json::from_value(grouped_campaign["id"].clone()).unwrap();
        let grouped = db
            .campaign_run_create(
                org,
                actor,
                grouped_campaign_id,
                CampaignRunInput {
                    expected_campaign_revision: 1,
                    idempotency_key: "grouped-websites".into(),
                    requested_count: 1,
                    instructions: String::new(),
                },
            )
            .await
            .unwrap();
        let grouped_rows = grouped["snapshot"]["sources"]["content"]
            .as_array()
            .unwrap();
        assert_eq!(grouped_rows.len(), 3);
        for (website, tagline) in [(a.id, "Website A tagline"), (b.id, "Website B tagline")] {
            let projected = grouped_rows
                .iter()
                .find(|r| r["content_id"] == json!(brand.id) && r["website_id"] == json!(website))
                .unwrap();
            assert_eq!(projected["data"]["tagline"], tagline);
        }
        let owner = Uuid::new_v4();
        db.campaign_machine_claim(
            run_id,
            CampaignClaim {
                owner_id: owner,
                idempotency_key: "claim-brand".into(),
            },
        )
        .await
        .unwrap();
        // Changing only the mutable working copy cannot alter approved input.
        db.update_content_data(
            org,
            brand.id,
            &json!({"name":"NEW_DRAFT_NOT_PUBLISHED"}),
            brand.revision,
        )
        .await
        .unwrap();
        db.set_channel_assignments(
            org,
            brand.id,
            &[ChannelAssignment {
                website_id: a.id,
                overrides: Some(json!({"tagline":"UNPUBLISHED_OVERRIDE"})),
            }],
        )
        .await
        .unwrap();
        let completion = CampaignCompletion {
            owner_id: owner,
            lease_version: 1,
            idempotency_key: "complete-brand".into(),
            drafts: vec![CampaignDraft {
                key: "source-draft".into(),
                desired_date: "2026-11-09".parse().unwrap(),
                desired_time: Some("18:00".into()),
                platform: "instagram".into(),
                title: "New sourced draft".into(),
                caption: "Explicit reviewed source".into(),
                asset_id: Some(image.id),
                alt_text: "Source image".into(),
            }],
        };
        let mut unlisted = completion.clone();
        unlisted.drafts[0].asset_id = Some(unreferenced.id);
        assert!(matches!(
            db.campaign_machine_complete(run_id, unlisted).await,
            Err(HubError::Invalid(_))
        ));
        let done = db
            .campaign_machine_complete(run_id, completion.clone())
            .await
            .unwrap();
        assert_eq!(done["source_revisions"].as_array().unwrap().len(), 2);
        let created_id: Uuid = serde_json::from_value(done["content_ids"][0].clone()).unwrap();
        let created = db.get_content(org, created_id).await.unwrap().unwrap();
        assert_eq!(created.data["source_revisions"], done["source_revisions"]);
        assert_eq!(created.status, Status::Draft);
        // A subsequent published revision invalidates a second pending run.
        let mut next = request.clone();
        next.idempotency_key = "brand-published-change".into();
        let next = db
            .campaign_run_create(org, actor, campaign_id, next)
            .await
            .unwrap();
        let next_id: Uuid = serde_json::from_value(next["id"].clone()).unwrap();
        db.campaign_machine_claim(
            next_id,
            CampaignClaim {
                owner_id: owner,
                idempotency_key: "claim-brand-next".into(),
            },
        )
        .await
        .unwrap();
        db.set_status(org, brand.id, Status::Published)
            .await
            .unwrap();
        let mut next_completion = completion.clone();
        next_completion.drafts[0].desired_date = "2026-11-10".parse().unwrap();
        assert!(matches!(
            db.campaign_machine_complete(next_id, next_completion.clone())
                .await,
            Err(HubError::Conflict(_))
        ));
        // Removing a published source invalidates the next snapshot as well.
        let mut last = request;
        last.idempotency_key = "brand-withdrawal".into();
        let last = db
            .campaign_run_create(org, actor, campaign_id, last)
            .await
            .unwrap();
        let last_id: Uuid = serde_json::from_value(last["id"].clone()).unwrap();
        db.campaign_machine_claim(
            last_id,
            CampaignClaim {
                owner_id: owner,
                idempotency_key: "claim-brand-last".into(),
            },
        )
        .await
        .unwrap();
        db.set_status(org, brand.id, Status::Draft).await.unwrap();
        assert!(matches!(
            db.campaign_machine_complete(last_id, next_completion).await,
            Err(HubError::Conflict(_))
        ));
        // A real foreign website ID is indistinguishable from a missing one.
        let mut foreign_definition = campaign_input();
        foreign_definition.rules["website_id"] = json!(other.id);
        let foreign_campaign = db
            .campaign_save(org, actor, None, foreign_definition)
            .await
            .unwrap();
        let foreign_campaign_id: Uuid =
            serde_json::from_value(foreign_campaign["id"].clone()).unwrap();
        assert!(matches!(
            db.campaign_run_create(
                org,
                actor,
                foreign_campaign_id,
                CampaignRunInput {
                    expected_campaign_revision: 1,
                    idempotency_key: "foreign-site".into(),
                    requested_count: 1,
                    instructions: String::new()
                }
            )
            .await,
            Err(HubError::NotFound)
        ));
        assert_eq!(
            db.campaign_machine_complete(run_id, completion.clone())
                .await
                .unwrap(),
            done
        );
        // Runs requested before this feature remain completable from their
        // original snapshot and do not acquire newly published context.
        let legacy_campaign = db
            .campaign_save(org, actor, None, campaign_input())
            .await
            .unwrap();
        let legacy_campaign_id: Uuid =
            serde_json::from_value(legacy_campaign["id"].clone()).unwrap();
        let legacy = db
            .campaign_run_create(
                org,
                actor,
                legacy_campaign_id,
                CampaignRunInput {
                    expected_campaign_revision: 1,
                    idempotency_key: "legacy-run".into(),
                    requested_count: 1,
                    instructions: String::new(),
                },
            )
            .await
            .unwrap();
        let legacy_id: Uuid = serde_json::from_value(legacy["id"].clone()).unwrap();
        sqlx::query("UPDATE campaign_generation_runs SET snapshot=snapshot-'sources' WHERE org_id=$1 AND id=$2")
            .bind(org).bind(legacy_id).execute(&db.pool).await.unwrap();
        db.campaign_machine_claim(
            legacy_id,
            CampaignClaim {
                owner_id: owner,
                idempotency_key: "claim-legacy".into(),
            },
        )
        .await
        .unwrap();
        let mut legacy_completion = completion;
        legacy_completion.drafts[0].asset_id = None;
        let legacy_done = db
            .campaign_machine_complete(legacy_id, legacy_completion)
            .await
            .unwrap();
        assert!(legacy_done.get("source_revisions").is_none());
        // Cleanup affects only unmistakably synthetic identities from this test.
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
    }
}
