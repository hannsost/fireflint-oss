//! Data-only field mapping: no evaluation, filesystem or network access.
use super::{
    providers::{Batch, ProviderError},
    ImportRow,
};
use serde::{de, Deserialize};
use serde_json::{json, Map, Value};
use sitegraph_db::hub::ConnectorConfig;
use std::collections::HashSet;

fn malformed() -> ProviderError {
    ProviderError::input(
        "CSV enthält ungültige Anführungszeichen, Spalten oder mehr als 100 Datensätze.",
    )
}

/// RFC4180 quoting, escaped quotes and embedded CR/LF, with bounded records/columns.
fn csv_records(content: &str, delimiter: char) -> Result<Vec<Vec<String>>, ProviderError> {
    let mut records = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut closed = false;
    let mut chars = content.chars().peekable();
    let mut touched = false;
    while let Some(c) = chars.next() {
        touched = true;
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    quoted = false;
                    closed = true;
                }
            } else {
                field.push(c);
            }
        } else if c == delimiter || c == '\r' || c == '\n' {
            row.push(std::mem::take(&mut field));
            closed = false;
            if row.len() > 64 {
                return Err(malformed());
            }
            if c != delimiter {
                if c == '\r' && chars.peek() == Some(&'\n') {
                    chars.next();
                }
                records.push(std::mem::take(&mut row));
                touched = false;
                if records.len() > 101 {
                    return Err(malformed());
                }
            }
        } else if c == '"' {
            if !field.is_empty() || closed {
                return Err(malformed());
            }
            quoted = true;
        } else {
            if closed {
                return Err(malformed());
            }
            field.push(c);
        }
        if field.len() > 64 * 1024 {
            return Err(malformed());
        }
    }
    if quoted {
        return Err(malformed());
    }
    if touched || !row.is_empty() || !field.is_empty() {
        row.push(field);
        records.push(row);
    }
    if records.len() > 101 || records.iter().any(|r| r.len() > 64) {
        return Err(malformed());
    }
    Ok(records)
}

pub(super) fn scalar(value: &Value) -> Result<String, ProviderError> {
    match value {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        Value::Bool(b) => Ok(b.to_string()),
        Value::Null => Ok(String::new()),
        _ => Err(ProviderError::input(
            "Zugeordnete Werte müssen Text, Zahl, Boolean oder null sein.",
        )),
    }
}
pub(super) fn at<'a>(value: &'a Value, path: &str, csv: bool) -> Option<&'a Value> {
    if csv {
        return value.get(path);
    }
    let mut current = value;
    for part in path.split('.') {
        current = match current {
            Value::Array(a) => a.get(part.parse::<usize>().ok()?)?,
            Value::Object(o) => o.get(part)?,
            _ => return None,
        };
    }
    Some(current)
}

/// One bounded decoder for existing imports and the read-only file assistant.
pub(super) fn read_rows(
    provider: &str,
    content: &str,
    delimiter: &str,
    strict_json: bool,
) -> Result<Vec<Value>, ProviderError> {
    if content.is_empty() || content.len() > 500 * 1024 {
        return Err(ProviderError::input(
            "Dateiinhalt fehlt oder überschreitet 500 KiB.",
        ));
    }
    let csv = match provider {
        "csv" => true,
        "json" => false,
        _ => return Err(ProviderError::input("Nur CSV und JSON werden unterstützt.")),
    };
    if !matches!(delimiter, "," | ";" | "\t") {
        return Err(ProviderError::input(
            "Trennzeichen muss Komma, Semikolon oder Tab sein.",
        ));
    }
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let values = if csv {
        let rows = csv_records(content, delimiter.chars().next().ok_or_else(malformed)?)?;
        let headers = rows.first().ok_or_else(malformed)?;
        let unique: HashSet<_> = headers.iter().collect();
        if unique.len() != headers.len() || headers.iter().any(|s| s.trim().is_empty()) {
            return Err(ProviderError::input(
                "CSV-Spaltennamen müssen eindeutig und nichtleer sein.",
            ));
        }
        let mut values = Vec::new();
        for row in rows.iter().skip(1) {
            if row.len() != headers.len() {
                return Err(malformed());
            }
            values.push(Value::Object(
                headers
                    .iter()
                    .cloned()
                    .zip(row.iter().map(|v| json!(v)))
                    .collect(),
            ));
        }
        values
    } else {
        let value = if strict_json {
            let FileValue(value) = serde_json::from_str(content).map_err(|_| {
                ProviderError::input(
                    "Datei enthält kein gültiges JSON oder doppelte Objektschlüssel.",
                )
            })?;
            value
        } else {
            // Existing imports retain serde_json's established duplicate-key semantics.
            serde_json::from_str(content)
                .map_err(|_| ProviderError::input("Datei enthält kein gültiges JSON."))?
        };
        match value {
            Value::Array(rows) => rows,
            _ => {
                return Err(ProviderError::input(
                    "JSON muss ein Array von Objekten enthalten.",
                ))
            }
        }
    };
    if values.is_empty() || values.len() > 100 {
        return Err(ProviderError::input(
            "Dateiimporte umfassen 1 bis 100 Datensätze.",
        ));
    }
    if values.iter().any(|value| !value.is_object()) {
        return Err(ProviderError::input(
            "Jede Zeile muss ein JSON-Objekt sein.",
        ));
    }
    Ok(values)
}

pub(super) fn parse(config: &ConnectorConfig, content: &str) -> Result<Batch, ProviderError> {
    let mapping = config
        .mapping
        .as_ref()
        .ok_or_else(|| ProviderError::input("Feldzuordnung fehlt."))?;
    let csv = config.provider == "csv";
    let values = read_rows(&config.provider, content, &mapping.delimiter, false)?;
    let mut ids = HashSet::new();
    let mut rows = Vec::new();
    for value in &values {
        let get = |path: &str| -> Result<String, ProviderError> {
            scalar(at(value, path, csv).ok_or_else(|| {
                ProviderError::input(
                    "Eine zugeordnete Spalte oder ein JSON-Pfad fehlt in einer Zeile.",
                )
            })?)
        };
        let external_id = get(&mapping.external_id)?;
        let name = get(&mapping.name)?;
        if external_id.trim().is_empty()
            || external_id.len() > 240
            || name.trim().is_empty()
            || name.len() > 240
        {
            return Err(ProviderError::input(
                "Jede Zeile benötigt eine externe Kennung und Bezeichnung bis 240 Zeichen.",
            ));
        }
        if !ids.insert(external_id.clone()) {
            return Err(ProviderError::input(
                "Doppelte externe Kennung in der Datei.",
            ));
        }
        let mut data = Map::new();
        for (key, path) in &mapping.fields {
            data.insert(key.clone(), json!(get(path)?));
        }
        rows.push(ImportRow {
            external_id,
            kind: mapping.kind.clone(),
            name,
            data: Value::Object(data),
            expected_revision: None,
        });
    }
    Ok(Batch {
        rows,
        next_cursor: None,
    })
}

// serde_json::Value normally keeps only the last duplicate object member. Reject
// ambiguity during discovery; existing import decoding keeps its prior behavior.
struct FileValue(Value);
impl<'de> Deserialize<'de> for FileValue {
    fn deserialize<D: de::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct FileVisitor;
        impl<'de> de::Visitor<'de> for FileVisitor {
            type Value = FileValue;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("JSON without duplicate object keys")
            }
            fn visit_bool<E: de::Error>(self, value: bool) -> Result<FileValue, E> {
                Ok(FileValue(Value::Bool(value)))
            }
            fn visit_i64<E: de::Error>(self, value: i64) -> Result<FileValue, E> {
                Ok(FileValue(json!(value)))
            }
            fn visit_u64<E: de::Error>(self, value: u64) -> Result<FileValue, E> {
                Ok(FileValue(json!(value)))
            }
            fn visit_f64<E: de::Error>(self, value: f64) -> Result<FileValue, E> {
                serde_json::Number::from_f64(value)
                    .map(|number| FileValue(Value::Number(number)))
                    .ok_or_else(|| E::custom("invalid JSON number"))
            }
            fn visit_str<E: de::Error>(self, value: &str) -> Result<FileValue, E> {
                Ok(FileValue(Value::String(value.into())))
            }
            fn visit_string<E: de::Error>(self, value: String) -> Result<FileValue, E> {
                Ok(FileValue(Value::String(value)))
            }
            fn visit_unit<E: de::Error>(self) -> Result<FileValue, E> {
                Ok(FileValue(Value::Null))
            }
            fn visit_seq<A: de::SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> Result<FileValue, A::Error> {
                let mut values = Vec::new();
                while let Some(FileValue(value)) = sequence.next_element()? {
                    values.push(value);
                }
                Ok(FileValue(Value::Array(values)))
            }
            fn visit_map<A: de::MapAccess<'de>>(
                self,
                mut object: A,
            ) -> Result<FileValue, A::Error> {
                let mut values = Map::new();
                while let Some(key) = object.next_key::<String>()? {
                    if values.contains_key(&key) {
                        return Err(de::Error::custom("duplicate object key"));
                    }
                    let FileValue(value) = object.next_value()?;
                    values.insert(key, value);
                }
                Ok(FileValue(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(FileVisitor)
    }
}
