//! Strict receiver for the pinned FlintPlate menu snapshot v1.
//!
//! The source hash covers normalized items only. It grants no tenant access and
//! is neither a FireFlint revision nor a monotonically increasing source version.
use chrono::DateTime;
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::{json, Map, Number, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fmt;
use uuid::Uuid;

const MAX_INPUT_BYTES: usize = 500 * 1024;
const MAX_STRING_BYTES: usize = 16_384;
const MAX_ITEMS: usize = 500;
const MAX_DEPTH: usize = 64;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

type DecodeResult<T> = Result<T, String>;

/// Decode, validate, normalize and verify the source hash before returning data.
///
/// Unknown root fields are rejected; nested extras are checked as JSON (including
/// duplicate keys) and then discarded, matching the pinned source normalization.
/// Receiver limits additionally bound size, depth, identifiers and numeric ranges.
/// NUL is rejected because the normalized value is destined for PostgreSQL JSONB.
pub fn decode_snapshot(input: &str, expected_venue: Uuid) -> Result<Value, String> {
    if input.len() > MAX_INPUT_BYTES {
        return Err("Snapshot darf höchstens 500 KiB groß sein.".into());
    }
    let mut deserializer = serde_json::Deserializer::from_str(input);
    let raw = CheckedJson { depth: 0 }
        .deserialize(&mut deserializer)
        .map_err(|_| {
            "Snapshot enthält ungültiges JSON, doppelte Schlüssel oder überschrittene Strukturgrenzen."
                .to_owned()
        })?;
    deserializer
        .end()
        .map_err(|_| "Nach dem Snapshot sind keine weiteren JSON-Daten erlaubt.".to_owned())?;
    let root = object(&raw, "Snapshot")?;
    const FIELDS: &[&str] = &[
        "schema_version",
        "source_system",
        "venue_id",
        "menu_id",
        "menu_revision",
        "currency",
        "timezone",
        "published_at",
        "items",
    ];
    if root.keys().any(|key| !FIELDS.contains(&key.as_str())) {
        return Err("Snapshot enthält unbekannte Felder.".into());
    }
    if root
        .get("schema_version")
        .is_some_and(|value| value.as_u64() != Some(1))
    {
        return Err("schema_version: Erwartet wird die Ganzzahl 1.".into());
    }
    constant(root, "source_system", "flintplate")?;
    constant(root, "currency", "EUR")?;
    let venue = uuid_field(root, "venue_id", "venue_id")?;
    let menu = uuid_field(root, "menu_id", "menu_id")?;
    if venue != expected_venue || menu != venue {
        return Err(
            "venue_id/menu_id: Die Zuordnung zur erwarteten Betriebsstätte stimmt nicht.".into(),
        );
    }
    let revision = string_field(root, "menu_revision", "menu_revision")?;
    if revision.len() != 64
        || !revision
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("menu_revision: Erwartet wird ein SHA-256-Hash in kleinen Hexzeichen.".into());
    }
    let timezone = string_field(root, "timezone", "timezone")?;
    if timezone.parse::<chrono_tz::Tz>().is_err() {
        return Err("timezone: Erwartet wird eine bekannte IANA-Zeitzone.".into());
    }
    let published_at = string_field(root, "published_at", "published_at")?;
    validate_timestamp(published_at)?;
    let items = required(root, "items", "items")?
        .as_array()
        .ok_or_else(|| "items: Erwartet wird ein Array.".to_owned())?;
    if items.len() > MAX_ITEMS {
        return Err("items: Höchstens 500 Artikel sind erlaubt.".into());
    }
    let mut normalized = Vec::with_capacity(items.len());
    let mut ids = HashSet::with_capacity(items.len());
    let mut skus = HashSet::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let path = format!("items[{index}]");
        let item = normalize_item(item, &path)?;
        if !ids.insert(item["id"].as_str().unwrap_or_default().to_owned()) {
            return Err(format!("{path}.id: Doppelte Artikelkennung."));
        }
        if !skus.insert(item["sku"].as_str().unwrap_or_default().to_owned()) {
            return Err(format!("{path}.sku: Doppelte SKU."));
        }
        normalized.push(item);
    }
    if item_revision(&normalized) != revision {
        return Err(
            "menu_revision: Der Hash stimmt nicht mit den normalisierten Artikeln überein.".into(),
        );
    }
    Ok(json!({
        "schema_version": 1,
        "source_system": "flintplate",
        "venue_id": venue.to_string(),
        "menu_id": menu.to_string(),
        "menu_revision": revision,
        "currency": "EUR",
        "timezone": timezone,
        "published_at": published_at,
        "items": normalized,
    }))
}

// Value's ordinary Deserialize accepts duplicate keys by retaining the last one.
// Visit every object ourselves, including objects inside discarded extra fields.
struct CheckedJson {
    depth: usize,
}

impl<'de> DeserializeSeed<'de> for CheckedJson {
    type Value = Value;

    fn deserialize<D>(self, deserializer: D) -> Result<Value, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        if self.depth > MAX_DEPTH {
            return Err(de::Error::custom("JSON ist zu tief verschachtelt."));
        }
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for CheckedJson {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("begrenztes JSON ohne doppelte Schlüssel")
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Value, E> {
        Ok(Value::Number(value.into()))
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Value, E> {
        Ok(Value::Number(value.into()))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Value, E> {
        Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| E::custom("Ungültige JSON-Zahl."))
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Value, E> {
        check_json_string(value)?;
        Ok(Value::String(value.to_owned()))
    }

    fn visit_string<E: de::Error>(self, value: String) -> Result<Value, E> {
        check_json_string(&value)?;
        Ok(Value::String(value))
    }

    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Value, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element_seed(CheckedJson {
            depth: self.depth + 1,
        })? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut object: A) -> Result<Value, A::Error> {
        let mut values = Map::new();
        while let Some(key) = object.next_key::<String>()? {
            check_json_string(&key)?;
            if values.contains_key(&key) {
                return Err(de::Error::custom("Doppelter JSON-Schlüssel."));
            }
            let value = object.next_value_seed(CheckedJson {
                depth: self.depth + 1,
            })?;
            values.insert(key, value);
        }
        Ok(Value::Object(values))
    }
}

fn check_json_string<E: de::Error>(value: &str) -> Result<(), E> {
    if value.len() > MAX_STRING_BYTES || value.contains('\0') {
        return Err(E::custom("JSON-Zeichenfolge ist zu lang oder enthält NUL."));
    }
    Ok(())
}

fn object<'a>(value: &'a Value, path: &str) -> DecodeResult<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| format!("{path}: Erwartet wird ein Objekt."))
}

fn required<'a>(object: &'a Map<String, Value>, key: &str, path: &str) -> DecodeResult<&'a Value> {
    object
        .get(key)
        .ok_or_else(|| format!("{path}: Pflichtfeld fehlt."))
}

fn string_field<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    path: &str,
) -> DecodeResult<&'a str> {
    required(object, key, path)?
        .as_str()
        .ok_or_else(|| format!("{path}: Erwartet wird eine Zeichenfolge."))
}

fn uuid_field(object: &Map<String, Value>, key: &str, path: &str) -> DecodeResult<Uuid> {
    Uuid::parse_str(string_field(object, key, path)?)
        .map_err(|_| format!("{path}: Erwartet wird eine UUID."))
}

fn integer(value: &Value, minimum: u64, maximum: u64, path: &str) -> DecodeResult<u64> {
    value
        .as_u64()
        .filter(|number| (minimum..=maximum).contains(number))
        .ok_or_else(|| format!("{path}: Erwartet wird eine Ganzzahl im zulässigen Bereich."))
}

fn integer_field(
    object: &Map<String, Value>,
    key: &str,
    minimum: u64,
    maximum: u64,
    path: &str,
) -> DecodeResult<u64> {
    integer(required(object, key, path)?, minimum, maximum, path)
}

fn boolean(value: &Value, path: &str) -> DecodeResult<bool> {
    value
        .as_bool()
        .ok_or_else(|| format!("{path}: Erwartet wird ein Wahrheitswert."))
}

fn constant(object: &Map<String, Value>, key: &str, expected: &str) -> DecodeResult<()> {
    if object
        .get(key)
        .is_some_and(|value| value.as_str() != Some(expected))
    {
        return Err(format!("{key}: Unzulässiger Vertragswert."));
    }
    Ok(())
}

fn normalize_item(value: &Value, path: &str) -> DecodeResult<Value> {
    let item = object(value, path)?;
    let id = uuid_field(item, "id", &format!("{path}.id"))?;
    let sku = string_field(item, "sku", &format!("{path}.sku"))?;
    if sku.is_empty()
        || sku.len() > 128
        || !sku.as_bytes()[0].is_ascii_alphanumeric()
        || !sku
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(format!(
            "{path}.sku: Erwartet wird eine eindeutige ASCII-SKU mit höchstens 128 Bytes."
        ));
    }
    let version = integer_field(
        item,
        "version",
        1,
        MAX_SAFE_INTEGER,
        &format!("{path}.version"),
    )?;
    let mut result = Map::new();
    result.insert("id".into(), json!(id.to_string()));
    result.insert("sku".into(), json!(sku));
    result.insert("version".into(), json!(version));
    for key in ["name", "description", "category", "station"] {
        // The pinned item schema imposes no minLength or station enumeration.
        result.insert(
            key.into(),
            json!(string_field(item, key, &format!("{path}.{key}"))?),
        );
    }
    for (key, maximum) in [("price_cents", MAX_SAFE_INTEGER), ("tax_rate_bps", 10_000)] {
        result.insert(
            key.into(),
            json!(integer_field(
                item,
                key,
                0,
                maximum,
                &format!("{path}.{key}")
            )?),
        );
    }
    let allergens = required(item, "allergens", &format!("{path}.allergens"))?
        .as_array()
        .ok_or_else(|| format!("{path}.allergens: Erwartet wird ein Array."))?;
    if allergens.iter().any(|allergen| !allergen.is_string()) {
        return Err(format!(
            "{path}.allergens: Alle Einträge müssen Zeichenfolgen sein."
        ));
    }
    result.insert("allergens".into(), Value::Array(allergens.clone()));
    result.insert(
        "available".into(),
        json!(boolean(
            required(item, "available", &format!("{path}.available"))?,
            &format!("{path}.available"),
        )?),
    );
    let packaging = match item.get("takeaway_packaging") {
        None | Some(Value::Null) => Value::Null,
        Some(value) => normalize_packaging(value, &format!("{path}.takeaway_packaging"))?,
    };
    result.insert("takeaway_packaging".into(), packaging);
    Ok(Value::Object(result))
}

fn normalize_packaging(value: &Value, path: &str) -> DecodeResult<Value> {
    let packaging = object(value, path)?;
    let name = string_field(packaging, "name", &format!("{path}.name"))?;
    if !(1..=80).contains(&name.chars().count()) {
        return Err(format!(
            "{path}.name: Erwartet werden 1 bis 80 Unicode-Zeichen."
        ));
    }
    let mut result = Map::new();
    result.insert("name".into(), json!(name));
    for key in ["price_cents", "tax_rate_bps", "deposit_tax_rate_bps"] {
        result.insert(
            key.into(),
            json!(integer_field(
                packaging,
                key,
                0,
                10_000,
                &format!("{path}.{key}")
            )?),
        );
    }
    let deposit = match packaging.get("deposit_cents") {
        None => 0,
        Some(value) => integer(value, 0, 10_000, &format!("{path}.deposit_cents"))?,
    };
    let reusable = match packaging.get("reusable") {
        None => false,
        Some(value) => boolean(value, &format!("{path}.reusable"))?,
    };
    result.insert("deposit_cents".into(), json!(deposit));
    result.insert("reusable".into(), json!(reusable));
    Ok(Value::Object(result))
}

fn validate_timestamp(value: &str) -> DecodeResult<()> {
    let invalid = || {
        "published_at: Erwartet wird RFC3339 mit UTC-Offset 0, ohne Schaltsekunde und mit höchstens neun Nachkommastellen."
            .to_owned()
    };
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || !bytes[..4].iter().all(u8::is_ascii_digit)
        || bytes[4] != b'-'
        || !bytes[5..7].iter().all(u8::is_ascii_digit)
        || bytes[7] != b'-'
        || !bytes[8..10].iter().all(u8::is_ascii_digit)
        || !matches!(bytes[10], b'T' | b't')
        || !bytes[11..13].iter().all(u8::is_ascii_digit)
        || bytes[13] != b':'
        || !bytes[14..16].iter().all(u8::is_ascii_digit)
        || bytes[16] != b':'
        || !bytes[17..19].iter().all(u8::is_ascii_digit)
        || bytes[17] > b'5'
    {
        return Err(invalid());
    }
    let mut offset_start = 19;
    if bytes[offset_start] == b'.' {
        offset_start += 1;
        let fraction_start = offset_start;
        while offset_start < bytes.len() && bytes[offset_start].is_ascii_digit() {
            offset_start += 1;
        }
        if !(1..=9).contains(&(offset_start - fraction_start)) {
            return Err(invalid());
        }
    }
    if !matches!(&bytes[offset_start..], b"Z" | b"z" | b"+00:00" | b"-00:00") {
        return Err(invalid());
    }
    let timestamp = DateTime::parse_from_rfc3339(value).map_err(|_| invalid())?;
    if timestamp.offset().local_minus_utc() != 0 {
        return Err(invalid());
    }
    Ok(())
}

fn item_revision(items: &[Value]) -> String {
    let mut ordered = items.iter().collect::<Vec<_>>();
    ordered.sort_unstable_by(|left, right| left["sku"].as_str().cmp(&right["sku"].as_str()));
    let mut canonical = String::new();
    canonical.push('[');
    for (index, item) in ordered.into_iter().enumerate() {
        if index != 0 {
            canonical.push(',');
        }
        write_python_json(item, &mut canonical);
    }
    canonical.push(']');
    hex::encode(Sha256::digest(canonical.as_bytes()))
}

// Python json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=True).
// Call only with normalized values: all numbers then are safe, nonnegative ints.
fn write_python_json(value: &Value, output: &mut String) {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => output.push_str(&value.to_string()),
        Value::String(value) => write_python_string(value, output),
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    output.push(',');
                }
                write_python_json(value, output);
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push('{');
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            for (index, key) in keys.into_iter().enumerate() {
                if index != 0 {
                    output.push(',');
                }
                write_python_string(key, output);
                output.push(':');
                write_python_json(&values[key], output);
            }
            output.push('}');
        }
    }
}

fn write_python_string(value: &str, output: &mut String) {
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\u{08}' => output.push_str("\\b"),
            '\u{0c}' => output.push_str("\\f"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            ' '..='~' => output.push(character),
            character => {
                let code = u32::from(character);
                if code <= 0xffff {
                    write_hex_escape(code, output);
                } else {
                    let supplementary = code - 0x10000;
                    write_hex_escape(0xd800 | (supplementary >> 10), output);
                    write_hex_escape(0xdc00 | (supplementary & 0x3ff), output);
                }
            }
        }
    }
    output.push('"');
}

fn write_hex_escape(value: u32, output: &mut String) {
    const HEX: &[u8] = b"0123456789abcdef";
    output.push_str("\\u");
    for shift in [12, 8, 4, 0] {
        output.push(char::from(HEX[((value >> shift) & 0xf) as usize]));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOLDEN: &str =
        include_str!("../../../adapters/flintplate-contract/fixtures/menu-snapshot-v1.json");
    const CANONICAL: &str =
        include_str!("../../../adapters/flintplate-contract/fixtures/menu-items-v1.canonical.json");

    fn fixture() -> Value {
        serde_json::from_str(GOLDEN).unwrap()
    }

    fn venue() -> Uuid {
        Uuid::parse_str("10000000-0000-4000-8000-000000000001").unwrap()
    }

    fn decode(value: &Value) -> DecodeResult<Value> {
        decode_snapshot(&serde_json::to_string(value).unwrap(), venue())
    }

    // Re-sign mutated fixtures so rejection cannot be caused only by a stale
    // source hash. The independent checked-in Python vector verifies the hash.
    fn rehash(value: &mut Value) {
        value["menu_revision"] = json!(item_revision(value["items"].as_array().unwrap()));
    }

    #[test]
    fn golden_matches_python_bytes_and_hash_without_losing_source_values() {
        let value = decode_snapshot(GOLDEN, venue()).unwrap();
        assert_eq!(value, fixture());
        let mut canonical = String::new();
        write_python_json(&value["items"], &mut canonical);
        assert_eq!(canonical, CANONICAL);
        assert_eq!(
            item_revision(value["items"].as_array().unwrap()),
            "e44ae9ad5a754dca8713b109b53f35db4af55078cc741680334287a94c81fd33"
        );
    }

    #[test]
    fn declared_defaults_and_ignored_nested_extras_normalize_to_golden() {
        let mut input = fixture();
        let root = input.as_object_mut().unwrap();
        for field in ["schema_version", "source_system", "currency"] {
            root.remove(field);
        }
        input["items"][0]
            .as_object_mut()
            .unwrap()
            .remove("takeaway_packaging");
        let packaging = input["items"][2]["takeaway_packaging"]
            .as_object_mut()
            .unwrap();
        packaging.remove("deposit_cents");
        packaging.remove("reusable");
        packaging.insert("upstream_extra".into(), json!({"ignored": [true, null]}));
        input["items"][0]["upstream_extra"] = json!({"ignored": {"value": 5}});
        assert_eq!(decode(&input).unwrap(), fixture());
    }

    #[test]
    fn item_order_is_preserved_and_hash_ignores_envelope_metadata() {
        let mut input = fixture();
        input["items"].as_array_mut().unwrap().reverse();
        input["timezone"] = json!("Europe/Paris");
        input["published_at"] = json!("2026-09-22T10:20:30.123456789+00:00");
        assert_eq!(decode(&input).unwrap(), input);
    }

    #[test]
    fn empty_menu_and_schema_allowed_empty_text_are_preserved() {
        let mut input = fixture();
        for field in ["name", "description", "category", "station"] {
            input["items"][0][field] = json!("");
        }
        rehash(&mut input);
        assert_eq!(decode(&input).unwrap(), input);
        input["items"] = json!([]);
        // Independently known SHA-256 of the exact ASCII bytes [].
        input["menu_revision"] =
            json!("4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
        assert_eq!(decode(&input).unwrap(), input);
    }

    #[test]
    fn uuid_strings_normalize_before_hash_and_identity_comparison() {
        let mut expected = fixture();
        let id = "abcdef12-0000-4000-8000-000000000001";
        expected["venue_id"] = json!(id);
        expected["menu_id"] = json!(id);
        expected["items"][0]["id"] = json!(id);
        rehash(&mut expected);
        let mut input = expected.clone();
        input["venue_id"] = json!(id.to_uppercase());
        input["menu_id"] = json!(id.replace('-', ""));
        input["items"][0]["id"] = json!(id.to_uppercase());
        assert_eq!(
            decode_snapshot(&input.to_string(), Uuid::parse_str(id).unwrap()).unwrap(),
            expected
        );
    }

    #[test]
    fn duplicate_keys_are_rejected_even_in_ignored_nested_objects() {
        let input = fixture().to_string();
        for duplicate in [
            input.replacen('{', "{\"currency\":\"EUR\",", 1),
            input.replacen("\"name\":", "\"n\\u0061me\":\"ignored\",\"name\":", 1),
            input.replacen("\"sku\":", "\"extra\":{\"x\":1,\"x\":2},\"sku\":", 1),
            input.replacen("\"sku\":", "\"extra\":[{\"x\":1,\"x\":2}],\"sku\":", 1),
        ] {
            assert!(decode_snapshot(&duplicate, venue()).is_err());
        }
    }

    #[test]
    fn wrong_root_types_missing_fields_and_explicit_null_defaults_are_rejected() {
        for invalid in [json!(null), json!([]), json!(1), json!("snapshot")] {
            assert!(decode(&invalid).is_err());
        }
        for field in [
            "schema_version",
            "source_system",
            "currency",
            "timezone",
            "items",
        ] {
            let mut input = fixture();
            input[field] = Value::Null;
            assert!(decode(&input).is_err(), "{field}");
        }
        for field in [
            "venue_id",
            "menu_id",
            "menu_revision",
            "timezone",
            "published_at",
            "items",
        ] {
            let mut input = fixture();
            input.as_object_mut().unwrap().remove(field);
            assert!(decode(&input).is_err(), "{field}");
        }
        for (field, value) in [
            ("schema_version", json!(1.0)),
            ("schema_version", json!(true)),
            ("source_system", json!("other")),
            ("currency", json!("USD")),
            ("venue_id", json!(123)),
            ("private_secret_marker", json!("private-value-marker")),
        ] {
            let mut input = fixture();
            input[field] = value;
            let error = decode(&input).unwrap_err();
            assert!(!error.contains("private_secret_marker"));
            assert!(!error.contains("private-value-marker"));
        }
    }

    #[test]
    fn item_primitives_required_fields_and_safe_integer_ranges_are_strict() {
        for value in [Value::Null, json!(true), json!(7), json!([])] {
            let mut input = fixture();
            input["items"][0] = value;
            assert!(decode(&input).unwrap_err().contains("items[0]"));
        }
        for (field, value) in [
            ("version", json!(0)),
            ("version", json!(1.0)),
            ("version", json!(true)),
            ("version", json!("1")),
            ("version", json!(MAX_SAFE_INTEGER + 1)),
            ("price_cents", json!(-1)),
            ("price_cents", json!(0.5)),
            ("price_cents", json!(MAX_SAFE_INTEGER + 1)),
            ("tax_rate_bps", json!(10_001)),
            ("tax_rate_bps", json!(null)),
            ("available", json!(1)),
            ("allergens", json!(["milk", null])),
            ("allergens", json!("milk")),
            ("name", json!(false)),
            ("id", json!("invalid")),
            ("takeaway_packaging", json!(false)),
        ] {
            let mut input = fixture();
            input["items"][0][field] = value;
            rehash(&mut input);
            assert!(decode(&input).is_err(), "{field}");
        }
        for field in [
            "id",
            "sku",
            "version",
            "name",
            "description",
            "category",
            "price_cents",
            "tax_rate_bps",
            "allergens",
            "available",
            "station",
        ] {
            let mut input = fixture();
            input["items"][0].as_object_mut().unwrap().remove(field);
            rehash(&mut input);
            assert!(decode(&input).is_err(), "{field}");
        }
        let mut input = fixture();
        input["items"][0]["version"] = json!(MAX_SAFE_INTEGER);
        input["items"][0]["price_cents"] = json!(MAX_SAFE_INTEGER);
        input["items"][0]["tax_rate_bps"] = json!(10_000);
        rehash(&mut input);
        assert!(decode(&input).is_ok());
    }

    #[test]
    fn packaging_enforces_source_limits_and_does_not_default_explicit_null() {
        for field in [
            "name",
            "price_cents",
            "tax_rate_bps",
            "deposit_tax_rate_bps",
        ] {
            let mut input = fixture();
            input["items"][1]["takeaway_packaging"]
                .as_object_mut()
                .unwrap()
                .remove(field);
            rehash(&mut input);
            assert!(decode(&input).is_err(), "{field}");
        }
        for (field, value) in [
            ("name", json!("")),
            ("name", json!("🍮".repeat(81))),
            ("price_cents", json!(10_001)),
            ("deposit_cents", json!(-1)),
            ("deposit_cents", json!(null)),
            ("deposit_cents", json!(0.0)),
            ("tax_rate_bps", json!(10_001)),
            ("deposit_tax_rate_bps", json!(10_001)),
            ("reusable", json!(null)),
            ("reusable", json!(0)),
        ] {
            let mut input = fixture();
            input["items"][1]["takeaway_packaging"][field] = value;
            rehash(&mut input);
            assert!(decode(&input).is_err(), "{field}");
        }
        let mut input = fixture();
        input["items"][1]["takeaway_packaging"]["name"] = json!("🍮".repeat(80));
        input["items"][1]["takeaway_packaging"]["price_cents"] = json!(10_000);
        input["items"][1]["takeaway_packaging"]["deposit_cents"] = json!(10_000);
        rehash(&mut input);
        assert!(decode(&input).is_ok());
    }

    #[test]
    fn tenant_ids_timezone_timestamp_and_hash_are_checked_separately() {
        assert!(decode_snapshot(GOLDEN, Uuid::nil()).is_err());
        for (field, value) in [
            ("menu_id", json!(Uuid::nil().to_string())),
            ("venue_id", json!(Uuid::nil().to_string())),
            ("timezone", json!("Not/A_Zone")),
            ("published_at", json!("2026-09-22T10:20:30+02:00")),
            ("published_at", json!("2026-02-30T10:20:30Z")),
            ("published_at", json!("2026-09-22T10:20:60Z")),
            ("published_at", json!("2026-09-22T10:20:30.1234567890Z")),
            ("published_at", json!("2026-09-22T10:20:30.Z")),
            ("published_at", json!("2026-09-22 10:20:30Z")),
            ("published_at", json!("2026-09-22T10:20:30")),
            ("published_at", json!("2026-09-22T10:20:30Z trailing")),
            ("menu_revision", json!("f".repeat(64))),
            ("menu_revision", json!("A".repeat(64))),
            ("menu_revision", json!("a".repeat(63))),
        ] {
            let mut input = fixture();
            input[field] = value;
            assert!(decode(&input).is_err(), "{field}");
        }
        let mut input = fixture();
        input["items"][0]["price_cents"] = json!(751);
        assert!(decode(&input).is_err());
        input = fixture();
        input["items"][0]["allergens"]
            .as_array_mut()
            .unwrap()
            .reverse();
        assert!(decode(&input).is_err());
    }

    #[test]
    fn sku_and_item_identity_uniqueness_are_not_source_hash_checks() {
        for invalid in ["", "_leading", "contains space", "ä", "a/b", "A\n"] {
            let mut input = fixture();
            input["items"][0]["sku"] = json!(invalid);
            rehash(&mut input);
            assert!(decode(&input).is_err());
        }
        for field in ["id", "sku"] {
            let mut input = fixture();
            input["items"][1][field] = input["items"][0][field].clone();
            rehash(&mut input);
            assert!(decode(&input).is_err());
        }
        let mut input = fixture();
        input["items"][0]["sku"] = json!("A".repeat(128));
        rehash(&mut input);
        assert!(decode(&input).is_ok());
        input["items"][0]["sku"] = json!("A".repeat(129));
        rehash(&mut input);
        assert!(decode(&input).is_err());
    }

    #[test]
    fn byte_item_string_and_nesting_limits_apply_before_hash_verification() {
        let mut padded = GOLDEN.to_owned();
        padded.push_str(&" ".repeat(MAX_INPUT_BYTES - padded.len()));
        assert!(decode_snapshot(&padded, venue()).is_ok());
        padded.push(' ');
        assert!(decode_snapshot(&padded, venue()).is_err());
        let mut input = fixture();
        let prototype = input["items"][0].clone();
        let items = (0..MAX_ITEMS)
            .map(|index| {
                let mut item = prototype.clone();
                item["id"] = json!(Uuid::from_u128(index as u128 + 1).to_string());
                item["sku"] = json!(format!("SKU-{index:04}"));
                item
            })
            .collect::<Vec<_>>();
        input["items"] = json!(items);
        rehash(&mut input);
        assert!(decode(&input).is_ok());
        input["items"].as_array_mut().unwrap().push(prototype);
        rehash(&mut input);
        assert!(decode(&input).unwrap_err().contains("500"));
        input = fixture();
        input["items"][0]["description"] = json!("ä".repeat(MAX_STRING_BYTES / 2));
        rehash(&mut input);
        assert!(decode(&input).is_ok());
        input["items"][0]["description"] = json!("ä".repeat(MAX_STRING_BYTES / 2 + 1));
        rehash(&mut input);
        assert!(decode(&input).is_err());
        let deep = format!(
            "{}0{}",
            "[".repeat(MAX_DEPTH + 2),
            "]".repeat(MAX_DEPTH + 2)
        );
        let deep_extra =
            fixture()
                .to_string()
                .replacen("\"sku\":", &format!("\"extra\":{deep},\"sku\":"), 1);
        assert!(decode_snapshot(&deep_extra, venue()).is_err());
    }

    #[test]
    fn malformed_and_unstorable_json_never_returns_input_in_errors() {
        for input in [
            "{\"private-marker\":undefined}",
            "{\"private-marker\":NaN}",
            "{\"private-marker\":1e400}",
            "{\"private-marker\":\"\\ud800\"}",
            "{\"private-marker\":\"\\u0000\"}",
        ] {
            let error = decode_snapshot(input, venue()).unwrap_err();
            assert!(!error.contains("private-marker"));
        }
        assert!(decode_snapshot(&format!("{GOLDEN} null"), venue()).is_err());
        let mut input = fixture();
        input["items"][0]["description"] = json!("private-marker\0");
        rehash(&mut input);
        assert!(!decode(&input).unwrap_err().contains("private-marker"));
    }

    #[test]
    fn python_ascii_escaping_covers_controls_del_bmp_and_surrogate_pairs() {
        let mut escaped = String::new();
        write_python_string(
            "\0\u{1f}\u{08}\u{0c}\n\r\t\"\\ /\u{7f}ä\u{2028}🍮\u{10ffff}",
            &mut escaped,
        );
        assert_eq!(
            escaped,
            r#""\u0000\u001f\b\f\n\r\t\"\\ /\u007f\u00e4\u2028\ud83c\udf6e\udbff\udfff""#
        );
    }
}
