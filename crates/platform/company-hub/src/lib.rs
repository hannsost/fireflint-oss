//! Versioned contracts for optional company-data capabilities. No I/O or credentials.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize)]
pub struct Module {
    pub key: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub version: &'static str,
    pub dependencies: &'static [&'static str],
    pub required: bool,
}

pub const MODULES: &[Module] = &[
    Module {
        key: "devices",
        name: "Omarchy-Geräte",
        description: "Arbeitsrechner erfassen, zuordnen und ihre Inventarhistorie nachvollziehen.",
        version: "1.0.0",
        dependencies: &["directory"],
        required: false,
    },
    Module {
        key: "directory",
        name: "Unternehmensdaten",
        description: "Unternehmen, Kontakte, Standorte und Produkte gemeinsam verwalten.",
        version: "1.0.0",
        dependencies: &[],
        required: true,
    },
    Module {
        key: "notifications",
        name: "Benachrichtigungen",
        description: "Persönliche Hinweise auf Aufgaben und Entscheidungen.",
        version: "1.0.0",
        dependencies: &["directory"],
        required: false,
    },
    Module {
        key: "work",
        name: "Aufgaben & Freigaben",
        description: "Zuständigkeiten, Fristen, Kommentare und geprüfte Entscheidungen.",
        version: "1.0.0",
        dependencies: &["directory", "notifications"],
        required: false,
    },
    Module {
        key: "forms",
        name: "Formulare",
        description: "Versionierte Formulare und validierte Eingänge.",
        version: "1.0.0",
        dependencies: &["directory"],
        required: false,
    },
    Module {
        key: "integrations",
        name: "Datenaustausch",
        description: "Datenquellen, Importvorschau und nachvollziehbare Übernahme.",
        version: "1.0.0",
        dependencies: &["directory"],
        required: false,
    },
    Module {
        key: "translations",
        name: "Mehrsprachigkeit",
        description: "Übersetzungen mit nachvollziehbarem Quellstand.",
        version: "1.0.0",
        dependencies: &["directory"],
        required: false,
    },
    Module {
        key: "media",
        name: "Medienverwaltung",
        description: "Dateiquellen, Lizenzangaben und Verwendung dokumentieren.",
        version: "1.0.0",
        dependencies: &["directory"],
        required: false,
    },
    Module {
        key: "booking",
        name: "Termine & Ressourcen",
        description: "Ressourcen verwalten und Zeiträume ohne Überschneidungen reservieren.",
        version: "1.0.0",
        dependencies: &["directory"],
        required: false,
    },
    Module {
        key: "quality",
        name: "Datenqualität",
        description: "Dubletten und unvollständige Daten erkennen und nachvollziehbar prüfen.",
        version: "1.0.0",
        dependencies: &["directory"],
        required: false,
    },
    Module {
        key: "service_access",
        name: "Service-Zugänge",
        description: "Begrenzte Maschinenzugänge, vollständiger Export und Änderungsabruf.",
        version: "1.0.0",
        dependencies: &["directory"],
        required: false,
    },
];

pub fn module(key: &str) -> Option<&'static Module> {
    MODULES.iter().find(|m| m.key == key)
}

#[derive(Clone, Debug, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct Field {
    pub key: String,
    pub label: String,
    pub kind: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub options: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, utoipa::ToSchema)]
pub struct Kind {
    pub key: String,
    pub name: String,
    pub module: String,
    pub fields: Vec<Field>,
}

fn field(key: &str, label: &str, kind: &str, required: bool) -> Field {
    Field {
        key: key.into(),
        label: label.into(),
        kind: kind.into(),
        required,
        options: vec![],
    }
}

pub fn kinds() -> Vec<Kind> {
    vec![
        Kind {
            key: "external_document".into(),
            name: "Dokumentverweise".into(),
            module: "integrations".into(),
            fields: vec![
                field("name", "Dateiname", "text", true),
                field("url", "Original in Nextcloud", "url", true),
                field("file_id", "Dateikennung", "text", true),
                field("mime_type", "Dateityp", "text", false),
                field("size_bytes", "Größe in Bytes", "number", true),
                field("source_modified_at", "Geändert in der Quelle", "text", true),
                field("etag", "Quellversion (ETag)", "text", true),
                field("notes", "Interne Notizen", "multiline", false),
            ],
        },
        Kind {
            key: "company".into(),
            name: "Unternehmen".into(),
            module: "directory".into(),
            fields: vec![
                field("legal_name", "Rechtlicher Name", "text", true),
                field("website", "Website", "url", false),
                field("email", "E-Mail", "email", false),
                field("phone", "Telefon", "text", false),
                field("tax_id", "Steuerkennung", "text", false),
                field("address", "Anschrift", "multiline", false),
                field("notes", "Notizen", "multiline", false),
            ],
        },
        Kind {
            key: "contact".into(),
            name: "Kontakte".into(),
            module: "directory".into(),
            fields: vec![
                field("name", "Name", "text", true),
                field("email", "E-Mail", "email", false),
                field("phone", "Telefon", "text", false),
                field("position", "Position", "text", false),
                field("notes", "Notizen", "multiline", false),
            ],
        },
        Kind {
            key: "location".into(),
            name: "Standorte".into(),
            module: "directory".into(),
            fields: vec![
                field("name", "Bezeichnung", "text", true),
                field("address", "Anschrift", "multiline", true),
                field("phone", "Telefon", "text", false),
                field("email", "E-Mail", "email", false),
                field("opening_hours", "Öffnungszeiten", "multiline", false),
            ],
        },
        Kind {
            key: "product".into(),
            name: "Produkte & Leistungen".into(),
            module: "directory".into(),
            fields: vec![
                field("name", "Bezeichnung", "text", true),
                field("sku", "Artikelkennung", "text", false),
                field("description", "Beschreibung", "multiline", false),
                field("unit", "Einheit", "text", false),
            ],
        },
        Kind {
            key: "resource".into(),
            name: "Ressourcen".into(),
            module: "booking".into(),
            fields: vec![
                field("name", "Bezeichnung", "text", true),
                field("description", "Beschreibung", "multiline", false),
                field("timezone", "Zeitzone", "text", true),
            ],
        },
        Kind {
            key: "source".into(),
            name: "Datenquellen".into(),
            module: "integrations".into(),
            fields: vec![
                field("name", "Bezeichnung", "text", true),
                field("system", "System", "text", true),
                field("url", "Systemadresse", "url", false),
                field("notes", "Zuständigkeit und Datenfluss", "multiline", false),
            ],
        },
    ]
}

pub fn key_valid(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key.as_bytes()[0].is_ascii_lowercase()
        && key
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
}

pub fn validate_fields(fields: &[Field]) -> Result<(), String> {
    if fields.is_empty() || fields.len() > 40 {
        return Err("Ein Formular benötigt 1 bis 40 Felder.".into());
    }
    let mut keys = std::collections::HashSet::new();
    for f in fields {
        if !key_valid(&f.key)
            || !keys.insert(&f.key)
            || f.label.trim().is_empty()
            || f.label.len() > 160
        {
            return Err(
                "Feldkennungen müssen eindeutig sein und Felder eine Bezeichnung besitzen.".into(),
            );
        }
        if ![
            "text",
            "multiline",
            "email",
            "url",
            "number",
            "boolean",
            "date",
            "select",
        ]
        .contains(&f.kind.as_str())
        {
            return Err("Unbekannter Feldtyp.".into());
        }
        if f.kind != "select" && !f.options.is_empty() {
            return Err("Optionen sind nur für Auswahlfelder erlaubt.".into());
        }
        if f.options
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != f.options.len()
        {
            return Err("Auswahloptionen müssen eindeutig sein.".into());
        }
        if f.kind == "select"
            && (f.options.is_empty()
                || f.options.len() > 100
                || f.options
                    .iter()
                    .any(|v| v.trim().is_empty() || v.len() > 160))
        {
            return Err("Auswahlfelder benötigen 1 bis 100 gültige Optionen.".into());
        }
    }
    Ok(())
}

pub fn validate_data(fields: &[Field], data: &Value) -> Result<(), String> {
    let obj = data.as_object().ok_or("Daten müssen ein Objekt sein.")?;
    if data.to_string().len() > 65_536 {
        return Err("Der Datensatz ist zu groß.".into());
    }
    for key in obj.keys() {
        if !fields.iter().any(|f| &f.key == key) {
            return Err(format!("Unbekanntes Feld: {key}"));
        }
    }
    for f in fields {
        let value = obj.get(&f.key);
        if value.is_none()
            || value == Some(&Value::Null)
            || value
                .and_then(Value::as_str)
                .is_some_and(|s| s.trim().is_empty())
        {
            if f.required {
                return Err(format!("{} ist erforderlich.", f.label));
            }
            continue;
        }
        let v = value.unwrap();
        let valid = match f.kind.as_str() {
            "number" => v.is_number(),
            "boolean" => v.is_boolean(),
            "date" => v
                .as_str()
                .is_some_and(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()),
            "select" => v.as_str().is_some_and(|s| f.options.iter().any(|o| o == s)),
            "email" => v.as_str().is_some_and(|s| {
                s.len() <= 254
                    && !s.chars().any(char::is_whitespace)
                    && s.matches('@').count() == 1
                    && s.split_once('@').is_some_and(|(a, b)| {
                        !a.is_empty() && b.contains('.') && !b.starts_with('.') && !b.ends_with('.')
                    })
            }),
            "url" => v.as_str().is_some_and(|s| {
                s.len() <= 2048
                    && !s.chars().any(char::is_whitespace)
                    && url::Url::parse(s).is_ok_and(|u| {
                        matches!(u.scheme(), "http" | "https")
                            && u.host_str().is_some()
                            && u.username().is_empty()
                            && u.password().is_none()
                    })
            }),
            "multiline" => v.as_str().is_some_and(|s| s.len() <= 16_384),
            "text" => v.as_str().is_some_and(|s| s.len() <= 1024),
            _ => false,
        };
        if !valid {
            return Err(format!("{} enthält keinen gültigen Wert.", f.label));
        }
    }
    Ok(())
}

pub fn schema_document() -> Value {
    json!({"version": 1, "modules": MODULES, "kinds": kinds()})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn contracts_have_known_acyclic_dependencies() {
        for m in MODULES {
            assert!(key_valid(m.key));
            for dep in m.dependencies {
                assert!(module(dep).is_some());
                assert_ne!(dep, &m.key);
            }
        }
        for k in kinds() {
            assert!(module(&k.module).is_some());
            validate_fields(&k.fields).unwrap();
        }
    }
    #[test]
    fn submissions_reject_unknown_missing_and_wrongly_typed_fields() {
        let fields = vec![
            field("name", "Name", "text", true),
            field("consent", "Einwilligung", "boolean", true),
        ];
        assert!(validate_data(&fields, &json!({"name":"Ada", "consent":true})).is_ok());
        assert!(validate_data(&fields, &json!({"name":" ", "consent":true})).is_err());
        assert!(validate_data(&fields, &json!({"name":"Ada", "consent":"true"})).is_err());
        assert!(validate_data(
            &fields,
            &json!({"name":"Ada", "consent":true, "admin":true})
        )
        .is_err());
    }
}
