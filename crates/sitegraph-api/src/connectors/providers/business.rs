//! Fixed, read-only business APIs; no runtime scripts or provider URLs.
use super::*;

pub(super) fn request(
    config: &ConnectorConfig,
    base: &Url,
    current: Option<&str>,
) -> Result<(Url, Option<Value>), ProviderError> {
    let mut url = match config.provider.as_str() {
        "pipedrive" => {
            let path = match config.object_type.as_str() {
                "persons" => "api/v2/persons",
                "organizations" => "api/v2/organizations",
                _ => return Err(ProviderError::protocol()),
            };
            let mut url = base.join(path).map_err(|_| ProviderError::protocol())?;
            url.query_pairs_mut()
                .append_pair("limit", &PAGE_SIZE.to_string())
                .append_pair("sort_by", "id")
                .append_pair("sort_direction", "asc");
            if let Some(value) = current {
                url.query_pairs_mut().append_pair("cursor", value);
            }
            url
        }
        "erpnext" => {
            let (doctype, fields, filters) = match config.object_type.as_str() {
                "customers" => (
                    "Customer",
                    json!(["name", "customer_name", "customer_type", "tax_id"]),
                    json!([["customer_type", "=", "Company"]]),
                ),
                "suppliers" => (
                    "Supplier",
                    json!(["name", "supplier_name", "supplier_type", "tax_id"]),
                    json!([["supplier_type", "=", "Company"]]),
                ),
                "products" => (
                    "Item",
                    json!(["name", "item_name", "item_code", "description"]),
                    json!([]),
                ),
                _ => return Err(ProviderError::protocol()),
            };
            let mut url = base
                .join(&format!("api/resource/{doctype}"))
                .map_err(|_| ProviderError::protocol())?;
            url.query_pairs_mut()
                .append_pair("fields", &fields.to_string())
                .append_pair("filters", &filters.to_string())
                .append_pair("order_by", "name asc")
                .append_pair("limit_page_length", &PAGE_SIZE.to_string())
                .append_pair("limit_start", &number_cursor(current, 0)?.to_string());
            url
        }
        "brevo" if config.object_type == "contacts" => {
            let mut url = base
                .join("v3/contacts")
                .map_err(|_| ProviderError::protocol())?;
            url.query_pairs_mut()
                .append_pair("limit", &PAGE_SIZE.to_string())
                .append_pair("offset", &number_cursor(current, 0)?.to_string())
                .append_pair("sort", "asc");
            url
        }
        _ => return Err(ProviderError::protocol()),
    };
    url.set_fragment(None);
    Ok((url, None))
}

pub(super) fn parse(
    config: &ConnectorConfig,
    value: &Value,
    current: Option<&str>,
) -> Result<Batch, ProviderError> {
    let (items, next_cursor) = match config.provider.as_str() {
        "pipedrive" => {
            if value["success"] != true {
                return Err(ProviderError::protocol());
            }
            let next = match value.pointer("/additional_data/next_cursor") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
                _ => return Err(ProviderError::protocol()),
            };
            // A malformed pagination envelope must not masquerade as completion.
            if !value["additional_data"].is_object() {
                return Err(ProviderError::protocol());
            }
            (array(&value["data"])?, next)
        }
        "erpnext" => {
            if value.get("exc").is_some() || value.get("exception").is_some() {
                return Err(ProviderError::protocol());
            }
            let items = array(&value["data"])?;
            let next = number_cursor(current, 0)? + items.len() as u64;
            (items, (items.len() == PAGE_SIZE).then(|| next.to_string()))
        }
        "brevo" => {
            let items = array(&value["contacts"])?;
            let total = value["count"]
                .as_u64()
                .ok_or_else(ProviderError::protocol)?;
            let start = number_cursor(current, 0)?;
            let next = start + items.len() as u64;
            // A short final page is valid, but contradictory totals are not.
            if !items.is_empty() && next > total {
                return Err(ProviderError::protocol());
            }
            (items, (next < total).then(|| next.to_string()))
        }
        _ => return Err(ProviderError::protocol()),
    };
    let rows = items
        .iter()
        .map(|item| map(config, item))
        .collect::<Result<_, _>>()?;
    Ok(Batch { rows, next_cursor })
}

fn optional(value: &Value) -> Result<String, ProviderError> {
    match value {
        Value::Null => Ok(String::new()),
        Value::String(s) => Ok(s.clone()),
        _ => Err(ProviderError::protocol()),
    }
}
fn required(value: &Value) -> Result<String, ProviderError> {
    let s = optional(value)?;
    if s.trim().is_empty() {
        return Err(ProviderError::protocol());
    }
    Ok(s)
}
fn primary(value: &Value) -> Result<String, ProviderError> {
    if value.is_null() {
        return Ok(String::new());
    }
    let values = array(value)?;
    let mut first = String::new();
    let mut chosen = None;
    for entry in values {
        if !entry.is_object() {
            return Err(ProviderError::protocol());
        }
        let text = optional(&entry["value"])?;
        if text.trim().is_empty() {
            continue;
        }
        if first.is_empty() {
            first = text.clone();
        }
        match entry.get("primary") {
            Some(Value::Bool(true)) => {
                if chosen.is_some() {
                    return Err(ProviderError::protocol());
                }
                chosen = Some(text);
            }
            None | Some(Value::Bool(false)) => {}
            _ => return Err(ProviderError::protocol()),
        }
    }
    Ok(chosen.unwrap_or(first))
}
fn map(config: &ConnectorConfig, item: &Value) -> Result<ImportRow, ProviderError> {
    let provider = config.provider.as_str();
    let object = config.object_type.as_str();
    let id = if provider == "erpnext" {
        required(&item["name"])?
    } else {
        item["id"]
            .as_u64()
            .filter(|id| *id > 0)
            .ok_or_else(ProviderError::protocol)?
            .to_string()
    };
    let mut data = json!({});
    if provider == "pipedrive" && item.get("is_deleted").is_some_and(|v| v != &json!(false)) {
        return Err(ProviderError::protocol());
    }
    let (kind, name) = match (provider, object) {
        ("pipedrive", "persons") => {
            put(&mut data, "email", primary(&item["emails"])?);
            put(&mut data, "phone", primary(&item["phones"])?);
            put(&mut data, "position", optional(&item["job_title"])?);
            ("contact", required(&item["name"])?)
        }
        ("pipedrive", "organizations") => {
            if !item["address"].is_null() && !item["address"].is_object() {
                return Err(ProviderError::protocol());
            }
            put(&mut data, "address", optional(&item["address"]["value"])?);
            ("company", required(&item["name"])?)
        }
        ("erpnext", "customers" | "suppliers") => {
            let prefix = if object == "customers" {
                "customer"
            } else {
                "supplier"
            };
            if item[format!("{prefix}_type")] != "Company" {
                return Err(ProviderError::protocol());
            }
            put(&mut data, "tax_id", optional(&item["tax_id"])?);
            ("company", required(&item[format!("{prefix}_name")])?)
        }
        ("erpnext", "products") => {
            put(&mut data, "sku", required(&item["item_code"])?);
            put(&mut data, "description", optional(&item["description"])?);
            ("product", required(&item["item_name"])?)
        }
        ("brevo", "contacts") => {
            let attrs = &item["attributes"];
            if !attrs.is_null() && !attrs.is_object() {
                return Err(ProviderError::protocol());
            }
            let mut names = Vec::new();
            for aliases in [["FIRSTNAME", "FIRST_NAME"], ["LASTNAME", "LAST_NAME"]] {
                let mut part = optional(&attrs[aliases[0]])?;
                if part.trim().is_empty() {
                    part = optional(&attrs[aliases[1]])?;
                }
                if !part.trim().is_empty() {
                    names.push(part);
                }
            }
            let email = optional(&item["email"])?;
            let phone = optional(&attrs["SMS"])?;
            let name = if names.is_empty() {
                if email.is_empty() {
                    phone.clone()
                } else {
                    email.clone()
                }
            } else {
                names.join(" ")
            };
            if name.trim().is_empty() {
                return Err(ProviderError::protocol());
            }
            put(&mut data, "email", email);
            put(&mut data, "phone", phone);
            ("contact", name)
        }
        _ => return Err(ProviderError::protocol()),
    };
    data[if kind == "company" {
        "legal_name"
    } else {
        "name"
    }] = json!(name);
    Ok(ImportRow {
        external_id: format!("{object}:{id}"),
        kind: kind.into(),
        name,
        data,
        expected_revision: None,
    })
}
