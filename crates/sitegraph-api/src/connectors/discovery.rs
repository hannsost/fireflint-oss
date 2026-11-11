//! Stateless, rule-based file structure inspection. No sample values leave here.
use super::{files, providers::ProviderError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sitegraph_db::hub::ConnectorMapping;
use std::collections::{BTreeMap, BTreeSet, HashSet};

const MAX_FIELDS: usize = 64;
const MAX_DEPTH: usize = 8;
const MAX_NODES: usize = MAX_FIELDS * MAX_DEPTH;
const KINDS: [&str; 4] = ["contact", "company", "location", "product"];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct InspectInput {
    pub provider: String,
    pub content: String,
    #[serde(default = "default_delimiter")]
    pub delimiter: String,
}
fn default_delimiter() -> String {
    ",".into()
}

#[derive(Serialize)]
pub(super) struct Inspection {
    version: u8,
    mode: &'static str,
    provider: String,
    delimiter: String,
    row_count: usize,
    fields: Vec<Field>,
    suggestions: Vec<Suggestion>,
    warnings: Vec<String>,
}
#[derive(Serialize)]
struct Field {
    path: String,
    types: Vec<&'static str>,
    present: usize,
    non_empty: usize,
    unique: bool,
}
#[derive(Serialize)]
struct Suggestion {
    kind: String,
    label: String,
    mapping: ConnectorMapping,
    reasons: Vec<String>,
    missing: Vec<String>,
}

// Value sets are ephemeral, used only to compare the same strings the import uses.
// They are deliberately absent from Serialize/Debug and discarded with the request.
#[derive(Default)]
struct Observation {
    types: BTreeSet<&'static str>,
    present: usize,
    non_empty: usize,
    values: HashSet<String>,
    duplicate: bool,
}
impl Observation {
    fn add(&mut self, value: &Value) -> Result<(), ProviderError> {
        let kind = match value {
            Value::String(_) => "string",
            Value::Number(_) => "number",
            Value::Bool(_) => "boolean",
            Value::Null => "null",
            _ => {
                return Err(ProviderError::input(
                    "Nur skalare Feldwerte sind zuordenbar.",
                ))
            }
        };
        let converted = files::scalar(value)?;
        self.types.insert(kind);
        self.present += 1;
        self.non_empty += usize::from(!converted.trim().is_empty());
        self.duplicate |= !self.values.insert(converted);
        Ok(())
    }
    fn field(&self, path: String) -> Field {
        Field {
            path,
            types: ["string", "number", "boolean", "null"]
                .into_iter()
                .filter(|kind| self.types.contains(kind))
                .collect(),
            present: self.present,
            non_empty: self.non_empty,
            unique: self.present > 0 && !self.duplicate,
        }
    }
}

#[derive(Default)]
struct Structure {
    leaves: BTreeMap<String, Observation>,
    // Track structural shapes too, so a scalar is never hidden behind a container.
    shapes: BTreeMap<String, &'static str>,
    empty_containers: bool,
}
impl Structure {
    fn visit(
        &mut self,
        value: &Value,
        path: String,
        depth: usize,
        csv: bool,
    ) -> Result<(), ProviderError> {
        if depth > MAX_DEPTH {
            return Err(ProviderError::input(
                "JSON darf höchstens 8 verschachtelte Pfadsegmente enthalten.",
            ));
        }
        if !path.is_empty()
            && (path.len() > 240 || path.trim().is_empty() || path.chars().any(char::is_control))
        {
            return Err(ProviderError::input("Feldpfade müssen nichtleer sein und dürfen höchstens 240 Zeichen ohne Steuerzeichen enthalten."));
        }
        let shape = match value {
            Value::Object(_) => "object",
            Value::Array(_) => "array",
            _ => "scalar",
        };
        if !path.is_empty() {
            if self
                .shapes
                .get(&path)
                .is_some_and(|previous| *previous != shape)
            {
                return Err(ProviderError::input("Ein JSON-Pfad enthält unterschiedliche Strukturen (Skalar, Objekt oder Array). Bitte die Struktur vereinheitlichen."));
            }
            self.shapes.insert(path.clone(), shape);
            if self.shapes.len() > MAX_NODES {
                return Err(ProviderError::input(
                    "Die JSON-Struktur überschreitet 512 Unterpfade.",
                ));
            }
        }
        match value {
            Value::Object(object) => {
                self.empty_containers |= object.is_empty();
                for (key, child) in object {
                    if key.trim().is_empty()
                        || key.chars().any(char::is_control)
                        || (!csv && key.contains('.'))
                    {
                        return Err(ProviderError::input("JSON-Schlüssel mit Punkten sowie leere Feldnamen oder Steuerzeichen sind nicht eindeutig zuordenbar."));
                    }
                    let child_path = if path.is_empty() {
                        key.clone()
                    } else {
                        format!("{path}.{key}")
                    };
                    self.visit(child, child_path, depth + 1, csv)?;
                }
            }
            Value::Array(array) => {
                self.empty_containers |= array.is_empty();
                for (index, child) in array.iter().enumerate() {
                    self.visit(child, format!("{path}.{index}"), depth + 1, csv)?;
                }
            }
            _ => {
                let observation = self.leaves.entry(path).or_default();
                observation.add(value)?;
                if self.leaves.len() > MAX_FIELDS {
                    return Err(ProviderError::input(
                        "Dateien dürfen höchstens 64 zuordenbare Feldpfade enthalten.",
                    ));
                }
            }
        }
        Ok(())
    }
}

pub(super) fn inspect(input: InspectInput) -> Result<Inspection, ProviderError> {
    let rows = files::read_rows(&input.provider, &input.content, &input.delimiter, true)?;
    let mut structure = Structure::default();
    for row in &rows {
        structure.visit(row, String::new(), 0, input.provider == "csv")?;
    }
    let fields: Vec<Field> = structure
        .leaves
        .iter()
        .map(|(path, observation)| observation.field(path.clone()))
        .collect();
    let mut warnings = vec![
        "Regelbasierte Vorschläge aus Feldnamen und Dateistruktur; Datentyp und Zuordnungen müssen geprüft werden. Es wurden keine Werte fachlich validiert oder Daten gespeichert.".into(),
        "Eindeutigkeit gilt nur für diesen Upload und garantiert keine künftig stabile Kennung. Zeilennummern, Namen und E-Mail-Adressen werden nicht als Kennung abgeleitet.".into(),
    ];
    if structure.empty_containers {
        warnings.push(
            "Leere JSON-Objekte und Arrays enthalten keine zuordenbaren Skalarfelder.".into(),
        );
    }
    if fields.is_empty() {
        warnings.push("Die Datei enthält keine zuordenbaren Skalarfelder.".into());
    }
    for field in &fields {
        if field.types.len() > 1 {
            warnings.push(format!("Feld „{}“ enthält unterschiedliche skalare Typen; die Importvorschau prüft die zugeordneten Werte.", field.path));
        }
        if field.present < rows.len() {
            warnings.push(format!("Feld „{}“ fehlt in {} Zeilen; dafür wird keine automatische Zuordnung vorgeschlagen.", field.path, rows.len() - field.present));
        }
    }
    let definitions = sitegraph_company_hub::kinds();
    let mut ranked = Vec::new();
    for (order, key) in KINDS.into_iter().enumerate() {
        let definition = definitions
            .iter()
            .find(|kind| kind.key == key)
            .expect("built-in file kind");
        let (score, suggestion) = suggest(definition, &fields, rows.len(), &input.delimiter);
        ranked.push((score, order, suggestion));
    }
    ranked.sort_by(|left, right| right.0.cmp(&left.0).then(left.1.cmp(&right.1)));
    Ok(Inspection {
        version: 1,
        mode: "rules",
        provider: input.provider,
        delimiter: input.delimiter,
        row_count: rows.len(),
        fields,
        suggestions: ranked
            .into_iter()
            .map(|(_, _, suggestion)| suggestion)
            .collect(),
        warnings,
    })
}

fn normalize(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .flat_map(|character| match character {
            'ä' => "ae".chars().collect::<Vec<_>>(),
            'ö' => "oe".chars().collect(),
            'ü' => "ue".chars().collect(),
            'ß' => "ss".chars().collect(),
            character if character.is_alphanumeric() => vec![character],
            _ => vec![],
        })
        .collect()
}
fn matches(path: &str, aliases: &[&str]) -> bool {
    let full = normalize(path);
    let leaf = normalize(path.rsplit('.').next().unwrap_or(path));
    aliases.iter().any(|alias| *alias == full || *alias == leaf)
}
fn identity_aliases(kind: &str) -> &'static [&'static str] {
    match kind {
        "company" => &[
            "companyid",
            "companynumber",
            "firmenid",
            "firmennummer",
            "firmennr",
            "unternehmensid",
            "unternehmensnummer",
        ],
        "contact" => &[
            "contactid",
            "customerid",
            "customernumber",
            "kontaktid",
            "kontaktnummer",
            "kontaktnr",
            "kundenid",
            "kundennummer",
            "kundennr",
            "kdnr",
            "personid",
        ],
        "location" => &[
            "locationid",
            "locationnumber",
            "siteid",
            "standortid",
            "standortnummer",
            "standortnr",
        ],
        "product" => &[
            "productid",
            "productnumber",
            "artikelid",
            "artikelnummer",
            "produktid",
            "produktnummer",
            "sku",
            "artikelnr",
            "artnr",
        ],
        _ => &[],
    }
}
fn aliases(kind: &str, target: &str) -> &'static [&'static str] {
    match target {
        "legal_name" => &[
            "legalname",
            "companyname",
            "businessname",
            "firma",
            "firmenname",
            "unternehmen",
            "unternehmensname",
            "rechtlichername",
        ],
        "name" => match kind {
            "contact" => &[
                "fullname",
                "contactname",
                "customername",
                "personname",
                "kontaktname",
                "kundenname",
                "vollstaendigername",
                "ansprechpartner",
            ],
            "location" => &[
                "locationname",
                "sitename",
                "standortname",
                "standort",
                "filiale",
                "filialname",
            ],
            "product" => &[
                "productname",
                "articlename",
                "artikelname",
                "produktname",
                "artikelbezeichnung",
                "produktbezeichnung",
                "bezeichnung",
                "title",
                "titel",
            ],
            _ => &[],
        },
        "email" => &[
            "email",
            "emailaddress",
            "emailadresse",
            "mail",
            "mailadresse",
            "mailaddress",
        ],
        "phone" => &[
            "phone",
            "phonenumber",
            "telephone",
            "telefon",
            "telefonnummer",
            "tel",
            "mobil",
            "mobile",
        ],
        "website" => &["website", "webseite", "homepage", "webadresse", "url"],
        "tax_id" => &[
            "taxid",
            "vatid",
            "vatnumber",
            "vat",
            "steuerkennung",
            "steuernummer",
            "ustid",
            "ustidnr",
            "umsatzsteuerid",
        ],
        "address" => &[
            "address",
            "postaladdress",
            "anschrift",
            "adresse",
            "postanschrift",
        ],
        "position" => &[
            "position",
            "jobtitle",
            "funktion",
            "berufsbezeichnung",
            "rolle",
        ],
        "notes" => &[
            "notes",
            "note",
            "notizen",
            "notiz",
            "bemerkungen",
            "bemerkung",
            "kommentar",
            "comments",
        ],
        "sku" => &[
            "sku",
            "artikelnummer",
            "artikelnr",
            "artnr",
            "productnumber",
            "produktnummer",
        ],
        "description" => &[
            "description",
            "beschreibung",
            "produktbeschreibung",
            "artikelbeschreibung",
        ],
        "unit" => &["unit", "einheit", "masseinheit", "mengeneinheit"],
        "opening_hours" => &["openinghours", "oeffnungszeiten", "oeffnungszeit"],
        _ => &[],
    }
}

fn choose(
    fields: &[Field],
    kind: &str,
    target: &str,
    required: bool,
    row_count: usize,
    reasons: &mut Vec<String>,
) -> (String, usize) {
    let candidates: Vec<_> = fields
        .iter()
        .filter(|field| {
            matches(&field.path, aliases(kind, target))
                || (matches!(target, "name" | "legal_name") && matches(&field.path, &["name"]))
        })
        .collect();
    match candidates.as_slice() {
        [] => (String::new(), 0),
        [field] if field.present == row_count && (!required || field.non_empty == row_count) => {
            let weight = if matches(&field.path, aliases(kind, target))
                && matches!(
                    target,
                    "name" | "legal_name" | "sku" | "tax_id" | "opening_hours"
                ) {
                4
            } else {
                1
            };
            reasons.push(format!(
                "data.{target}: eindeutige Feldnamen-Übereinstimmung mit „{}“{}.",
                field.path,
                if weight == 1 && matches!(target, "name" | "legal_name") {
                    " (allgemeines Namensfeld)"
                } else {
                    ""
                }
            ));
            (field.path.clone(), weight)
        }
        [_] => {
            reasons.push(format!("data.{target}: passendes Feld ist nicht in allen Zeilen vorhanden oder für ein Pflichtfeld leer; Zuordnung bleibt offen."));
            (String::new(), 0)
        }
        _ => {
            reasons.push(format!("data.{target}: mehrere passende Feldnamen ({}); mehrdeutig, deshalb kein Vorschlag.", candidates.iter().map(|field|format!("„{}“",field.path)).collect::<Vec<_>>().join(", ")));
            (String::new(), 0)
        }
    }
}

fn suggest(
    kind: &sitegraph_company_hub::Kind,
    fields: &[Field],
    row_count: usize,
    delimiter: &str,
) -> (usize, Suggestion) {
    let mut reasons = Vec::new();
    let mut missing = Vec::new();
    let mut mapped = BTreeMap::new();
    let mut score = 0;
    let ids: Vec<_> = fields
        .iter()
        .filter(|field| {
            (matches(
                &field.path,
                &[
                    "id",
                    "externalid",
                    "externalidentifier",
                    "externeid",
                    "externekennung",
                    "kennung",
                ],
            ) || KINDS
                .iter()
                .any(|kind| matches(&field.path, identity_aliases(kind))))
                && field.present == row_count
                && field.non_empty == row_count
                && field.unique
        })
        .collect();
    let external_id = match ids.as_slice() {
        [field] => {
            reasons.push(format!("external_id: ID-/SKU-Feld „{}“ ist in jeder Zeile gefüllt und nach Import-Textkonvertierung innerhalb dieses Uploads eindeutig. Künftige Stabilität ist damit nicht belegt.", field.path));
            score += if matches(&field.path, identity_aliases(&kind.key)) {
                4
            } else {
                1
            };
            field.path.clone()
        }
        [] => {
            reasons.push("external_id: kein vollständiges, nichtleeres und im Upload eindeutiges ID-/SKU-Feld erkannt; Kennung bleibt offen.".into());
            String::new()
        }
        _ => {
            reasons.push(format!("external_id: mehrere geeignete ID-/SKU-Felder ({}); mehrdeutig, deshalb kein Vorschlag.", ids.iter().map(|field|format!("„{}“",field.path)).collect::<Vec<_>>().join(", ")));
            String::new()
        }
    };
    if external_id.is_empty() {
        missing.push("external_id".into());
    }
    for target in &kind.fields {
        let (path, weight) = choose(
            fields,
            &kind.key,
            &target.key,
            target.required,
            row_count,
            &mut reasons,
        );
        if path.is_empty() && target.required {
            missing.push(format!("data.{}", target.key));
        }
        score += weight;
        if !path.is_empty() {
            mapped.insert(target.key.clone(), path);
        }
    }
    let name = mapped
        .get(if kind.key == "company" {
            "legal_name"
        } else {
            "name"
        })
        .cloned()
        .unwrap_or_default();
    if name.is_empty() {
        missing.push("name".into());
        reasons.push("name: kein eindeutiges vollständiges Namensfeld; Namens- oder Adressbestandteile werden nicht automatisch zusammengesetzt.".into());
    } else {
        reasons.push(format!(
            "name: dieselbe geprüfte Feldnamen-Zuordnung „{name}“ wie das fachliche Namensfeld."
        ));
    }
    reasons.push(format!("Reihenfolge: {score} Regelpunkte für eindeutige Feldnamen-Übereinstimmungen; spezifische Fachfelder zählen stärker als allgemeine Felder. Bei Gleichstand gilt eine feste Reihenfolge, keine fachliche Feststellung."));
    (
        score,
        Suggestion {
            kind: kind.key.clone(),
            label: kind.name.clone(),
            mapping: ConnectorMapping {
                kind: kind.key.clone(),
                external_id,
                name,
                fields: mapped,
                delimiter: delimiter.into(),
            },
            reasons,
            missing,
        },
    )
}
