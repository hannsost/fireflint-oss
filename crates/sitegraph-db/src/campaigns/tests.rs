use super::*;
use sitegraph_domain::Role;

fn input() -> CampaignInput {
    CampaignInput {
        name: "Campaign fixture".into(),
        start_date: "2026-11-08".parse().unwrap(),
        end_date: "2026-12-31".parse().unwrap(),
        time_zone: "Europe/Berlin".into(),
        platforms: vec!["instagram".into(), "facebook".into()],
        rules: json!({"interval_days":1,"preferred_time":"18:00"}),
        status: "draft".into(),
        expected_revision: None,
    }
}

fn id(row: &Value) -> Uuid {
    serde_json::from_value(row["id"].clone()).unwrap()
}

#[test]
fn dates_zones_rules_and_revisions_are_validated() {
    let base = input();
    assert!(validate_campaign(&base).is_ok());
    for field in ["date", "zone", "platform", "rule", "included", "time"] {
        let mut bad = base.clone();
        match field {
            "date" => bad.end_date = "2026-11-07".parse().unwrap(),
            "zone" => bad.time_zone = "not/a-zone".into(),
            "platform" => bad.platforms.push("Instagram".into()),
            "rule" => bad.rules["interval_days"] = json!(0),
            "included" => bad.rules["included_dates"] = json!(["2027-01-01"]),
            _ => bad.rules["preferred_time"] = json!("24:00"),
        }
        assert!(validate_campaign(&bad).is_err(), "{field}");
    }
    assert!(matches!(revision(None, 1), Err(HubError::RevisionRequired)));
    assert!(matches!(revision(Some(1), 2), Err(HubError::Conflict(2))));
    let campaign = serde_json::to_value(base).unwrap();
    assert!(entry_matches(
        &campaign,
        "2026-11-08".parse().unwrap(),
        Some("18:00"),
        "instagram"
    )
    .is_ok());
    assert!(entry_matches(&campaign, "2026-11-07".parse().unwrap(), None, "instagram").is_err());
    assert!(entry_matches(&campaign, "2026-11-08".parse().unwrap(), None, "foreign").is_err());
}

#[tokio::test]
#[ignore = "requires explicit isolated FIRE_FLINT_CAMPAIGN_TEST_DATABASE_URL on port15433/release DB"]
async fn tenant_revisions_concurrent_campaigns_and_durable_worker_results() {
    let url = std::env::var("FIRE_FLINT_CAMPAIGN_TEST_DATABASE_URL")
        .expect("explicit isolated database required");
    assert!(url.ends_with("/fireflint_release_test"));
    assert!(url.contains("@127.0.0.1:15433/") || url.contains("@localhost:15433/"));
    let db = Db::connect(&url).await.unwrap();
    db.migrate().await.unwrap();
    let key = Uuid::new_v4();
    let org = db
        .create_organization("Campaign A", &format!("campaign-a-{key}"))
        .await
        .unwrap();
    let foreign = db
        .create_organization("Campaign B", &format!("campaign-b-{key}"))
        .await
        .unwrap();
    let actor = db
        .create_user(
            &format!("campaign-{key}@example.test"),
            "Campaign editor",
            "unusable-test-hash",
        )
        .await
        .unwrap();
    let viewer = db
        .create_user(
            &format!("campaign-view-{key}@example.test"),
            "Campaign viewer",
            "unusable-test-hash",
        )
        .await
        .unwrap();
    db.upsert_membership(org, actor, Role::Editor)
        .await
        .unwrap();
    db.upsert_membership(org, viewer, Role::Viewer)
        .await
        .unwrap();
    assert!(matches!(
        db.campaign_save(org, viewer, None, input()).await,
        Err(HubError::Forbidden)
    ));
    assert!(matches!(
        db.campaign_save(foreign, actor, None, input()).await,
        Err(HubError::Forbidden)
    ));
    let (a, b) = tokio::join!(
        db.campaign_save(org, actor, None, input()),
        db.campaign_save(org, actor, None, input())
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_ne!(id(&a), id(&b));
    assert!(matches!(
        db.campaign(foreign, id(&a)).await,
        Err(HubError::NotFound)
    ));
    let typ = db
        .create_content_type(
            org,
            "campaign_fixture",
            "Campaign fixture",
            &json!({"fields":[]}),
        )
        .await
        .unwrap();
    let content = db
        .create_content(
            org,
            typ.id,
            &json!({"title":"Existing","image":"preserved"}),
        )
        .await
        .unwrap();
    let link = CampaignEntryInput {
        content_id: content.id,
        content_revision: 1,
        expected_campaign_revision: 1,
        desired_date: "2026-11-08".parse().unwrap(),
        desired_time: Some("18:00".into()),
        platform: "instagram".into(),
        status: "ready".into(),
        expected_revision: None,
    };
    let entry = db
        .campaign_entry_save(org, actor, id(&a), None, link.clone())
        .await
        .unwrap();
    let mut other = link.clone();
    other.platform = "facebook".into();
    db.campaign_entry_save(org, actor, id(&a), None, other.clone())
        .await
        .unwrap();
    assert!(matches!(
        db.campaign_entry_save(org, actor, id(&b), None, other)
            .await,
        Err(HubError::Invalid(_))
    ));
    assert!(matches!(
        db.campaign_entry_save(org, actor, id(&a), Some(id(&entry)), link.clone())
            .await,
        Err(HubError::RevisionRequired)
    ));
    let foreign_type = db
        .create_content_type(
            foreign,
            "campaign_fixture",
            "Foreign fixture",
            &json!({"fields":[]}),
        )
        .await
        .unwrap();
    let foreign_content = db
        .create_content(foreign, foreign_type.id, &json!({}))
        .await
        .unwrap();
    let mut foreign_link = link.clone();
    foreign_link.content_id = foreign_content.id;
    assert!(matches!(
        db.campaign_entry_save(org, actor, id(&a), None, foreign_link)
            .await,
        Err(HubError::NotFound)
    ));
    let before = db.get_content(org, content.id).await.unwrap().unwrap();
    assert_eq!(before.revision, 1);
    assert_eq!(before.data["image"], "preserved");
    let schedule = db.get_schedule(org, content.id).await.unwrap().unwrap();
    assert!(schedule.publish_at.is_none());
    let run_input = CampaignRunInput {
        expected_campaign_revision: 1,
        idempotency_key: format!("request-{key}"),
        requested_count: 2,
        instructions: "Only fixture data".into(),
    };
    let (r1, r2) = tokio::join!(
        db.campaign_run_create(org, actor, id(&a), run_input.clone()),
        db.campaign_run_create(org, actor, id(&a), run_input.clone())
    );
    let r1 = r1.unwrap();
    assert_eq!(id(&r1), id(&r2.unwrap()));
    let mut changed = run_input.clone();
    changed.requested_count = 3;
    assert!(matches!(
        db.campaign_run_create(org, actor, id(&a), changed).await,
        Err(HubError::Conflict(_))
    ));
    let owner = Uuid::new_v4();
    let claim = CampaignClaim {
        owner_id: owner,
        idempotency_key: "claim-once".into(),
    };
    let (c1, c2) = tokio::join!(
        db.campaign_machine_claim(id(&r1), claim.clone()),
        db.campaign_machine_claim(id(&r1), claim)
    );
    let c1 = c1.unwrap();
    assert_eq!(c1["claim_nonce"], c2.unwrap()["claim_nonce"]);
    let completion = CampaignCompletion {
        owner_id: owner,
        lease_version: 1,
        idempotency_key: "complete-once".into(),
        drafts: vec![CampaignDraft {
            key: "post-one".into(),
            desired_date: "2026-11-09".parse().unwrap(),
            desired_time: Some("18:00".into()),
            platform: "instagram".into(),
            title: "New draft".into(),
            caption: "Review before publishing".into(),
            asset_id: None,
            alt_text: String::new(),
        }],
    };
    let mut wrong = completion.clone();
    wrong.owner_id = Uuid::new_v4();
    assert!(matches!(
        db.campaign_machine_complete(id(&r1), wrong).await,
        Err(HubError::Forbidden)
    ));
    let mut wrong = completion.clone();
    wrong.drafts[0].desired_time = Some("10:00".into());
    assert!(matches!(
        db.campaign_machine_complete(id(&r1), wrong).await,
        Err(HubError::Invalid(_))
    ));
    let mut wrong = completion.clone();
    wrong.drafts[0].desired_date = "2026-11-08".parse().unwrap();
    assert!(matches!(
        db.campaign_machine_complete(id(&r1), wrong).await,
        Err(HubError::Invalid(_))
    ));
    let mut wrong = completion.clone();
    wrong.drafts[0].asset_id = Some(Uuid::new_v4());
    assert!(matches!(
        db.campaign_machine_complete(id(&r1), wrong).await,
        Err(HubError::NotFound)
    ));
    let (done, replay) = tokio::join!(
        db.campaign_machine_complete(id(&r1), completion.clone()),
        db.campaign_machine_complete(id(&r1), completion.clone())
    );
    let done = done.unwrap();
    assert_eq!(done, replay.unwrap());
    let made: Uuid = serde_json::from_value(done["content_ids"][0].clone()).unwrap();
    let created = db.get_content(org, made).await.unwrap().unwrap();
    assert_eq!(serde_json::to_value(created.status).unwrap(), "draft");
    assert!(db
        .get_schedule(org, made)
        .await
        .unwrap()
        .unwrap()
        .publish_at
        .is_none());
    let mut wrong = completion.clone();
    wrong.drafts[0].caption = "A different replay".into();
    assert!(matches!(
        db.campaign_machine_complete(id(&r1), wrong).await,
        Err(HubError::Conflict(_))
    ));
    assert!(matches!(
        db.campaign_run(foreign, id(&a), id(&r1)).await,
        Err(HubError::NotFound)
    ));
    assert_eq!(
        db.get_content(org, content.id).await.unwrap().unwrap().data,
        before.data
    );
    // An existing draft edit invalidates readiness and an in-flight snapshot.
    let mut next = run_input.clone();
    next.idempotency_key = "context-revision".into();
    let next = db
        .campaign_run_create(org, actor, id(&a), next)
        .await
        .unwrap();
    db.campaign_machine_claim(
        id(&next),
        CampaignClaim {
            owner_id: owner,
            idempotency_key: "claim-next".into(),
        },
    )
    .await
    .unwrap();
    db.update_content_data(org, content.id, &json!({"title":"Human edit"}), 1)
        .await
        .unwrap();
    assert!(matches!(
        db.campaign_machine_complete(id(&next), completion.clone())
            .await,
        Err(HubError::Conflict(_))
    ));
    let calendar = db
        .campaign_calendar(
            org,
            CalendarQuery {
                campaign_id: Some(id(&a)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(calendar[0]["status"], "draft");
    // Changed campaign revision prevents returning stale generation results.
    let mut second = run_input;
    second.idempotency_key = "campaign-revision".into();
    let second = db
        .campaign_run_create(org, actor, id(&b), second)
        .await
        .unwrap();
    db.campaign_machine_claim(
        id(&second),
        CampaignClaim {
            owner_id: owner,
            idempotency_key: "claim-second".into(),
        },
    )
    .await
    .unwrap();
    let mut edit = input();
    edit.expected_revision = Some(1);
    edit.name = "Edited campaign".into();
    db.campaign_save(org, actor, Some(id(&b)), edit.clone())
        .await
        .unwrap();
    assert!(matches!(
        db.campaign_save(org, actor, Some(id(&b)), edit).await,
        Err(HubError::Conflict(2))
    ));
    assert!(matches!(
        db.campaign_machine_complete(id(&second), completion).await,
        Err(HubError::Conflict(2))
    ));
    let cancelled = db
        .campaign_run_cancel(org, actor, id(&b), id(&second), Some(2))
        .await
        .unwrap();
    assert_eq!(cancelled["status"], "cancelled");
    let active = db.campaign_machine_queue(true).await.unwrap();
    assert!(active
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["run_id"] == next["id"]));
    let queued = db.campaign_machine_queue(false).await.unwrap();
    assert!(!queued
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["run_id"] == next["id"]));
    sqlx::query("UPDATE campaign_generation_runs SET lease_expires_at=now()-interval '1 second' WHERE org_id=$1 AND id=$2")
        .bind(org).bind(id(&next)).execute(&db.pool).await.unwrap();
    let active = db.campaign_machine_queue(true).await.unwrap();
    assert!(!active
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["run_id"] == next["id"]));
    let expired = db.campaign_run(org, id(&a), id(&next)).await.unwrap();
    assert_eq!(expired["status"], "blocked");
    assert_eq!(expired["error"], "lease_expired");
    let replay = db
        .campaign_machine_claim(
            id(&next),
            CampaignClaim {
                owner_id: owner,
                idempotency_key: "claim-next".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(replay["status"], "blocked");
    let stale = db
        .campaign_run_create(
            org,
            actor,
            id(&b),
            CampaignRunInput {
                expected_campaign_revision: 2,
                idempotency_key: "queued-config-changed".into(),
                requested_count: 1,
                instructions: String::new(),
            },
        )
        .await
        .unwrap();
    let mut edit = input();
    edit.expected_revision = Some(2);
    db.campaign_save(org, actor, Some(id(&b)), edit)
        .await
        .unwrap();
    let active = db.campaign_machine_queue(true).await.unwrap();
    assert!(!active
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["run_id"] == stale["id"]));
    let stale = db.campaign_run(org, id(&b), id(&stale)).await.unwrap();
    assert_eq!(stale["status"], "blocked");
    assert_eq!(stale["error"], "campaign_changed");
    assert_eq!(stale["campaign_revision"], 2);
    let unknown = db
        .campaign_run_create(
            org,
            actor,
            id(&a),
            CampaignRunInput {
                expected_campaign_revision: 1,
                idempotency_key: "unknown-model-result".into(),
                requested_count: 1,
                instructions: String::new(),
            },
        )
        .await
        .unwrap();
    db.campaign_machine_claim(
        id(&unknown),
        CampaignClaim {
            owner_id: owner,
            idempotency_key: "claim-unknown".into(),
        },
    )
    .await
    .unwrap();
    let failure = CampaignFailure {
        owner_id: owner,
        lease_version: 1,
        idempotency_key: "fail-unknown".into(),
        error_code: "model_result_unknown".into(),
    };
    let blocked = db
        .campaign_machine_fail(id(&unknown), failure.clone())
        .await
        .unwrap();
    assert_eq!(blocked["status"], "blocked");
    assert_eq!(
        blocked,
        db.campaign_machine_fail(id(&unknown), failure)
            .await
            .unwrap()
    );
}
