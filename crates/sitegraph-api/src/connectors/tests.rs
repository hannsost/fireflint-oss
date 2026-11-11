use super::*;
use axum::{
    body::Body,
    http::{HeaderMap, Method, StatusCode, Uri},
    response::Response,
    routing::any,
};
use providers::{fetch_with, Transport};
use sitegraph_db::hub::{ConnectorConfig, ConnectorCredentials};
use std::collections::VecDeque;
use tokio::sync::Mutex;

#[derive(Clone)]
struct MockState {
    replies: Arc<Mutex<VecDeque<Response>>>,
    calls: Arc<Mutex<Vec<Call>>>,
}
struct Call {
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Value,
    raw_body: String,
}
struct Mock {
    base: String,
    state: MockState,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Mock {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Mock {
    async fn start(replies: Vec<Response>) -> Self {
        async fn handle(
            State(state): State<MockState>,
            method: Method,
            uri: Uri,
            headers: HeaderMap,
            body: String,
        ) -> Response {
            state.calls.lock().await.push(Call {
                method,
                uri,
                headers,
                body: serde_json::from_str(&body).unwrap_or(Value::Null),
                raw_body: body,
            });
            state
                .replies
                .lock()
                .await
                .pop_front()
                .unwrap_or_else(|| response(500, json!({"error":"unexpected request"}), &[]))
        }
        let state = MockState {
            replies: Arc::new(Mutex::new(replies.into())),
            calls: Arc::new(Mutex::new(Vec::new())),
        };
        let app = Router::new()
            .route("/*path", any(handle))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self { base, state, task }
    }
    fn transport(&self) -> Transport {
        Transport {
            mock_base: Some(self.base.clone()),
        }
    }
}
fn response(status: u16, value: Value, headers: &[(&str, &str)]) -> Response {
    let mut builder = Response::builder()
        .status(status)
        .header("content-type", "application/json");
    for (k, v) in headers {
        builder = builder.header(*k, *v);
    }
    builder.body(Body::from(value.to_string())).unwrap()
}
fn config(provider: &str, object: &str) -> ConnectorConfig {
    ConnectorConfig {
        id: Uuid::new_v4(),
        org_id: Uuid::new_v4(),
        source_id: Uuid::new_v4(),
        provider: provider.into(),
        object_type: object.into(),
        base_url: match provider {
            "hubspot" | "brevo" | "csv" | "json" => None,
            "pipedrive" => Some("https://fixture.pipedrive.com".into()),
            "shopify" => Some("https://fixture.myshopify.com".into()),
            _ => Some("https://fixture.example.test".into()),
        },
        database: (provider == "odoo").then(|| "fixture".into()),
        folder_path: (provider == "nextcloud").then(|| "/Team".into()),
        share_metadata: provider == "nextcloud",
        mapping: None,
        revision: 1,
        enabled: true,
    }
}
fn credentials(provider: &str) -> ConnectorCredentials {
    ConnectorCredentials {
        token: (!matches!(provider, "woocommerce" | "erpnext" | "nextcloud"))
            .then(|| "fixture-token".into()),
        consumer_key: (provider == "woocommerce").then(|| "ck_fixture".into()),
        consumer_secret: (provider == "woocommerce").then(|| "cs_fixture".into()),
        api_key: (provider == "erpnext").then(|| "key_fixture".into()),
        api_secret: (provider == "erpnext").then(|| "secret_fixture".into()),
        username: (provider == "nextcloud").then(|| "fixture".into()),
        app_password: (provider == "nextcloud").then(|| "fixture-password".into()),
    }
}
fn fixture(name: &str) -> Value {
    serde_json::from_str(match name {
        "hubspot-contacts" => include_str!("fixtures/hubspot-contacts.json"),
        "hubspot-companies" => include_str!("fixtures/hubspot-companies.json"),
        "woo-products" => include_str!("fixtures/woo-products.json"),
        "woo-customers" => include_str!("fixtures/woo-customers.json"),
        "shopify-products" => include_str!("fixtures/shopify-products.json"),
        "odoo-companies" => include_str!("fixtures/odoo-companies.json"),
        "odoo-products" => include_str!("fixtures/odoo-products.json"),
        _ => panic!("unknown fixture"),
    })
    .unwrap()
}
fn valid_rows(rows: &[ImportRow]) {
    for row in rows {
        let kind = sitegraph_company_hub::kinds()
            .into_iter()
            .find(|k| k.key == row.kind)
            .unwrap();
        sitegraph_company_hub::validate_data(&kind.fields, &row.data).unwrap();
        assert!(row.expected_revision.is_none());
    }
}

#[tokio::test]
async fn hubspot_pages_use_encoded_cursor_and_ignore_external_links() {
    let mut second = fixture("hubspot-contacts");
    second["results"][0]["id"] = json!("102");
    second.as_object_mut().unwrap().remove("paging");
    let mock = Mock::start(vec![
        response(200, fixture("hubspot-contacts"), &[]),
        response(200, second, &[]),
    ])
    .await;
    let batch = fetch_with(
        &config("hubspot", "contacts"),
        Some(&credentials("hubspot")),
        None,
        &mock.transport(),
    )
    .await
    .unwrap();
    assert_eq!(batch.rows.len(), 2);
    assert!(batch.next_cursor.is_none());
    valid_rows(&batch.rows);
    assert_eq!(batch.rows[0].data["position"], "Einkauf");
    assert_eq!(batch.rows[0].external_id, "contacts:101");
    let calls = mock.state.calls.lock().await;
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].method, Method::GET);
    assert_eq!(calls[0].uri.path(), "/crm/v3/objects/contacts");
    assert!(calls[1].uri.query().unwrap().contains("after=102"));
    assert_eq!(calls[0].headers["authorization"], "Bearer fixture-token");
}

#[tokio::test]
async fn company_customer_and_product_mappings_fit_hub_schema() {
    for (provider, object, file, kind) in [
        ("hubspot", "companies", "hubspot-companies", "company"),
        ("woocommerce", "products", "woo-products", "product"),
        ("woocommerce", "customers", "woo-customers", "contact"),
        ("odoo", "companies", "odoo-companies", "company"),
        ("odoo", "contacts", "odoo-companies", "contact"),
        ("odoo", "products", "odoo-products", "product"),
    ] {
        let mock = Mock::start(vec![response(200, fixture(file), &[])]).await;
        let batch = fetch_with(
            &config(provider, object),
            Some(&credentials(provider)),
            None,
            &mock.transport(),
        )
        .await
        .unwrap();
        assert_eq!(batch.rows.len(), 1);
        assert_eq!(batch.rows[0].kind, kind);
        valid_rows(&batch.rows);
        let calls = mock.state.calls.lock().await;
        if provider == "woocommerce" {
            assert!(calls[0].headers["authorization"]
                .to_str()
                .unwrap()
                .starts_with("Basic "));
            assert!(!calls[0].uri.to_string().contains("ck_fixture"));
        }
        if provider == "odoo" {
            assert_eq!(calls[0].method, Method::POST);
            assert_eq!(calls[0].headers["x-odoo-database"], "fixture");
            assert!(calls[0].uri.path().ends_with("/search_read"));
            assert!(calls[0].body.get("domain").is_some());
            assert!(calls[0].body.get("params").is_none());
        }
    }
}

#[tokio::test]
async fn woocommerce_paginates_using_total_pages_without_following_links() {
    let mut second = fixture("woo-products");
    second[0]["id"] = json!(11);
    let mock = Mock::start(vec![
        response(
            200,
            fixture("woo-products"),
            &[
                ("x-wp-totalpages", "2"),
                ("link", "<http://127.0.0.1/private>; rel=next"),
            ],
        ),
        response(200, second, &[("x-wp-totalpages", "2")]),
    ])
    .await;
    let mut cfg = config("woocommerce", "products");
    cfg.base_url = Some("https://fixture.example.test/shop".into());
    let batch = fetch_with(
        &cfg,
        Some(&credentials("woocommerce")),
        None,
        &mock.transport(),
    )
    .await
    .unwrap();
    assert_eq!(batch.rows.len(), 2);
    let calls = mock.state.calls.lock().await;
    assert_eq!(calls[0].uri.path(), "/shop/wp-json/wc/v3/products");
    assert!(calls[1].uri.query().unwrap().contains("page=2"));
}

#[tokio::test]
async fn shopify_uses_versioned_graphql_and_cursor_variables() {
    let mut second = fixture("shopify-products");
    second["data"]["products"]["nodes"][0]["id"] = json!("gid://shopify/Product/1002");
    second["data"]["products"]["pageInfo"]["hasNextPage"] = json!(false);
    let mock = Mock::start(vec![
        response(
            200,
            fixture("shopify-products"),
            &[("x-shopify-api-version", "2026-07")],
        ),
        response(200, second, &[]),
    ])
    .await;
    let batch = fetch_with(
        &config("shopify", "products"),
        Some(&credentials("shopify")),
        None,
        &mock.transport(),
    )
    .await
    .unwrap();
    assert_eq!(batch.rows.len(), 2);
    valid_rows(&batch.rows);
    assert!(batch.rows[0].data.get("sku").is_none());
    let calls = mock.state.calls.lock().await;
    assert_eq!(calls[0].uri.path(), "/admin/api/2026-07/graphql.json");
    assert_eq!(calls[0].headers["x-shopify-access-token"], "fixture-token");
    assert_eq!(
        calls[1].body["variables"]["after"],
        "eyJsYXN0X2lkIjoxMDAxfQ=="
    );
    assert!(calls[0].body["query"]
        .as_str()
        .unwrap()
        .starts_with("query "));
}

#[tokio::test]
async fn odoo_keyset_pagination_is_bounded_and_resumable() {
    let replies=(0..4).map(|page|response(200,json!((1..=25).map(|i|json!({"id":page*25+i,"name":format!("Produkt {i}"),"default_code":false,"description_sale":false})).collect::<Vec<_>>()),&[])).collect();
    let mock = Mock::start(replies).await;
    let batch = fetch_with(
        &config("odoo", "products"),
        Some(&credentials("odoo")),
        None,
        &mock.transport(),
    )
    .await
    .unwrap();
    assert_eq!(batch.rows.len(), 100);
    assert_eq!(batch.next_cursor.as_deref(), Some("100"));
    let calls = mock.state.calls.lock().await;
    assert_eq!(calls.len(), 4);
    assert_eq!(calls[1].body["domain"][0], json!(["id", ">", 25]));
    assert_eq!(calls[0].body["order"], "id asc");
}

#[tokio::test]
async fn http_errors_are_safe_and_do_not_retry_or_follow_redirects() {
    for (status, headers, code, retry) in [
        (
            429,
            vec![("retry-after", "120")],
            "provider_rate_limited",
            120,
        ),
        (401, vec![], "provider_authentication", 0),
        (403, vec![], "provider_authentication", 0),
        (503, vec![("retry-after", "30")], "provider_unavailable", 30),
        (
            302,
            vec![("location", "http://127.0.0.1/private")],
            "provider_redirect",
            0,
        ),
    ] {
        let mock = Mock::start(vec![response(
            status,
            json!({"error":"fixture-token and private provider details"}),
            &headers,
        )])
        .await;
        let e = fetch_with(
            &config("hubspot", "contacts"),
            Some(&credentials("hubspot")),
            None,
            &mock.transport(),
        )
        .await
        .err()
        .unwrap();
        assert_eq!(e.code, code);
        assert_eq!(e.retry_seconds, retry);
        assert!(!e.message.contains("fixture-token"));
        assert_eq!(mock.state.calls.lock().await.len(), 1);
    }
}

#[tokio::test]
async fn graphql_errors_reject_partial_data_and_compute_throttle_wait() {
    let mock=Mock::start(vec![response(200,json!({"data":{"products":{"nodes":[]}},"errors":[{"message":"secret","extensions":{"code":"THROTTLED"}}],"extensions":{"cost":{"requestedQueryCost":50,"throttleStatus":{"currentlyAvailable":0,"restoreRate":10}}}}),&[])]).await;
    let e = fetch_with(
        &config("shopify", "products"),
        Some(&credentials("shopify")),
        None,
        &mock.transport(),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(e.code, "provider_rate_limited");
    assert_eq!(e.retry_seconds, 5);
    let mock=Mock::start(vec![response(200,json!({"data":{"products":{"nodes":[]}},"errors":[{"message":"secret","extensions":{"code":"ACCESS_DENIED"}}]}),&[])]).await;
    assert_eq!(
        fetch_with(
            &config("shopify", "products"),
            Some(&credentials("shopify")),
            None,
            &mock.transport()
        )
        .await
        .err()
        .unwrap()
        .code,
        "provider_graphql"
    );
}

#[tokio::test]
async fn repeated_cursors_duplicate_ids_invalid_json_and_oversized_bodies_fail() {
    let first = fixture("hubspot-contacts");
    for replies in [
        vec![
            response(200, first.clone(), &[]),
            response(200, first.clone(), &[]),
        ],
        vec![response(
            200,
            json!({"results":[first["results"][0].clone(),first["results"][0].clone()]}),
            &[],
        )],
        vec![Response::new(Body::from("<html>invalid json</html>"))],
        vec![Response::new(Body::from("x".repeat(2 * 1024 * 1024 + 1)))],
    ] {
        let mock = Mock::start(replies).await;
        assert_eq!(
            fetch_with(
                &config("hubspot", "contacts"),
                Some(&credentials("hubspot")),
                None,
                &mock.transport()
            )
            .await
            .err()
            .unwrap()
            .code,
            "provider_response"
        );
    }
}

#[tokio::test]
async fn connector_outbound_policy_cannot_use_private_webhook_exception() {
    for url in [
        "https://127.0.0.1",
        "https://169.254.169.254",
        "https://[::1]",
        "https://2130706433",
        "http://example.test",
        "https://example.test:8443",
    ] {
        assert!(
            crate::outbound::connector_target(url).await.is_err(),
            "{url}"
        );
    }
    for url in [
        "https://fixture.myshopify.com.attacker.test",
        "https://evil.test",
        "https://user:pass@fixture.myshopify.com",
        "https://fixture.myshopify.com/?token=bad",
        "https://fixture.myshopify.com/#bad",
    ] {
        assert!(providers::base_url("shopify", Some(url)).is_err(), "{url}");
    }
}

#[test]
fn retry_after_accepts_seconds_and_http_dates() {
    let now = chrono::DateTime::parse_from_rfc3339("2026-09-18T12:00:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    assert_eq!(providers::retry_after(Some("120"), now), 120);
    assert_eq!(
        providers::retry_after(Some("Fri, 18 Sep 2026 12:02:00 GMT"), now),
        121
    );
    assert_eq!(providers::retry_after(Some("invalid"), now), 60);
}

fn file_config(provider: &str) -> ConnectorConfig {
    let mut cfg = config(provider, "rows");
    cfg.mapping = Some(ConnectorMapping {
        kind: "contact".into(),
        external_id: if provider == "csv" {
            "id"
        } else {
            "identity.id"
        }
        .into(),
        name: if provider == "csv" {
            "name"
        } else {
            "profile.name"
        }
        .into(),
        delimiter: ";".into(),
        fields: if provider == "csv" {
            [
                ("name".into(), "name".into()),
                ("email".into(), "email".into()),
                ("notes".into(), "notes".into()),
            ]
            .into()
        } else {
            [
                ("name".into(), "profile.name".into()),
                ("email".into(), "profile.email".into()),
                ("notes".into(), "notes".into()),
            ]
            .into()
        },
    });
    cfg
}

#[test]
fn csv_and_json_fixtures_map_without_losing_quotes_or_nested_values() {
    let csv = files::parse(&file_config("csv"), include_str!("fixtures/contacts.csv")).unwrap();
    assert_eq!(
        csv.rows[0].data["notes"],
        "Zeile eins\nZeile zwei; mit \"Zitat\""
    );
    valid_rows(&csv.rows);
    let json = files::parse(&file_config("json"), include_str!("fixtures/contacts.json")).unwrap();
    assert_eq!(json.rows[0].external_id, "json-1");
    assert_eq!(json.rows[0].data["notes"], "");
    valid_rows(&json.rows);
}

#[test]
fn file_import_rejects_ambiguous_headers_bad_quotes_missing_fields_and_duplicates() {
    let cfg = file_config("csv");
    for content in [
        "id;name;email;notes\n1;\"unterminated;a;b",
        "id;id;email;notes\n1;2;a;b",
        "id;name;email;notes\n1;a;mail;b\n1;c;mail;d",
        "id;name;email;notes\n1;\"name\"oops;mail;b",
        "id;name;email\n1;name;mail",
        "id;name;email;notes\n1;name;mail;b;extra",
    ] {
        assert!(files::parse(&cfg, content).is_err(), "{content}");
    }
    assert!(files::parse(&file_config("json"), "{}").is_err());
    assert!(files::parse(&file_config("json"), "[null]").is_err());
    assert!(files::parse(
        &cfg,
        &format!(
            "id;name;email;notes\n{}",
            (0..101)
                .map(|n| format!("{n};name;;\n"))
                .collect::<String>()
        )
    )
    .is_err());
}

#[test]
fn file_mapping_requires_schema_fields_and_rejects_unknown_targets() {
    let mut cfg = file_config("csv");
    let mut mapping = cfg.mapping.take().unwrap();
    assert!(validate_mapping(&mapping).is_ok());
    mapping.fields.remove("name");
    assert!(validate_mapping(&mapping).is_err());
    mapping.fields.insert("name".into(), "name".into());
    mapping.fields.insert("secret".into(), "notes".into());
    assert!(validate_mapping(&mapping).is_err());
}

#[tokio::test]
async fn structured_provider_error_has_rate_header_and_safe_payload() {
    let response =
        ConnectorError::Provider(providers::ProviderError::rate_limited(60)).into_response();
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(response.headers()["retry-after"], "60");
}

fn inspect_file_value(
    provider: &str,
    content: &str,
    delimiter: &str,
) -> Result<Value, providers::ProviderError> {
    discovery::inspect(discovery::InspectInput {
        provider: provider.into(),
        content: content.into(),
        delimiter: delimiter.into(),
    })
    .map(|value| serde_json::to_value(value).unwrap())
}
fn suggested<'a>(inspection: &'a Value, kind: &str) -> &'a Value {
    inspection["suggestions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|suggestion| suggestion["kind"] == kind)
        .unwrap()
}
fn observed<'a>(inspection: &'a Value, path: &str) -> &'a Value {
    inspection["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|field| field["path"] == path)
        .unwrap()
}

#[test]
fn discovery_german_product_csv_ranks_explainable_mapping_without_sample_values() {
    let input="Artikelnummer;Bezeichnung;Beschreibung;Maßeinheit\r\nSKU-001;Geheimer Messesensor;Vertrauliche Beschreibung;Stück\r\nSKU-002;Zweiter Messesensor;Weitere Beschreibung;Stück\r\n";
    let result = inspect_file_value("csv", input, ";").unwrap();
    assert_eq!(result["version"], 1);
    assert_eq!(result["mode"], "rules");
    assert_eq!(result["row_count"], 2);
    assert_eq!(result["delimiter"], ";");
    assert_eq!(result["suggestions"].as_array().unwrap().len(), 4);
    assert_eq!(result["suggestions"][0]["kind"], "product");
    let product = suggested(&result, "product");
    assert_eq!(product["mapping"]["external_id"], "Artikelnummer");
    assert_eq!(product["mapping"]["name"], "Bezeichnung");
    assert_eq!(product["mapping"]["fields"]["sku"], "Artikelnummer");
    assert_eq!(product["mapping"]["fields"]["unit"], "Maßeinheit");
    assert_eq!(product["missing"], json!([]));
    let encoded = result.to_string();
    for value in [
        "SKU-001",
        "SKU-002",
        "Geheimer Messesensor",
        "Vertrauliche Beschreibung",
        "Stück",
    ] {
        assert!(!encoded.contains(value));
    }
    assert!(encoded.contains("Künftige Stabilität"));
    assert!(product["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r.as_str().unwrap().contains("Regelpunkte")));
}

#[test]
fn discovery_company_headers_and_nested_json_use_only_supported_paths() {
    let csv=inspect_file_value("csv","Unternehmens-ID,Firmenname,E-Mail,Steuerkennung\nf1,Beispielfirma,private@example.test,DE000\n",",").unwrap();
    assert_eq!(csv["suggestions"][0]["kind"], "company");
    assert_eq!(
        suggested(&csv, "company")["mapping"]["fields"]["legal_name"],
        "Firmenname"
    );
    let content=json!([
        {"identity":{"id":1},"profile":{"full_name":"First private name","email":"first@example.test"},"flags":[true],"note":null},
        {"identity":{"id":"2"},"profile":{"full_name":"Second private name","email":"second@example.test"},"flags":[false],"note":"private note"}
    ]).to_string();
    let result = inspect_file_value("json", &content, ",").unwrap();
    assert_eq!(
        observed(&result, "identity.id")["types"],
        json!(["string", "number"])
    );
    assert_eq!(
        observed(&result, "note")["types"],
        json!(["string", "null"])
    );
    assert_eq!(observed(&result, "flags.0")["types"], json!(["boolean"]));
    assert_eq!(
        suggested(&result, "contact")["mapping"]["external_id"],
        "identity.id"
    );
    assert_eq!(
        suggested(&result, "contact")["mapping"]["name"],
        "profile.full_name"
    );
    assert!(!result.to_string().contains("first@example.test"));
    let rows = files::read_rows("json", &content, ",", false).unwrap();
    for field in result["fields"].as_array().unwrap() {
        assert!(rows
            .iter()
            .all(|row| files::at(row, field["path"].as_str().unwrap(), false).is_some()));
    }
}

#[test]
fn discovery_identity_is_never_derived_from_names_emails_or_row_numbers() {
    let data=json!([{"name":"Ada","email":"ada@example.test","row_index":1},{"name":"Mika","email":"mika@example.test","row_index":2}]).to_string();
    let result = inspect_file_value("json", &data, ",").unwrap();
    for kind in ["company", "contact", "location", "product"] {
        assert_eq!(suggested(&result, kind)["mapping"]["external_id"], "");
        assert!(suggested(&result, kind)["missing"]
            .as_array()
            .unwrap()
            .contains(&json!("external_id")));
    }
}

#[test]
fn discovery_id_and_sku_ambiguity_is_not_resolved_by_guessing() {
    let result = inspect_file_value("csv", "id,sku,name\n1,S1,First\n2,S2,Second\n", ",").unwrap();
    for suggestion in result["suggestions"].as_array().unwrap() {
        assert_eq!(suggestion["mapping"]["external_id"], "");
        assert!(suggestion["reasons"].as_array().unwrap().iter().any(|r| r
            .as_str()
            .unwrap()
            .contains("mehrere geeignete ID-/SKU-Felder")));
    }
    let result =
        inspect_file_value("csv", "id,Name,NAME\n1,Ada,Other\n2,Mika,Second\n", ",").unwrap();
    let contact = suggested(&result, "contact");
    assert_eq!(contact["mapping"]["name"], "");
    assert!(contact["mapping"]["fields"].get("name").is_none());
    assert!(contact["missing"]
        .as_array()
        .unwrap()
        .contains(&json!("data.name")));
    assert!(contact["missing"]
        .as_array()
        .unwrap()
        .contains(&json!("name")));
    assert!(contact["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r.as_str().unwrap().contains("mehrdeutig")));
}

#[test]
fn discovery_unique_uses_the_existing_import_scalar_conversion() {
    let cases = [
        json!([{"id":1},{"id":"1"}]),
        json!([{"id":false},{"id":"false"}]),
        json!([{"id":null},{"id":""}]),
        json!([{"id":"duplicate"},{"id":"duplicate"}]),
    ];
    for content in cases {
        let result = inspect_file_value("json", &content.to_string(), ",").unwrap();
        assert_eq!(observed(&result, "id")["unique"], false);
        assert_eq!(suggested(&result, "contact")["mapping"]["external_id"], "");
    }
    let result = inspect_file_value("json", r#"[{"id":true},{"id":false}]"#, ",").unwrap();
    assert_eq!(observed(&result, "id")["non_empty"], 2);
    assert_eq!(observed(&result, "id")["unique"], true);
}

#[test]
fn discovery_sparse_empty_and_null_identity_fields_remain_unresolved() {
    for content in [
        r#"[{"id":"1"},{}]"#,
        r#"[{"id":"1"},{"id":null}]"#,
        r#"[{"id":"1"},{"id":"  "}]"#,
    ] {
        let result = inspect_file_value("json", content, ",").unwrap();
        assert_eq!(suggested(&result, "contact")["mapping"]["external_id"], "");
    }
    let result = inspect_file_value(
        "json",
        r#"[{"id":1,"name":"Name","email":"private@example.test"},{"id":2,"name":""}]"#,
        ",",
    )
    .unwrap();
    assert_eq!(observed(&result, "email")["present"], 1);
    assert_eq!(observed(&result, "name")["non_empty"], 1);
    assert_eq!(suggested(&result, "contact")["mapping"]["name"], "");
    assert!(suggested(&result, "contact")["mapping"]["fields"]
        .get("email")
        .is_none());
    assert!(result["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w.as_str().unwrap().contains("fehlt in 1 Zeilen")));
}

#[test]
fn discovery_does_not_join_name_or_address_components() {
    let result = inspect_file_value(
        "csv",
        "id,Vorname,Nachname,Straße,Ort,PLZ\n1,Ada,Beispiel,Musterweg,Berlin,10115\n",
        ",",
    )
    .unwrap();
    assert_eq!(suggested(&result, "contact")["mapping"]["name"], "");
    let location = suggested(&result, "location");
    assert!(location["mapping"]["fields"].get("address").is_none());
    assert!(location["missing"]
        .as_array()
        .unwrap()
        .contains(&json!("data.address")));
}

#[test]
fn discovery_complete_suggestions_round_trip_through_existing_file_import() {
    for (kind, content) in [
        ("company", "id,legal_name\n1,Example Company\n"),
        (
            "contact",
            "id,name,email\n1,Example Person,person@example.test\n",
        ),
        ("location", "id,name,address\n1,Office,Sample Street\n"),
        (
            "product",
            "sku,name,description\nSKU1,Product,Description\n",
        ),
    ] {
        let result = inspect_file_value("csv", content, ",").unwrap();
        let suggestion = suggested(&result, kind);
        assert_eq!(suggestion["missing"], json!([]));
        let mapping: ConnectorMapping =
            serde_json::from_value(suggestion["mapping"].clone()).unwrap();
        // No transformation: a complete recommendation is directly reusable.
        assert!(validate_mapping(&mapping).is_ok());
        let mut cfg = config("csv", "rows");
        cfg.mapping = Some(mapping);
        let batch = files::parse(&cfg, content).unwrap();
        assert_eq!(batch.rows.len(), 1);
        assert_eq!(batch.rows[0].kind, kind);
        valid_rows(&batch.rows);
    }
}

#[test]
fn discovery_uses_shared_csv_quoting_and_exact_dotted_headers() {
    let content="\u{feff}id;profile.name;notes\r\n1;\"Ada; Beispiel\";\"line1\r\nline2 \"\"quoted\"\"\"\r\n";
    let result = inspect_file_value("csv", content, ";").unwrap();
    assert_eq!(result["row_count"], 1);
    assert_eq!(observed(&result, "profile.name")["present"], 1);
    let mut cfg = config("csv", "rows");
    cfg.mapping = Some(ConnectorMapping {
        kind: "contact".into(),
        external_id: "id".into(),
        name: "profile.name".into(),
        fields: [
            ("name".into(), "profile.name".into()),
            ("notes".into(), "notes".into()),
        ]
        .into(),
        delimiter: ";".into(),
    });
    assert_eq!(
        files::parse(&cfg, content).unwrap().rows[0].data["notes"],
        "line1\r\nline2 \"quoted\""
    );
    assert!(inspect_file_value("csv", "id\tname\n1\tAda\n", "\t").is_ok());
    assert!(inspect_file_value("csv", content, "|").is_err());
}

#[test]
fn discovery_rejects_dotted_json_keys_collisions_and_incompatible_structures() {
    for content in [
        r#"[{"a.b":1}]"#,
        r#"[{"a.b":1,"a":{"b":2}}]"#,
        r#"[{"a":1},{"a":{"b":2}}]"#,
        r#"[{"a":[]},{"a":{"0":"value"}}]"#,
        r#"[{"":"value"}]"#,
        r#"[{"name\n":"value"}]"#,
    ] {
        assert!(
            inspect_file_value("json", content, ",").is_err(),
            "{content}"
        );
    }
    let result = inspect_file_value("json", r#"[{"id":1,"empty":{},"array":[]}]"#, ",").unwrap();
    assert_eq!(result["fields"].as_array().unwrap().len(), 1);
    assert!(result["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w.as_str().unwrap().contains("Leere JSON-Objekte")));
}

#[test]
fn discovery_rejects_duplicate_json_keys_but_preserves_legacy_import_decoding() {
    let content = r#"[{"id":"old","id":"new","profile":{"name":"Ada","email":"ada@example.test"},"notes":null}]"#;
    assert!(inspect_file_value("json", content, ",").is_err());
    assert!(inspect_file_value("json", r#"[{"profile":{"id":1,"id":2}}]"#, ",").is_err());
    let mut cfg = file_config("json");
    cfg.mapping.as_mut().unwrap().external_id = "id".into();
    assert_eq!(
        files::parse(&cfg, content).unwrap().rows[0].external_id,
        "new"
    );
}

#[test]
fn discovery_rejects_malformed_input_and_all_documented_limits_without_truncation() {
    for (provider, content, delimiter) in [
        ("csv", "id,name\n1,\"unterminated", ","),
        ("csv", "id,id\n1,2", ","),
        ("csv", "id,name\n1", ","),
        ("json", "[]", ","),
        ("json", "{}", ","),
        ("json", "[null]", ","),
        ("json", "[{", ","),
        ("json", "", ","),
        ("hubspot", "[]", ","),
        ("json", "[{\"id\":1}]", "|"),
    ] {
        assert!(inspect_file_value(provider, content, delimiter).is_err());
    }
    assert!(inspect_file_value("json", &" ".repeat(500 * 1024 + 1), ",").is_err());
    let rows = json!((0..101).map(|id| json!({"id":id})).collect::<Vec<_>>()).to_string();
    assert!(inspect_file_value("json", &rows, ",").is_err());
    let mut values = serde_json::Map::new();
    for n in 0..65 {
        values.insert(format!("field{n}"), json!(n));
    }
    assert!(inspect_file_value("json", &json!([values]).to_string(), ",").is_err());
    let mut nested = json!("private");
    for n in 0..8 {
        nested = Value::Object([(format!("level{n}"), nested)].into_iter().collect());
    }
    assert!(inspect_file_value("json", &json!([nested.clone()]).to_string(), ",").is_ok());
    nested = json!({"too_deep":nested});
    assert!(inspect_file_value("json", &json!([nested]).to_string(), ",").is_err());
    let mut empty_nodes = serde_json::Map::new();
    for n in 0..513 {
        empty_nodes.insert(format!("field{n}"), json!([]));
    }
    assert!(inspect_file_value("json", &json!([empty_nodes]).to_string(), ",").is_err());
    assert!(inspect_file_value("csv", &format!("id,{}\n1,value", "x".repeat(241)), ",").is_err());
}

#[test]
fn discovery_contract_rejects_unknown_request_fields_and_defaults_to_comma() {
    assert!(serde_json::from_value::<discovery::InspectInput>(
        json!({"provider":"csv","content":"id,name\n1,Ada","credentials":{}})
    )
    .is_err());
    let input: discovery::InspectInput =
        serde_json::from_value(json!({"provider":"csv","content":"id,name\n1,Ada"})).unwrap();
    assert_eq!(input.delimiter, ",");
    let result = serde_json::to_value(discovery::inspect(input).unwrap()).unwrap();
    let mut keys = result
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>();
    keys.sort();
    assert_eq!(
        keys,
        vec![
            "delimiter",
            "fields",
            "mode",
            "provider",
            "row_count",
            "suggestions",
            "version",
            "warnings"
        ]
    );
    for forbidden in [
        "content",
        "samples",
        "sample_values",
        "credentials",
        "created_at",
        "filename",
    ] {
        assert!(result.get(forbidden).is_none());
    }
    for field in result["fields"].as_array().unwrap() {
        let mut keys = field
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();
        keys.sort();
        assert_eq!(
            keys,
            vec!["non_empty", "path", "present", "types", "unique"]
        );
    }
}

#[test]
fn discovery_generic_and_specific_name_headers_are_both_ambiguous_candidates() {
    for content in [
        "id,name,full_name\n1,Short,Long name\n",
        "id,Firma,Name\n1,Company,Other name\n",
    ] {
        let result = inspect_file_value("csv", content, ",").unwrap();
        let kind = if content.contains("Firma") {
            "company"
        } else {
            "contact"
        };
        let suggestion = suggested(&result, kind);
        assert_eq!(suggestion["mapping"]["name"], "");
        assert!(suggestion["missing"]
            .as_array()
            .unwrap()
            .contains(&json!("name")));
        assert!(suggestion["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reason| reason.as_str().unwrap().contains("mehrdeutig")));
        assert!(suggestion["mapping"]["fields"]
            .as_object()
            .unwrap()
            .values()
            .all(|path| !path.as_str().unwrap().is_empty()));
    }
}

fn pipedrive_page(items: Value, next: Option<&str>) -> Value {
    json!({"success":true,"data":items,"additional_data":{"next_cursor":next}})
}

#[tokio::test]
async fn pipedrive_v2_preserves_primary_contacts_and_encoded_pagination() {
    let mock = Mock::start(vec![
        response(200, pipedrive_page(json!([{"id":1,"name":"Ada Beispiel","is_deleted":false,
            "emails":[{"value":"other@example.test","primary":false},{"value":"ada@example.test","primary":true}],
            "phones":[{"value":"+493012345","primary":true}],"job_title":"Vertrieb"}]), Some("next+/=&")), &[]),
        response(200, pipedrive_page(json!([{"id":2,"name":"Lin Beispiel","emails":[{"value":"","primary":false},{"value":"lin@example.test","primary":false}],"phones":[]}]), None), &[]),
    ]).await;
    let batch = fetch_with(
        &config("pipedrive", "persons"),
        Some(&credentials("pipedrive")),
        None,
        &mock.transport(),
    )
    .await
    .unwrap();
    valid_rows(&batch.rows);
    assert_eq!(batch.rows.len(), 2);
    assert_eq!(batch.rows[0].external_id, "persons:1");
    assert_eq!(batch.rows[0].data["email"], "ada@example.test");
    assert_eq!(batch.rows[0].data["position"], "Vertrieb");
    assert_eq!(batch.rows[1].data["email"], "lin@example.test");
    assert!(batch.next_cursor.is_none());
    let calls = mock.state.calls.lock().await;
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].method, Method::GET);
    assert_eq!(calls[0].uri.path(), "/api/v2/persons");
    assert_eq!(calls[0].headers["x-api-token"], "fixture-token");
    assert!(!calls[0].headers.contains_key("authorization"));
    assert!(!calls[0].uri.to_string().contains("fixture-token"));
    let query: std::collections::HashMap<_, _> =
        reqwest::Url::parse(&format!("https://fixture.pipedrive.com{}", calls[1].uri))
            .unwrap()
            .query_pairs()
            .into_owned()
            .collect();
    assert_eq!(query["cursor"], "next+/=&");
    assert_eq!(query["sort_by"], "id");
}

#[tokio::test]
async fn business_company_and_product_rows_follow_each_provider_schema() {
    for (provider, object, reply, kind, field, expected) in [
        (
            "pipedrive",
            "organizations",
            pipedrive_page(
                json!([{"id":7,"name":"Beispiel GmbH","address":{"value":"Teststraße 1, Berlin"}}]),
                None,
            ),
            "company",
            "address",
            "Teststraße 1, Berlin",
        ),
        (
            "erpnext",
            "customers",
            json!({"data":[{"name":"KUNDE-7","customer_name":"Kunde GmbH","customer_type":"Company","tax_id":"DE123456789"}]}),
            "company",
            "tax_id",
            "DE123456789",
        ),
        (
            "erpnext",
            "suppliers",
            json!({"data":[{"name":"LIEF-7","supplier_name":"Lieferant GmbH","supplier_type":"Company","tax_id":null}]}),
            "company",
            "legal_name",
            "Lieferant GmbH",
        ),
        (
            "erpnext",
            "products",
            json!({"data":[{"name":"ITEM-7","item_code":"SKU-7","item_name":"Beispielartikel","description":"<b>Quellbeschreibung</b>"}]}),
            "product",
            "sku",
            "SKU-7",
        ),
    ] {
        let mock = Mock::start(vec![response(200, reply, &[])]).await;
        let batch = fetch_with(
            &config(provider, object),
            Some(&credentials(provider)),
            None,
            &mock.transport(),
        )
        .await
        .unwrap();
        valid_rows(&batch.rows);
        assert_eq!(batch.rows[0].kind, kind);
        assert_eq!(batch.rows[0].data[field], expected);
        assert!(batch.rows[0].external_id.starts_with(&format!("{object}:")));
        let calls = mock.state.calls.lock().await;
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].method, Method::GET);
        if provider == "erpnext" {
            assert_eq!(
                calls[0].headers["authorization"],
                "token key_fixture:secret_fixture"
            );
            assert!(!calls[0].uri.to_string().contains("secret_fixture"));
            let query: std::collections::HashMap<_, _> =
                reqwest::Url::parse(&format!("https://fixture.example.test{}", calls[0].uri))
                    .unwrap()
                    .query_pairs()
                    .into_owned()
                    .collect();
            let fields: Value = serde_json::from_str(&query["fields"]).unwrap();
            assert!(fields.as_array().unwrap().contains(&json!("name")));
            if object != "products" {
                assert!(query["filters"].contains("Company"));
            }
        }
    }
}

#[tokio::test]
async fn erpnext_and_brevo_continue_after_bounded_hundred_row_batches() {
    for provider in ["erpnext", "brevo"] {
        let replies = (0..4).map(|page| {
            let items: Vec<_> = (0..25).map(|i| {
                let id = page * 25 + i + 1;
                if provider == "erpnext" { json!({"name":format!("ITEM-{id:04}"),"item_code":format!("SKU-{id}"),"item_name":format!("Artikel {id}")}) }
                else { json!({"id":id,"email":format!("contact{id}@example.test"),"attributes":{}}) }
            }).collect();
            response(200, if provider == "erpnext" { json!({"data":items}) } else { json!({"contacts":items,"count":101}) }, &[])
        }).collect();
        let mock = Mock::start(replies).await;
        let object = if provider == "erpnext" {
            "products"
        } else {
            "contacts"
        };
        let batch = fetch_with(
            &config(provider, object),
            Some(&credentials(provider)),
            None,
            &mock.transport(),
        )
        .await
        .unwrap();
        valid_rows(&batch.rows);
        assert_eq!(batch.rows.len(), 100);
        assert_eq!(batch.next_cursor.as_deref(), Some("100"));
        let calls = mock.state.calls.lock().await;
        assert_eq!(calls.len(), 4);
        let key = if provider == "erpnext" {
            "limit_start"
        } else {
            "offset"
        };
        assert!(calls[3].uri.query().unwrap().contains(&format!("{key}=75")));
        drop(calls);
        let value = if provider == "erpnext" {
            json!({"data":[]})
        } else {
            json!({"contacts":[{"id":101,"email":"last@example.test"}],"count":101})
        };
        let tail = Mock::start(vec![response(200, value, &[])]).await;
        let tail_batch = fetch_with(
            &config(provider, object),
            Some(&credentials(provider)),
            batch.next_cursor,
            &tail.transport(),
        )
        .await
        .unwrap();
        assert!(tail_batch.next_cursor.is_none());
        assert!(tail.state.calls.lock().await[0]
            .uri
            .query()
            .unwrap()
            .contains(&format!("{key}=100")));
    }
}

#[tokio::test]
async fn brevo_imports_identity_without_marketing_permission_or_extra_attributes() {
    let mock = Mock::start(vec![response(200, json!({"contacts":[
        {"id":1,"email":"ada@example.test","attributes":{"FIRSTNAME":"Ada","LASTNAME":"Beispiel","SMS":"+493012345","SECRET_NOTE":"never import"},"emailBlacklisted":true,"smsBlacklisted":true,"listIds":[5]},
        {"id":2,"attributes":{"FIRST_NAME":"Lin","LAST_NAME":"Beispiel"}},
        {"id":3,"attributes":{"SMS":"+493065432"}}
    ],"count":3}), &[])]).await;
    let batch = fetch_with(
        &config("brevo", "contacts"),
        Some(&credentials("brevo")),
        None,
        &mock.transport(),
    )
    .await
    .unwrap();
    valid_rows(&batch.rows);
    assert_eq!(batch.rows[0].name, "Ada Beispiel");
    assert_eq!(batch.rows[1].name, "Lin Beispiel");
    assert_eq!(batch.rows[2].name, "+493065432");
    assert_eq!(
        batch.rows[0].data,
        json!({"name":"Ada Beispiel","email":"ada@example.test","phone":"+493012345"})
    );
    let calls = mock.state.calls.lock().await;
    assert_eq!(calls[0].uri.path(), "/v3/contacts");
    assert_eq!(calls[0].headers["api-key"], "fixture-token");
    assert!(!calls[0].headers.contains_key("authorization"));
}

#[tokio::test]
async fn business_protocol_errors_discard_entire_batches() {
    for (provider, object, reply) in [
        (
            "pipedrive",
            "persons",
            json!({"success":false,"data":[],"additional_data":{}}),
        ),
        (
            "pipedrive",
            "persons",
            json!({"success":true,"data":[],"additional_data":"broken"}),
        ),
        (
            "pipedrive",
            "persons",
            pipedrive_page(json!([{"id":1,"name":"Deleted","is_deleted":true}]), None),
        ),
        (
            "pipedrive",
            "persons",
            pipedrive_page(
                json!([{"id":1,"name":"Wrong schema","emails":"ada@example.test"}]),
                None,
            ),
        ),
        (
            "pipedrive",
            "persons",
            pipedrive_page(
                json!([{"id":1,"name":"One"},{"id":1,"name":"Duplicate"}]),
                None,
            ),
        ),
        (
            "erpnext",
            "customers",
            json!({"data":[{"name":"C1","customer_name":"Private Person","customer_type":"Individual"}]}),
        ),
        (
            "erpnext",
            "products",
            json!({"data":[],"exception":"SECRET do not expose"}),
        ),
        ("brevo", "contacts", json!({"contacts":[],"count":1})),
        (
            "brevo",
            "contacts",
            json!({"contacts":[{"id":1,"email":"ada@example.test"}],"count":0}),
        ),
        (
            "brevo",
            "contacts",
            json!({"contacts":[{"id":1,"email":false}],"count":1}),
        ),
    ] {
        let mock = Mock::start(vec![response(200, reply, &[])]).await;
        let result = fetch_with(
            &config(provider, object),
            Some(&credentials(provider)),
            None,
            &mock.transport(),
        )
        .await;
        let error = match result {
            Ok(_) => panic!("Accepted malformed {provider} response"),
            Err(e) => e,
        };
        assert_eq!(error.code, "provider_response");
        assert!(!error.message.contains("SECRET"));
        assert_eq!(mock.state.calls.lock().await.len(), 1);
    }
}

#[tokio::test]
async fn new_providers_preserve_transport_errors_and_never_follow_redirects() {
    for provider in ["pipedrive", "erpnext", "brevo"] {
        let object = if provider == "pipedrive" {
            "persons"
        } else if provider == "erpnext" {
            "products"
        } else {
            "contacts"
        };
        for (status, code) in [
            (401, "provider_authentication"),
            (403, "provider_authentication"),
            (429, "provider_rate_limited"),
            (503, "provider_unavailable"),
            (302, "provider_redirect"),
        ] {
            let mock = Mock::start(vec![response(
                status,
                json!({"secret":"must not appear"}),
                &[
                    ("retry-after", "37"),
                    ("location", "http://127.0.0.1:1/secret"),
                ],
            )])
            .await;
            let result = fetch_with(
                &config(provider, object),
                Some(&credentials(provider)),
                None,
                &mock.transport(),
            )
            .await;
            let error = match result {
                Ok(_) => panic!("Accepted failed provider"),
                Err(e) => e,
            };
            assert_eq!(error.code, code);
            if status == 429 || status == 503 {
                assert_eq!(error.retry_seconds, 37);
            }
            assert!(!error.message.contains("must not appear"));
            assert_eq!(mock.state.calls.lock().await.len(), 1);
        }
    }
}

#[test]
fn new_provider_targets_and_credentials_are_strict() {
    for target in [
        "https://evil.test",
        "https://a.pipedrive.com.evil.test",
        "https://a.b.pipedrive.com",
        "https://pipedrive.com",
        "https://firma.pipedrive.com/api",
        "https://firma.pipedrive.com?api_token=secret",
    ] {
        assert!(providers::base_url("pipedrive", Some(target)).is_err());
    }
    assert_eq!(
        providers::base_url("brevo", None).unwrap().as_str(),
        "https://api.brevo.com/"
    );
    assert!(providers::base_url("brevo", Some("https://api.brevo.com")).is_err());
    for provider in ["pipedrive", "erpnext", "brevo"] {
        let c = config(
            provider,
            if provider == "pipedrive" {
                "persons"
            } else if provider == "erpnext" {
                "products"
            } else {
                "contacts"
            },
        );
        let mut input = ConnectorInput {
            name: "Fixture".into(),
            provider: provider.into(),
            object_type: c.object_type,
            source_id: c.source_id,
            base_url: c.base_url,
            database: None,
            folder_path: None,
            share_metadata: false,
            mapping: None,
            enabled: true,
            credentials: Some(credentials(provider)),
            expected_revision: Some(0),
        };
        assert!(validate(&input).is_ok());
        input.credentials.as_mut().unwrap().consumer_key = Some("unexpected".into());
        assert!(validate(&input).is_err());
        input.credentials = Some(credentials(provider));
        input.object_type = "orders".into();
        assert!(validate(&input).is_err());
    }
}

fn nextcloud_xml(name: &str) -> &'static str {
    match name {
        "valid" => include_str!("fixtures/nextcloud/valid-multistatus.xml"),
        "mixed" => include_str!("fixtures/nextcloud/mixed-propstat.xml"),
        "foreign" => include_str!("fixtures/nextcloud/foreign-origin.xml"),
        "dtd" => include_str!("fixtures/nextcloud/doctype-entity.xml"),
        _ => panic!("unknown XML fixture"),
    }
}
async fn nextcloud_batch(xml: String) -> Result<providers::Batch, providers::ProviderError> {
    let mock = Mock::start(vec![Response::builder()
        .status(207)
        .body(Body::from(xml))
        .unwrap()])
    .await;
    let mut c = config("nextcloud", "files");
    c.base_url = Some("https://cloud.example.org".into());
    fetch_with(&c, Some(&credentials("nextcloud")), None, &mock.transport()).await
}
#[tokio::test]
async fn nextcloud_depth_one_uses_app_password_and_only_imports_metadata() {
    let mock = Mock::start(vec![Response::builder()
        .status(207)
        .body(Body::from(nextcloud_xml("valid")))
        .unwrap()])
    .await;
    let mut c = config("nextcloud", "files");
    c.base_url = Some("https://cloud.example.org".into());
    let batch = fetch_with(&c, Some(&credentials("nextcloud")), None, &mock.transport())
        .await
        .unwrap();
    assert_eq!(batch.rows.len(), 2);
    assert!(batch.next_cursor.is_none());
    valid_rows(&batch.rows);
    assert_eq!(batch.rows[0].name, "Grüße & Plan.txt");
    assert_eq!(
        batch.rows[0].data["url"],
        "https://cloud.example.org/index.php/f/101"
    );
    assert_eq!(batch.rows[0].data["size_bytes"], 42);
    assert!(!batch.rows[0].data.to_string().contains("fixture-password"));
    let calls = mock.state.calls.lock().await;
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].method.as_str(), "PROPFIND");
    assert_eq!(calls[0].uri.path(), "/remote.php/dav/files/fixture/Team/");
    assert_eq!(calls[0].headers["depth"], "1");
    use base64::Engine;
    assert_eq!(
        calls[0].headers["authorization"],
        format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode("fixture:fixture-password")
        )
    );
    assert!(calls[0].raw_body.contains("<oc:fileid/>"));
    assert!(!calls[0].raw_body.contains("download"));
}
#[tokio::test]
async fn nextcloud_unsupported_optional_property_is_ignored() {
    let batch = nextcloud_batch(nextcloud_xml("mixed").into())
        .await
        .unwrap();
    assert_eq!(batch.rows.len(), 1);
    assert!(batch.rows[0].data.get("mime_type").is_none());
    valid_rows(&batch.rows);
    let fallback =
        nextcloud_xml("mixed").replace("<d:displayname>Ohne Typ.txt</d:displayname>", "");
    assert_eq!(
        nextcloud_batch(fallback).await.unwrap().rows[0].name,
        "Ohne Typ.txt"
    );
}
#[tokio::test]
async fn nextcloud_rejects_hostile_xml_scope_and_incomplete_metadata() {
    for xml in [
        nextcloud_xml("foreign").to_owned(),
        nextcloud_xml("dtd").to_owned(),
        nextcloud_xml("valid").replace(
            "/Team/Gr%C3%BC%C3%9Fe%20%26%20Plan.txt",
            "/Private/Plan.txt",
        ),
        nextcloud_xml("valid").replace(
            "/Team/Gr%C3%BC%C3%9Fe%20%26%20Plan.txt",
            "/Team/Sub/Plan.txt",
        ),
        nextcloud_xml("valid").replace(
            "/Team/Gr%C3%BC%C3%9Fe%20%26%20Plan.txt",
            "/Team/Sub%2fPlan.txt",
        ),
        nextcloud_xml("valid").replace(
            "<store:fileid>102</store:fileid>",
            "<store:fileid>101</store:fileid>",
        ),
        nextcloud_xml("valid").replace("<store:fileid>102</store:fileid>", ""),
        nextcloud_xml("valid").replace(
            "<v:getcontentlength>42</v:getcontentlength>",
            "<v:getcontentlength>-1</v:getcontentlength>",
        ),
        nextcloud_xml("valid").replace(
            "<v:getcontentlength>42</v:getcontentlength>",
            "<v:getcontentlength>9007199254740992</v:getcontentlength>",
        ),
        nextcloud_xml("valid").replace("HTTP/1.1 200 OK", "HTTP/1.1 403 Forbidden"),
        "<!DOCTYPE x><d:multistatus xmlns:d=\"DAV:\"/>".into(),
        "<d:multistatus xmlns:d=\"DAV:\"/>".into(),
    ] {
        assert!(nextcloud_batch(xml).await.is_err());
    }
}
#[tokio::test]
async fn nextcloud_never_returns_truncated_folder_as_complete() {
    let doc = roxmltree::Document::parse(nextcloud_xml("valid")).unwrap();
    let responses: Vec<_> = doc
        .root_element()
        .children()
        .filter(|n| n.has_tag_name(("DAV:", "response")))
        .collect();
    let self_xml = &nextcloud_xml("valid")[responses[0].range()];
    let file_xml = &nextcloud_xml("valid")[responses[1].range()];
    let make = |count| {
        let mut s = format!(
            "<v:multistatus xmlns:v=\"DAV:\" xmlns:store=\"http://owncloud.org/ns\">{self_xml}"
        );
        for i in 0..count {
            s.push_str(
                &file_xml
                    .replace("101", &(1000 + i).to_string())
                    .replace("Gr%C3%BC%C3%9Fe%20%26%20Plan.txt", &format!("file{i}.txt")),
            );
        }
        s.push_str("</v:multistatus>");
        s
    };
    assert_eq!(nextcloud_batch(make(100)).await.unwrap().rows.len(), 100);
    assert!(nextcloud_batch(make(101)).await.is_err());
}
#[tokio::test]
async fn nextcloud_honors_instance_subpaths_and_encodes_folder_segments() {
    let mut c = config("nextcloud", "files");
    c.base_url = Some("https://cloud.example.org/cloud".into());
    c.folder_path = Some("/Team".into());
    let xml = nextcloud_xml("valid").replace("/remote.php/", "/cloud/remote.php/");
    let mock = Mock::start(vec![Response::builder()
        .status(207)
        .body(Body::from(xml))
        .unwrap()])
    .await;
    let batch = fetch_with(&c, Some(&credentials("nextcloud")), None, &mock.transport())
        .await
        .unwrap();
    assert_eq!(
        batch.rows[0].data["url"],
        "https://cloud.example.org/cloud/index.php/f/101"
    );
    assert_ne!(
        batch.rows[0].external_id,
        nextcloud_batch(nextcloud_xml("valid").into())
            .await
            .unwrap()
            .rows[0]
            .external_id
    );
    assert_eq!(
        mock.state.calls.lock().await[0].uri.path(),
        "/cloud/remote.php/dav/files/fixture/Team/"
    );
    c.folder_path = Some("/Grüße & Plan".into());
    let xml = nextcloud_xml("valid")
        .replace("/Team/", "/Gr%C3%BC%C3%9Fe%20&%20Plan/")
        .replace("&%20", "&amp;%20");
    c.base_url = Some("https://cloud.example.org".into());
    let mock = Mock::start(vec![Response::builder()
        .status(207)
        .body(Body::from(xml))
        .unwrap()])
    .await;
    assert!(
        fetch_with(&c, Some(&credentials("nextcloud")), None, &mock.transport())
            .await
            .is_ok()
    );
    assert_eq!(
        mock.state.calls.lock().await[0].uri.path(),
        "/remote.php/dav/files/fixture/Gr%C3%BC%C3%9Fe%20&%20Plan/"
    );
}
#[tokio::test]
async fn nextcloud_refuses_cursor_unshared_scope_and_wrong_success_status() {
    let mock = Mock::start(vec![response(200, json!({}), &[])]).await;
    let mut c = config("nextcloud", "files");
    assert!(fetch_with(
        &c,
        Some(&credentials("nextcloud")),
        Some("1".into()),
        &mock.transport()
    )
    .await
    .is_err());
    c.share_metadata = false;
    assert!(
        fetch_with(&c, Some(&credentials("nextcloud")), None, &mock.transport())
            .await
            .is_err()
    );
    assert!(mock.state.calls.lock().await.is_empty());
    c.share_metadata = true;
    assert!(
        fetch_with(&c, Some(&credentials("nextcloud")), None, &mock.transport())
            .await
            .is_err()
    );
}
