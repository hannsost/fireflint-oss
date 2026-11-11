//! Bounded read-only provider protocols. No provider-controlled URL is followed.
mod business;
pub(super) mod nextcloud;

use super::ImportRow;
use reqwest::{header, Method, Url};
use serde_json::{json, Value};
use sitegraph_db::hub::{ConnectorConfig, ConnectorCredentials};
use std::{collections::HashSet, time::Duration};

pub(super) const PAGE_SIZE: usize = 25;
const MAX_PAGES: usize = 4;
const MAX_RESPONSE: usize = 2 * 1024 * 1024;

#[derive(Debug)]
pub(super) struct ProviderError {
    pub code: &'static str,
    pub message: &'static str,
    pub retry_seconds: i64,
}
impl ProviderError {
    pub fn input(message: &'static str) -> Self {
        Self {
            code: "invalid_input",
            message,
            retry_seconds: 0,
        }
    }
    pub fn rate_limited(seconds: i64) -> Self {
        Self {code:"provider_rate_limited",message:"Der Anbieter begrenzt Abrufe oder ein Abruf läuft bereits. Nach der Wartezeit erneut versuchen.",retry_seconds:seconds.max(1)}
    }
    pub fn timeout() -> Self {
        Self {
            code: "provider_timeout",
            message: "Zeitlimit beim Anbieter erreicht. Es wurden keine Datensätze übernommen.",
            retry_seconds: 30,
        }
    }
    fn protocol() -> Self {
        Self {
            code: "provider_response",
            message: "Die Anbieterantwort entspricht nicht dem unterstützten Format.",
            retry_seconds: 0,
        }
    }
    fn transport() -> Self {
        Self {
            code: "provider_unavailable",
            message: "Der Anbieter ist nicht erreichbar. Verbindung und Zugang prüfen.",
            retry_seconds: 30,
        }
    }
}

pub(super) struct Batch {
    pub rows: Vec<ImportRow>,
    pub next_cursor: Option<String>,
}

pub(super) fn base_url(provider: &str, configured: Option<&str>) -> Result<Url, ProviderError> {
    let value = if matches!(provider, "hubspot" | "brevo") {
        if configured.is_some() {
            return Err(ProviderError::input(
                "Dieser Anbieter verwendet eine feste API-Adresse; keine Systemadresse angeben.",
            ));
        }
        if provider == "brevo" {
            "https://api.brevo.com"
        } else {
            "https://api.hubapi.com"
        }
    } else {
        configured.ok_or_else(|| ProviderError::input("HTTPS-Systemadresse ist erforderlich."))?
    };
    let invalid = || {
        ProviderError::input("Systemadresse muss eine HTTPS-Adresse auf Port 443 ohne Zugangsdaten, Parameter oder Fragment sein.")
    };
    if value.len() > 1800 || value.chars().any(char::is_control) || value.contains(['\\', '%']) {
        return Err(invalid());
    }
    let mut url = Url::parse(value).map_err(|_| invalid())?;
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    if provider == "shopify" {
        let host = url.host_str().unwrap();
        let shop = host.strip_suffix(".myshopify.com").ok_or_else(|| {
            ProviderError::input("Shopify benötigt die ursprüngliche shop.myshopify.com-Adresse.")
        })?;
        if shop.is_empty()
            || !shop
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            || url.path() != "/"
        {
            return Err(invalid());
        }
    }
    if provider == "pipedrive" {
        let company = url
            .host_str()
            .unwrap()
            .strip_suffix(".pipedrive.com")
            .ok_or_else(|| {
                ProviderError::input("Pipedrive benötigt die direkte firma.pipedrive.com-Adresse.")
            })?;
        if company.is_empty()
            || !company
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err(invalid());
        }
    }
    if !matches!(provider, "woocommerce" | "nextcloud") && url.path() != "/" {
        return Err(invalid());
    }
    let path = format!("{}/", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(url)
}

fn cursor(value: Option<&str>) -> Result<(), ProviderError> {
    if value.is_some_and(|v| v.is_empty() || v.len() > 2048 || v.chars().any(char::is_control)) {
        return Err(ProviderError::input("Ungültiger Seitencursor."));
    }
    Ok(())
}
fn number_cursor(value: Option<&str>, default: u64) -> Result<u64, ProviderError> {
    let n = value
        .map(str::parse::<u64>)
        .transpose()
        .map_err(|_| ProviderError::input("Ungültiger numerischer Seitencursor."))?
        .unwrap_or(default);
    if n > 1_000_000_000_000 {
        return Err(ProviderError::input(
            "Seitencursor liegt außerhalb des unterstützten Bereichs.",
        ));
    }
    Ok(n)
}

pub(super) fn retry_after(value: Option<&str>, now: chrono::DateTime<chrono::Utc>) -> i64 {
    value
        .and_then(|v| {
            v.parse::<i64>().ok().or_else(|| {
                chrono::DateTime::parse_from_rfc2822(v)
                    .ok()
                    .map(|d| (d.with_timezone(&chrono::Utc) - now).num_seconds() + 1)
            })
        })
        .unwrap_or(60)
        .clamp(1, 31_536_000)
}

#[derive(Default)]
pub(super) struct Transport {
    #[cfg(test)]
    pub mock_base: Option<String>,
}
struct Reply {
    value: Value,
    headers: header::HeaderMap,
}
struct RawReply {
    bytes: Vec<u8>,
    headers: header::HeaderMap,
}
impl Transport {
    async fn send(
        &self,
        config: &ConnectorConfig,
        credentials: &ConnectorCredentials,
        url: Url,
        body: Option<Value>,
    ) -> Result<Reply, ProviderError> {
        let reply = self.send_raw(config, credentials, url, body).await?;
        let value = serde_json::from_slice(&reply.bytes).map_err(|_| ProviderError::protocol())?;
        Ok(Reply {
            value,
            headers: reply.headers,
        })
    }
    async fn send_raw(
        &self,
        config: &ConnectorConfig,
        credentials: &ConnectorCredentials,
        url: Url,
        body: Option<Value>,
    ) -> Result<RawReply, ProviderError> {
        #[cfg(test)]
        let target = if let Some(base) = &self.mock_base {
            let mut local = Url::parse(base).unwrap();
            local.set_path(url.path());
            local.set_query(url.query());
            crate::outbound::connector_mock_target(local)
                .await
                .map_err(|_| ProviderError::transport())?
        } else {
            crate::outbound::connector_target(url.as_str())
                .await
                .map_err(|_| ProviderError {
                    code: "provider_target_rejected",
                    message: "Das Ziel muss ausschließlich auf öffentliche HTTPS-Adressen zeigen.",
                    retry_seconds: 0,
                })?
        };
        #[cfg(not(test))]
        let target = crate::outbound::connector_target(url.as_str())
            .await
            .map_err(|_| ProviderError {
                code: "provider_target_rejected",
                message: "Das Ziel muss ausschließlich auf öffentliche HTTPS-Adressen zeigen.",
                retry_seconds: 0,
            })?;
        let client = target
            .client(Duration::from_secs(12))
            .map_err(|_| ProviderError::transport())?;
        let mut request = client
            .request(
                if config.provider == "nextcloud" {
                    Method::from_bytes(b"PROPFIND").expect("static method")
                } else if body.is_some() {
                    Method::POST
                } else {
                    Method::GET
                },
                target.url,
            )
            .header(header::ACCEPT, "application/json")
            .header(header::USER_AGENT, "FireFlint/0.1 inbound-connector");
        if config.provider == "nextcloud" {
            request = request
                .basic_auth(
                    credentials
                        .username
                        .as_deref()
                        .ok_or_else(ProviderError::protocol)?,
                    credentials.app_password.as_deref(),
                )
                .header(header::ACCEPT, "application/xml")
                .header(header::CONTENT_TYPE, "application/xml; charset=utf-8")
                .header("Depth", "1")
                .body(nextcloud::PROPFIND);
        } else if config.provider == "woocommerce" {
            request = request.basic_auth(
                credentials
                    .consumer_key
                    .as_deref()
                    .ok_or_else(ProviderError::protocol)?,
                credentials.consumer_secret.as_deref(),
            );
        } else if config.provider == "erpnext" {
            let key = credentials
                .api_key
                .as_deref()
                .ok_or_else(ProviderError::protocol)?;
            let secret = credentials
                .api_secret
                .as_deref()
                .ok_or_else(ProviderError::protocol)?;
            let mut value = header::HeaderValue::from_str(&format!("token {key}:{secret}"))
                .map_err(|_| ProviderError::protocol())?;
            value.set_sensitive(true);
            request = request.header(header::AUTHORIZATION, value);
        } else {
            let token = credentials
                .token
                .as_deref()
                .ok_or_else(ProviderError::protocol)?;
            if matches!(config.provider.as_str(), "shopify" | "pipedrive" | "brevo") {
                let mut value =
                    header::HeaderValue::from_str(token).map_err(|_| ProviderError::protocol())?;
                value.set_sensitive(true);
                let name = match config.provider.as_str() {
                    "pipedrive" => "x-api-token",
                    "brevo" => "api-key",
                    _ => "X-Shopify-Access-Token",
                };
                request = request.header(name, value);
            } else {
                request = request.bearer_auth(token);
            }
        }
        if config.provider == "odoo" {
            if let Some(database) = &config.database {
                request = request.header("X-Odoo-Database", database);
            }
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let mut response = request.send().await.map_err(|e| {
            if e.is_timeout() {
                ProviderError::timeout()
            } else {
                ProviderError::transport()
            }
        })?;
        let status = response.status();
        if status.as_u16() == 429 {
            return Err(ProviderError::rate_limited(retry_after(
                response
                    .headers()
                    .get(header::RETRY_AFTER)
                    .and_then(|v| v.to_str().ok()),
                chrono::Utc::now(),
            )));
        }
        if matches!(status.as_u16(), 401 | 403) {
            return Err(ProviderError {
                code: "provider_authentication",
                message: "Der Anbieter lehnt Zugangsdaten oder Leseberechtigungen ab.",
                retry_seconds: 0,
            });
        }
        if status.is_redirection() {
            return Err(ProviderError {code:"provider_redirect",message:"Weiterleitungen werden nicht verfolgt. Die direkte Systemadresse konfigurieren.",retry_seconds:0});
        }
        if status.is_server_error() {
            return Err(ProviderError {
                code: "provider_unavailable",
                message: "Der Anbieter meldet einen Serverfehler.",
                retry_seconds: retry_after(
                    response
                        .headers()
                        .get(header::RETRY_AFTER)
                        .and_then(|v| v.to_str().ok()),
                    chrono::Utc::now(),
                ),
            });
        }
        if !status.is_success() {
            return Err(ProviderError {
                code: "provider_request_rejected",
                message:
                    "Der Anbieter lehnt den Leseabruf ab. API-Version und Konfiguration prüfen.",
                retry_seconds: 0,
            });
        }
        if config.provider == "nextcloud" && status.as_u16() != 207 {
            return Err(ProviderError::protocol());
        }
        if config.provider == "shopify"
            && response
                .headers()
                .get("x-shopify-api-version")
                .is_some_and(|v| v != "2026-07")
        {
            return Err(ProviderError {
                code: "provider_version",
                message:
                    "Shopify liefert eine andere API-Version als die unterstützte Version 2026-07.",
                retry_seconds: 0,
            });
        }
        let headers = response.headers().clone();
        if response
            .content_length()
            .is_some_and(|n| n > MAX_RESPONSE as u64)
        {
            return Err(ProviderError::protocol());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| ProviderError::transport())?
        {
            if bytes.len() + chunk.len() > MAX_RESPONSE {
                return Err(ProviderError::protocol());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(RawReply { bytes, headers })
    }
}

pub(super) async fn fetch(
    config: &ConnectorConfig,
    credentials: Option<&ConnectorCredentials>,
    start: Option<String>,
) -> Result<Batch, ProviderError> {
    fetch_with(config, credentials, start, &Transport::default()).await
}

pub(super) async fn fetch_with(
    config: &ConnectorConfig,
    credentials: Option<&ConnectorCredentials>,
    start: Option<String>,
    transport: &Transport,
) -> Result<Batch, ProviderError> {
    cursor(start.as_deref())?;
    let base = base_url(&config.provider, config.base_url.as_deref())?;
    let credentials = credentials.ok_or(ProviderError {
        code: "provider_authentication",
        message: "Gespeicherte Zugangsdaten fehlen.",
        retry_seconds: 0,
    })?;
    if config.provider == "nextcloud" {
        return nextcloud::fetch(config, credentials, &base, start, transport).await;
    }
    let mut next = start;
    let mut rows = Vec::new();
    let mut seen = HashSet::new();
    let mut seen_cursors = HashSet::new();
    if let Some(value) = &next {
        seen_cursors.insert(value.clone());
    }
    for _ in 0..MAX_PAGES {
        let (url, body) = request(config, &base, next.as_deref())?;
        let reply = transport.send(config, credentials, url, body).await?;
        let page = parse_page(config, reply, next.as_deref())?;
        if page.rows.len() > PAGE_SIZE || (page.rows.is_empty() && page.next_cursor.is_some()) {
            return Err(ProviderError::protocol());
        }
        for row in page.rows {
            if !seen.insert(row.external_id.clone()) {
                return Err(ProviderError::protocol());
            }
            rows.push(row);
        }
        next = page.next_cursor;
        if let Some(value) = &next {
            cursor(Some(value))?;
            if !seen_cursors.insert(value.clone()) {
                return Err(ProviderError::protocol());
            }
        } else {
            break;
        }
    }
    Ok(Batch {
        rows,
        next_cursor: next,
    })
}

fn request(
    config: &ConnectorConfig,
    base: &Url,
    current: Option<&str>,
) -> Result<(Url, Option<Value>), ProviderError> {
    let object = config.object_type.as_str();
    match config.provider.as_str() {
        "pipedrive" | "erpnext" | "brevo" => business::request(config, base, current),
        "hubspot" => {
            let properties = if object == "contacts" {
                "firstname,lastname,email,phone,jobtitle"
            } else {
                "name,website,phone,address,city,zip,country"
            };
            let mut url = base
                .join(&format!("crm/v3/objects/{object}"))
                .map_err(|_| ProviderError::protocol())?;
            url.query_pairs_mut()
                .append_pair("limit", &PAGE_SIZE.to_string())
                .append_pair("archived", "false")
                .append_pair("properties", properties);
            if let Some(c) = current {
                url.query_pairs_mut().append_pair("after", c);
            }
            Ok((url, None))
        }
        "woocommerce" => {
            let page = number_cursor(current, 1)?;
            if page == 0 {
                return Err(ProviderError::input("Seitennummer muss mindestens 1 sein."));
            }
            let mut url = base
                .join(&format!("wp-json/wc/v3/{object}"))
                .map_err(|_| ProviderError::protocol())?;
            url.query_pairs_mut()
                .append_pair("per_page", &PAGE_SIZE.to_string())
                .append_pair("page", &page.to_string())
                .append_pair("orderby", "id")
                .append_pair("order", "asc");
            Ok((url, None))
        }
        "shopify" => Ok((
            base.join("admin/api/2026-07/graphql.json").unwrap(),
            Some(
                json!({"query":"query FireFlintProducts($first: Int!, $after: String) { products(first: $first, after: $after, sortKey: ID) { nodes { id title description } pageInfo { hasNextPage endCursor } } }","variables":{"first":PAGE_SIZE,"after":current}}),
            ),
        )),
        "odoo" => {
            let last = number_cursor(current, 0)?;
            let (model, fields) = if object == "products" {
                (
                    "product.template",
                    json!(["id", "name", "default_code", "description_sale"]),
                )
            } else {
                (
                    "res.partner",
                    json!([
                        "id",
                        "name",
                        "email",
                        "phone",
                        "function",
                        "website",
                        "street",
                        "street2",
                        "city",
                        "zip",
                        "country_id",
                        "vat"
                    ]),
                )
            };
            let mut domain = vec![json!(["id", ">", last])];
            if object != "products" {
                domain.push(json!(["is_company", "=", object == "companies"]));
            }
            Ok((
                base.join(&format!("json/2/{model}/search_read")).unwrap(),
                Some(json!({"domain":domain,"fields":fields,"order":"id asc","limit":PAGE_SIZE})),
            ))
        }
        _ => Err(ProviderError::protocol()),
    }
}

fn array(value: &Value) -> Result<&Vec<Value>, ProviderError> {
    value.as_array().ok_or_else(ProviderError::protocol)
}
fn text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}
fn nonempty(value: &Value) -> Result<String, ProviderError> {
    let v = text(value);
    if v.trim().is_empty() {
        Err(ProviderError::protocol())
    } else {
        Ok(v)
    }
}
fn join_fields(value: &Value, fields: &[&str], delimiter: &str) -> String {
    fields
        .iter()
        .map(|k| text(&value[*k]))
        .filter(|v| !v.trim().is_empty())
        .collect::<Vec<_>>()
        .join(delimiter)
}
fn put(data: &mut Value, key: &str, value: String) {
    if !value.is_empty() {
        data[key] = json!(value);
    }
}

fn parse_page(
    config: &ConnectorConfig,
    reply: Reply,
    current: Option<&str>,
) -> Result<Batch, ProviderError> {
    if matches!(config.provider.as_str(), "pipedrive" | "erpnext" | "brevo") {
        return business::parse(config, &reply.value, current);
    }
    let v = &reply.value;
    let (items, next) = match config.provider.as_str() {
        "hubspot" => {
            let next = match v.pointer("/paging/next") {
                None | Some(Value::Null) => None,
                Some(n) => Some(nonempty(&n["after"])?),
            };
            (array(&v["results"])?, next)
        }
        "woocommerce" => {
            let items = array(v)?;
            let page = number_cursor(current, 1)?;
            let more = if let Some(total) = reply.headers.get("x-wp-totalpages") {
                page < total
                    .to_str()
                    .ok()
                    .and_then(|s| s.parse::<u64>().ok())
                    .ok_or_else(ProviderError::protocol)?
            } else {
                items.len() == PAGE_SIZE
            };
            (items, more.then(|| (page + 1).to_string()))
        }
        "shopify" => {
            if let Some(errors) = v.get("errors") {
                if !errors.as_array().is_some_and(|e| e.is_empty()) {
                    let throttled = errors.as_array().is_some_and(|e| {
                        e.iter()
                            .any(|e| e.pointer("/extensions/code") == Some(&json!("THROTTLED")))
                    });
                    if throttled {
                        let cost = &v["extensions"]["cost"];
                        let available = cost["throttleStatus"]["currentlyAvailable"]
                            .as_f64()
                            .unwrap_or(0.0);
                        let restore = cost["throttleStatus"]["restoreRate"]
                            .as_f64()
                            .unwrap_or(0.0);
                        let requested = cost["requestedQueryCost"].as_f64().unwrap_or(0.0);
                        let seconds = if restore > 0.0 && requested > available {
                            ((requested - available) / restore).ceil() as i64
                        } else {
                            60
                        };
                        return Err(ProviderError::rate_limited(seconds.clamp(1, 31_536_000)));
                    }
                    return Err(ProviderError {code:"provider_graphql",message:"Shopify meldet einen GraphQL-Fehler. Teilantworten werden nicht übernommen.",retry_seconds:0});
                }
            }
            let products = &v["data"]["products"];
            let more = products["pageInfo"]["hasNextPage"]
                .as_bool()
                .ok_or_else(ProviderError::protocol)?;
            (
                array(&products["nodes"])?,
                if more {
                    Some(nonempty(&products["pageInfo"]["endCursor"])?)
                } else {
                    None
                },
            )
        }
        "odoo" => {
            let items = array(v)?;
            let mut previous = number_cursor(current, 0)?;
            for item in items {
                let id = item["id"].as_u64().ok_or_else(ProviderError::protocol)?;
                if id <= previous {
                    return Err(ProviderError::protocol());
                }
                previous = id;
            }
            (
                items,
                (items.len() == PAGE_SIZE).then(|| previous.to_string()),
            )
        }
        _ => return Err(ProviderError::protocol()),
    };
    let rows = items
        .iter()
        .map(|item| map_row(config, item))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Batch {
        rows,
        next_cursor: next,
    })
}

fn map_row(config: &ConnectorConfig, item: &Value) -> Result<ImportRow, ProviderError> {
    let id = nonempty(&item["id"])?;
    let object = config.object_type.as_str();
    let mut data = json!({});
    let (kind, name) = match (config.provider.as_str(), object) {
        ("hubspot", "contacts") => {
            let p = &item["properties"];
            let mut name = join_fields(p, &["firstname", "lastname"], " ");
            if name.is_empty() {
                name = nonempty(&p["email"])?;
            }
            put(&mut data, "email", text(&p["email"]));
            put(&mut data, "phone", text(&p["phone"]));
            put(&mut data, "position", text(&p["jobtitle"]));
            ("contact", name)
        }
        ("hubspot", "companies") => {
            let p = &item["properties"];
            let name = nonempty(&p["name"])?;
            let mut website = text(&p["website"]);
            if !website.is_empty() && !website.contains("://") {
                website = format!("https://{website}");
            }
            put(&mut data, "website", website);
            put(&mut data, "phone", text(&p["phone"]));
            put(
                &mut data,
                "address",
                join_fields(p, &["address", "zip", "city", "country"], ", "),
            );
            ("company", name)
        }
        ("woocommerce", "customers") => {
            let mut name = join_fields(item, &["first_name", "last_name"], " ");
            if name.is_empty() {
                name = nonempty(&item["email"])?;
            }
            put(&mut data, "email", text(&item["email"]));
            put(&mut data, "phone", text(&item["billing"]["phone"]));
            ("contact", name)
        }
        ("woocommerce", "products") => {
            put(&mut data, "sku", text(&item["sku"]));
            put(&mut data, "description", text(&item["description"]));
            ("product", nonempty(&item["name"])?)
        }
        ("shopify", "products") => {
            put(&mut data, "description", text(&item["description"]));
            ("product", nonempty(&item["title"])?)
        }
        ("odoo", "products") => {
            put(&mut data, "sku", text(&item["default_code"]));
            put(&mut data, "description", text(&item["description_sale"]));
            ("product", nonempty(&item["name"])?)
        }
        ("odoo", "companies" | "contacts") => {
            put(&mut data, "email", text(&item["email"]));
            put(&mut data, "phone", text(&item["phone"]));
            if object == "companies" {
                put(&mut data, "website", text(&item["website"]));
                put(&mut data, "tax_id", text(&item["vat"]));
                let mut address = join_fields(item, &["street", "street2", "zip", "city"], ", ");
                if let Some(country) = item["country_id"]
                    .as_array()
                    .and_then(|a| a.get(1))
                    .and_then(Value::as_str)
                {
                    if !address.is_empty() {
                        address.push_str(", ");
                    }
                    address.push_str(country);
                }
                put(&mut data, "address", address);
            } else {
                put(&mut data, "position", text(&item["function"]));
            }
            (
                if object == "companies" {
                    "company"
                } else {
                    "contact"
                },
                nonempty(&item["name"])?,
            )
        }
        _ => return Err(ProviderError::protocol()),
    };
    data[if kind == "company" {
        "legal_name"
    } else {
        "name"
    }] = json!(name);
    // Namespaced IDs avoid collisions between object families sharing a source.
    Ok(ImportRow {
        external_id: format!("{}:{id}", config.object_type),
        kind: kind.into(),
        name,
        data,
        expected_revision: None,
    })
}
