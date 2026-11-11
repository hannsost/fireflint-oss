//! Explicit inbound fetch → saved preview → revision-checked import.
mod discovery;
mod files;
mod providers;
#[cfg(test)]
mod tests;

use super::*;
use sitegraph_db::hub::{ConnectorInput, ConnectorMapping, HubError, ImportRow};
use std::time::Duration;

static FETCH_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/hub/connectors/catalog", get(catalog))
        .route("/orgs/:org/hub/connectors", get(list).post(create))
        .route("/orgs/:org/hub/connectors/inspect-file", post(inspect_file))
        .route("/orgs/:org/hub/connectors/:id", put(update))
        .route("/orgs/:org/hub/connectors/:id/preview", post(preview))
        .route(
            "/orgs/:org/hub/connectors/:id/previews/:preview",
            get(saved_preview),
        )
        .route(
            "/orgs/:org/hub/connectors/:id/previews/:preview/apply",
            post(apply),
        )
        .layer(DefaultBodyLimit::max(512 * 1024))
}

async fn catalog() -> Json<Value> {
    Json(json!([
        {"key":"hubspot","name":"HubSpot","version":"CRM v3","direction":"inbound","objects":[{"key":"contacts","kind":"contact","label":"Kontakte"},{"key":"companies","kind":"company","label":"Unternehmen"}],"credential_fields":["token"],"settings_fields":[],"features":["crm.objects.contacts.read / crm.objects.companies.read","Cursor-Pagination","Name, E-Mail, Telefon, Position / Firmenadresse"],"limitations":["Keine Beziehungen, Löschungen oder Rückschreibungen","Bestehender privater App-Zugriffstoken erforderlich"]},
        {"key":"woocommerce","name":"WooCommerce","version":"WP REST API wc/v3","direction":"inbound","objects":[{"key":"products","kind":"product","label":"Produkte"},{"key":"customers","kind":"contact","label":"Kunden"}],"credential_fields":["consumer_key","consumer_secret"],"settings_fields":["base_url"],"features":["Lesender API-Schlüssel","Produktname, SKU, Beschreibung / Kundenname, E-Mail, Telefon","Seiten-Pagination"],"limitations":["Keine Varianten, Preise, Bestellungen oder Rückschreibungen"]},
        {"key":"shopify","name":"Shopify","version":"Admin GraphQL 2026-07","direction":"inbound","objects":[{"key":"products","kind":"product","label":"Produktkatalog"}],"credential_fields":["token"],"settings_fields":["base_url"],"features":["read_products","Produktname und Textbeschreibung","GraphQL-Cursor-Pagination"],"limitations":["Keine Varianten, SKU, Preise, Bestände oder Rückschreibungen","Bestehender Admin-API-Zugriffstoken erforderlich"]},
        {"key":"odoo","name":"Odoo","version":"19 JSON-2","direction":"inbound","objects":[{"key":"companies","kind":"company","label":"Unternehmen"},{"key":"contacts","kind":"contact","label":"Kontakte"},{"key":"products","kind":"product","label":"Produkte"}],"credential_fields":["token"],"settings_fields":["base_url","database"],"features":["res.partner / product.template search_read","API-Key mit Leserechten","ID-Pagination"],"limitations":["Odoo 19+ mit JSON-2 und freigeschaltetem externem API-Zugang","Keine Varianten, Preise oder Rückschreibungen"]},
        {"key":"pipedrive","name":"Pipedrive","version":"API v2","direction":"inbound","objects":[{"key":"persons","kind":"contact","label":"Kontakte"},{"key":"organizations","kind":"company","label":"Unternehmen"}],"credential_fields":["token"],"settings_fields":["base_url"],"base_url_placeholder":"https://firma.pipedrive.com","setup_hint":"Die Pipedrive-Firmenadresse und den API-Token eines Benutzers mit Zugriff auf die gewünschten Kontakte angeben. FireFlint verwendet ausschließlich Leseabrufe; der Token selbst kann weitergehende Rechte besitzen.","features":["Name, primäre E-Mail, Telefon und optionale Position / Firmenadresse","Cursor-Pagination"],"limitations":["Keine Deals, Aktivitäten, Beziehungen oder Rückschreibungen","Bestehender benutzer- und firmengebundener API-Token erforderlich"]},
        {"key":"erpnext","name":"ERPNext","version":"Frappe REST v1 / ERPNext 15+","direction":"inbound","objects":[{"key":"customers","kind":"company","label":"Firmenkunden"},{"key":"suppliers","kind":"company","label":"Firmenlieferanten"},{"key":"products","kind":"product","label":"Artikel"}],"credential_fields":["api_key","api_secret"],"settings_fields":["base_url"],"base_url_placeholder":"https://erp.example.org","setup_hint":"API-Key und API-Secret eines eigenen ERPNext-Benutzers hinterlegen. Er benötigt Leserechte für Customer, Supplier oder Item. Die Instanz muss über öffentlich erreichbares HTTPS auf Port 443 erreichbar sein.","features":["Customer / Supplier / Item","Firmenname und Steuerkennung / Artikelname, Artikelnummer und Beschreibung","Nach Kennung sortierte Pagination"],"limitations":["Nur Firmenkunden/-lieferanten, keine Privatpersonen","Keine Belege, Preise, Bestände, Variantenbeziehungen oder Rückschreibungen"]},
        {"key":"brevo","name":"Brevo","version":"Contacts API v3","direction":"inbound","objects":[{"key":"contacts","kind":"contact","label":"Kontakte"}],"credential_fields":["token"],"settings_fields":[],"setup_hint":"Einen Brevo-API-Key für den Kontaktabruf hinterlegen. Der Schlüssel wird ausschließlich serverseitig verwendet. Ein importierter Kontakt ist keine Versandfreigabe.","features":["Kontaktname, E-Mail und Telefonnummer aus Standardattributen","Offset-Pagination"],"limitations":["Keine Kampagnen, Versandaktionen oder Listenänderungen","Einwilligungen und Sperrlisten bleiben in Brevo; der Import erteilt keine Marketingfreigabe"]},
        {"key":"nextcloud","name":"Nextcloud","version":"WebDAV / Depth 1","direction":"inbound","objects":[{"key":"files","kind":"external_document","label":"Dokumentverweise"}],"credential_fields":["username","app_password"],"settings_fields":["base_url","folder_path","share_metadata"],"base_url_placeholder":"https://cloud.example.org","setup_hint":"Die Instanzadresse, den Benutzernamen aus den Nextcloud-Sicherheitseinstellungen und ein App-Passwort angeben. Ein eigener Benutzer sollte nur den vorgesehenen Ordner lesen können. Öffentlich erreichbares HTTPS auf Port 443 ist erforderlich.","features":["Dokumentbezeichnung, Originalverweis, Dateityp, Größe und Quellstand","Ausdrücklich ausgewählter Ordner","Vorschau vor Übernahme"],"limitations":["Höchstens 100 direkte Dateien, keine Unterordner oder Dateiinhalte","Metadaten sind nach Freigabe im gesamten Arbeitsbereich sichtbar; keine Spiegelung persönlicher Nextcloud-Rechte","Keine Löschsynchronisation, öffentlichen Freigaben oder Rückschreibungen"]},
        {"key":"csv","name":"CSV","version":"UTF-8 / RFC 4180","direction":"inbound","objects":[{"key":"rows","kind":"mapped","label":"Gemappte Datensätze"}],"credential_fields":[],"settings_fields":["mapping"],"features":["Spaltenzuordnung","Komma, Semikolon oder Tab","Zitierte und mehrzeilige Felder"],"limitations":["Höchstens 100 Zeilen / 512 KiB Anfrage"]},
        {"key":"json","name":"JSON","version":"JSON object array","direction":"inbound","objects":[{"key":"rows","kind":"mapped","label":"Gemappte Datensätze"}],"credential_fields":[],"settings_fields":["mapping"],"features":["Feldzuordnung über Punktpfade","Unternehmen, Kontakte, Standorte, Produkte"],"limitations":["Höchstens 100 Objekte / 512 KiB Anfrage","Keine Skripte oder beliebigen Transformationen"]}
    ]))
}

fn invalid(message: &str) -> ApiError {
    ApiError::BadRequest(message.into())
}

fn validate_mapping(mapping: &ConnectorMapping) -> ApiResult<()> {
    if !matches!(
        mapping.kind.as_str(),
        "company" | "contact" | "location" | "product"
    ) {
        return Err(invalid(
            "Dieser Datentyp wird für Dateiimporte nicht unterstützt.",
        ));
    }
    if !matches!(mapping.delimiter.as_str(), "," | ";" | "\t") {
        return Err(invalid("Trennzeichen muss Komma, Semikolon oder Tab sein."));
    }
    let kind = sitegraph_company_hub::kinds()
        .into_iter()
        .find(|k| k.key == mapping.kind)
        .unwrap();
    for path in std::iter::once(&mapping.name)
        .chain(std::iter::once(&mapping.external_id))
        .chain(mapping.fields.values())
    {
        if path.trim().is_empty() || path.len() > 240 || path.chars().any(char::is_control) {
            return Err(invalid(
                "Feldzuordnungen brauchen nichtleere Spaltennamen/Pfade bis 240 Zeichen.",
            ));
        }
    }
    if mapping
        .fields
        .keys()
        .any(|k| !kind.fields.iter().any(|f| &f.key == k))
        || kind
            .fields
            .iter()
            .any(|f| f.required && !mapping.fields.contains_key(&f.key))
    {
        return Err(invalid(
            "Feldzuordnung enthält unbekannte Felder oder lässt Pflichtfelder aus.",
        ));
    }
    Ok(())
}

fn validate(body: &ConnectorInput) -> ApiResult<()> {
    let file = matches!(body.provider.as_str(), "csv" | "json");
    let supported = match body.provider.as_str() {
        "hubspot" => matches!(body.object_type.as_str(), "contacts" | "companies"),
        "woocommerce" => matches!(body.object_type.as_str(), "customers" | "products"),
        "shopify" => body.object_type == "products",
        "pipedrive" => matches!(body.object_type.as_str(), "persons" | "organizations"),
        "erpnext" => matches!(
            body.object_type.as_str(),
            "customers" | "suppliers" | "products"
        ),
        "brevo" => body.object_type == "contacts",
        "nextcloud" => body.object_type == "files",
        "odoo" => matches!(
            body.object_type.as_str(),
            "contacts" | "companies" | "products"
        ),
        "csv" | "json" => body.object_type == "rows",
        _ => false,
    };
    if !supported {
        return Err(invalid(
            "Unbekannter Anbieter oder nicht unterstützter Objekttyp.",
        ));
    }
    if body.provider == "nextcloud" {
        providers::nextcloud::validate_folder(body.folder_path.as_deref())
            .map_err(|e| invalid(e.message))?;
        if !body.share_metadata {
            return Err(invalid(
                "Die Freigabe der Metadaten für den gesamten Arbeitsbereich ist erforderlich.",
            ));
        }
    } else if body.folder_path.is_some() || body.share_metadata {
        return Err(invalid(
            "Ordner und Metadatenfreigabe sind nur für Nextcloud zulässig.",
        ));
    }
    if file {
        if body.credentials.is_some() || body.base_url.is_some() || body.database.is_some() {
            return Err(invalid(
                "Dateiimporte benötigen keine Zugangsdaten oder Systemadresse.",
            ));
        }
        validate_mapping(
            body.mapping
                .as_ref()
                .ok_or_else(|| invalid("Feldzuordnung ist erforderlich."))?,
        )?;
    } else {
        if body.mapping.is_some() {
            return Err(invalid(
                "Dieser Adapter verwendet eine feste Feldzuordnung.",
            ));
        }
        providers::base_url(&body.provider, body.base_url.as_deref())
            .map_err(|e| invalid(e.message))?;
        if let Some(database) = &body.database {
            if body.provider != "odoo"
                || database.is_empty()
                || database.len() > 128
                || !database
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b))
            {
                return Err(invalid("Ungültiger Odoo-Datenbankname."));
            }
        }
        if let Some(credentials) = &body.credentials {
            let good = |s: &Option<String>| {
                s.as_ref().is_some_and(|v| {
                    !v.trim().is_empty() && v.len() <= 4096 && !v.chars().any(char::is_control)
                })
            };
            let no_pair = credentials.api_key.is_none() && credentials.api_secret.is_none();
            let no_consumer =
                credentials.consumer_key.is_none() && credentials.consumer_secret.is_none();
            let no_nextcloud = credentials.username.is_none() && credentials.app_password.is_none();
            let valid = if body.provider == "nextcloud" {
                no_pair
                    && no_consumer
                    && credentials.token.is_none()
                    && good(&credentials.app_password)
                    && credentials
                        .username
                        .as_deref()
                        .is_some_and(providers::nextcloud::valid_username)
            } else if !no_nextcloud {
                false
            } else if body.provider == "erpnext" {
                good(&credentials.api_key)
                    && good(&credentials.api_secret)
                    && !credentials.api_key.as_ref().unwrap().contains(':')
                    && !credentials.api_secret.as_ref().unwrap().contains(':')
                    && credentials.token.is_none()
                    && no_consumer
            } else if body.provider == "woocommerce" {
                no_pair
                    && good(&credentials.consumer_key)
                    && good(&credentials.consumer_secret)
                    && credentials.token.is_none()
                    && !credentials.consumer_key.as_ref().unwrap().contains(':')
            } else {
                no_pair
                    && good(&credentials.token)
                    && credentials.consumer_key.is_none()
                    && credentials.consumer_secret.is_none()
            };
            if !valid {
                return Err(invalid(
                    "Zugangsdaten fehlen, sind ungültig oder enthalten nicht unterstützte Felder.",
                ));
            }
        }
    }
    Ok(())
}

async fn inspect_file(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    Json(body): Json<discovery::InspectInput>,
) -> Result<Json<discovery::Inspection>, ConnectorError> {
    authorize(&s, org, u.user_id, Role::Owner).await?;
    s.db.hub_enabled(org, "integrations").await?;
    Ok(Json(discovery::inspect(body)?))
}

async fn list(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Viewer).await?;
    Ok(Json(s.db.hub_connectors(org).await?))
}
async fn create(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    Json(body): Json<ConnectorInput>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Owner).await?;
    validate(&body)?;
    Ok(Json(
        s.db.hub_save_connector(org, u.user_id, None, body).await?,
    ))
}
async fn update(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Json(body): Json<ConnectorInput>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Owner).await?;
    validate(&body)?;
    Ok(Json(
        s.db.hub_save_connector(org, u.user_id, Some(id), body)
            .await?,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewInput {
    expected_revision: Option<i64>,
    content: Option<String>,
    cursor: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ApplyInput {
    expected_revision: Option<i64>,
}

enum ConnectorError {
    Api(ApiError),
    Provider(providers::ProviderError),
}
impl From<ApiError> for ConnectorError {
    fn from(e: ApiError) -> Self {
        Self::Api(e)
    }
}
impl From<HubError> for ConnectorError {
    fn from(e: HubError) -> Self {
        Self::Api(e.into())
    }
}
impl From<providers::ProviderError> for ConnectorError {
    fn from(e: providers::ProviderError) -> Self {
        Self::Provider(e)
    }
}
impl IntoResponse for ConnectorError {
    fn into_response(self) -> Response {
        match self {
            Self::Api(e) => e.into_response(),
            Self::Provider(e) => {
                let status = match e.code {
                    "provider_rate_limited" => StatusCode::TOO_MANY_REQUESTS,
                    "invalid_input" => StatusCode::BAD_REQUEST,
                    _ => StatusCode::BAD_GATEWAY,
                };
                let mut response = (status,Json(json!({"error":e.message,"code":e.code,"retry_after_seconds":e.retry_seconds}))).into_response();
                if e.retry_seconds > 0 {
                    response.headers_mut().insert(
                        axum::http::header::RETRY_AFTER,
                        e.retry_seconds.to_string().parse().expect("integer header"),
                    );
                }
                response
            }
        }
    }
}

async fn preview(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Json(body): Json<PreviewInput>,
) -> Result<Json<Value>, ConnectorError> {
    authorize(&s, org, u.user_id, Role::Editor).await?;
    let _slot = FETCH_SLOTS
        .try_acquire()
        .map_err(|_| ApiError::TooManyRequests)?;
    let fetch =
        s.db.hub_connector_start(org, u.user_id, id, body.expected_revision)
            .await?;
    if fetch.retry_after_seconds > 0 {
        return Err(providers::ProviderError::rate_limited(fetch.retry_after_seconds).into());
    }
    let result = if matches!(fetch.config.provider.as_str(), "csv" | "json") {
        if body.cursor.is_some() {
            Err(providers::ProviderError::input(
                "Dateiimporte unterstützen keinen Cursor.",
            ))
        } else {
            files::parse(&fetch.config, body.content.as_deref().unwrap_or(""))
        }
    } else if body.content.is_some() {
        Err(providers::ProviderError::input(
            "Online-Adapter akzeptieren keine hochgeladenen Inhalte.",
        ))
    } else {
        tokio::time::timeout(
            Duration::from_secs(50),
            providers::fetch(&fetch.config, fetch.credentials.as_ref(), body.cursor),
        )
        .await
        .unwrap_or_else(|_| Err(providers::ProviderError::timeout()))
    };
    match result {
        Ok(batch) => match s
            .db
            .hub_connector_capture(org, u.user_id, &fetch, batch.rows, batch.next_cursor)
            .await
        {
            Ok(report) => Ok(Json(report)),
            Err(e) => {
                s.db.hub_connector_failed(org,id,fetch.lease_id,json!({"code":"preview_rejected","message":"Vorschau konnte nicht gespeichert werden. Konfiguration und Daten prüfen."}),0).await?;
                Err(e.into())
            }
        },
        Err(e) => {
            s.db.hub_connector_failed(
                org,
                id,
                fetch.lease_id,
                json!({"code":e.code,"message":e.message}),
                e.retry_seconds,
            )
            .await?;
            Err(e.into())
        }
    }
}
async fn saved_preview(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id, preview)): Path<(Uuid, Uuid, Uuid)>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Viewer).await?;
    Ok(Json(s.db.hub_connector_preview(org, id, preview).await?))
}
async fn apply(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id, preview)): Path<(Uuid, Uuid, Uuid)>,
    Json(body): Json<ApplyInput>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Editor).await?;
    Ok(Json(
        s.db.hub_connector_apply(org, u.user_id, id, preview, body.expected_revision)
            .await?,
    ))
}
