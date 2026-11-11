//! SiteGraph domain types.
//!
//! Pure data + rules, no IO. Everything here is serializable and free of
//! database or transport concerns (Whitepaper §22: "Core vor UI").

pub mod flintplate;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;
use uuid::Uuid;

/// Tenant. An organization owns all websites and content (Whitepaper §6).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Organization {
    pub id: Uuid,
    pub name: String,
    pub slug: String,
    pub created_at: DateTime<Utc>,
}

/// A website / channel / view onto the shared content (Whitepaper §6).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Website {
    pub id: Uuid,
    pub org_id: Uuid,
    pub name: String,
    pub slug: String,
    pub domain: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// A stored media asset's metadata (the bytes live in a blob store, v2).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Asset {
    pub id: Uuid,
    pub org_id: Uuid,
    pub filename: String,
    pub content_type: String,
    pub byte_size: i64,
    pub created_at: DateTime<Utc>,
}

/// A configured AI provider connector (v3). The API key is never serialized.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AiConnector {
    pub id: Uuid,
    pub org_id: Uuid,
    pub name: String,
    pub provider: String,
    pub active: bool,
    /// Whether an API key is stored (without revealing it).
    pub has_key: bool,
    /// Reusable system preprompt prepended to every agent using this connector.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preprompt: Option<String>,
    /// Default model used when an agent node does not specify one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// A visual AI content workflow: a node/edge graph (v3).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AiWorkflow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub name: String,
    pub graph: Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// A single execution of a workflow with its per-node trace (v3).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AiRun {
    pub id: Uuid,
    pub workflow_id: Uuid,
    pub status: String,
    pub trace: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<DateTime<Utc>>,
}

/// An outbound publish webhook endpoint (v2). The secret is never serialized.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Webhook {
    pub id: Uuid,
    pub org_id: Uuid,
    pub url: String,
    pub active: bool,
    pub created_at: DateTime<Utc>,
}

/// One delivery attempt record from the webhook outbox (history + DLQ view).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct WebhookDelivery {
    pub id: Uuid,
    pub webhook_id: Uuid,
    pub event: String,
    pub status: String,
    pub attempts: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_status: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivered_at: Option<DateTime<Utc>>,
}

/// Schema-driven content type. New types are data, not code (see dev plan §A).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ContentType {
    pub id: Uuid,
    pub org_id: Uuid,
    pub key: String,
    pub name: String,
    /// Field definitions used to validate `ContentObject.data`.
    pub schema: Value,
}

/// Publish lifecycle. Walking skeleton only needs Draft/Published (WP1.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Draft,
    Published,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Draft => "draft",
            Status::Published => "published",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "published" => Status::Published,
            _ => Status::Draft,
        }
    }
}

/// An authenticated principal (WP1.3). Never carries the password hash.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct User {
    pub id: Uuid,
    pub email: String,
    pub name: String,
}

/// Role of a user within an organization (WP1.3). Ordered by privilege.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Viewer,
    Editor,
    Owner,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Viewer => "viewer",
            Role::Editor => "editor",
            Role::Owner => "owner",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "viewer" => Some(Role::Viewer),
            "editor" => Some(Role::Editor),
            "owner" => Some(Role::Owner),
            _ => None,
        }
    }

    /// Privilege rank; higher includes the rights of lower roles.
    pub fn rank(self) -> u8 {
        match self {
            Role::Viewer => 1,
            Role::Editor => 2,
            Role::Owner => 3,
        }
    }

    /// True if this role satisfies the required minimum.
    pub fn allows(self, min: Role) -> bool {
        self.rank() >= min.rank()
    }
}

/// A user's role within a specific organization.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Membership {
    pub org_id: Uuid,
    /// Organization display name, resolved for the org switcher.
    #[serde(default)]
    pub org_name: String,
    pub role: Role,
}

/// A unit of content. Its fields live in `data` (JSONB), validated against the
/// content type's schema.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ContentObject {
    pub id: Uuid,
    pub org_id: Uuid,
    pub content_type_id: Uuid,
    pub status: Status,
    /// Monotonic concurrency token for data, status and channel assignments.
    pub revision: i64,
    pub data: Value,
    /// The immutable data and channel assignments last approved for delivery.
    pub publication: Option<ContentPublication>,
    pub has_unpublished_changes: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// A release is independent from the working copy and its channel assignments.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ContentPublication {
    pub data: Value,
    pub assignments: Vec<ChannelAssignment>,
    pub revision: i64,
    pub published_at: DateTime<Utc>,
}

/// A publish deadline approves one specific working revision.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ContentSchedule {
    pub schedule_revision: i64,
    pub publish_at: Option<DateTime<Utc>>,
    pub unpublish_at: Option<DateTime<Utc>>,
    pub publish_revision: Option<i64>,
    pub publish_conflict: bool,
    pub revision: i64,
}

/// Assignment of a content object to a website, with optional local overrides
/// (Whitepaper §6: "lokale Overrides").
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ChannelAssignment {
    pub website_id: Uuid,
    pub overrides: Option<Value>,
}

/// An immutable snapshot of a content object's `data` (Whitepaper §8 / WP1.5).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ContentVersion {
    pub id: Uuid,
    pub content_object_id: Uuid,
    pub data: Value,
    pub created_at: DateTime<Utc>,
}

/// An append-only audit record of a writing action (WP1.4 / §19).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AuditEntry {
    pub id: Uuid,
    pub user_id: Option<Uuid>,
    /// Actor's email, resolved for display (None for system/deleted users).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_email: Option<String>,
    pub action: String,
    pub target_type: String,
    pub target_id: Option<Uuid>,
    pub meta: Option<Value>,
    pub created_at: DateTime<Utc>,
}

// --- Schema validation (WP1.2) ---------------------------------------------

/// A single field definition inside a [`ContentType`] schema.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FieldDef {
    pub key: String,
    #[serde(default)]
    pub label: String,
    #[serde(rename = "type")]
    pub field_type: String,
    #[serde(default)]
    pub required: bool,
    /// For `relation-ref` fields: the content type key this field points at.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_type: Option<String>,
}

/// Extract the field list from a content type schema (`{"fields":[...]}`).
pub fn parse_fields(schema: &Value) -> Vec<FieldDef> {
    schema
        .get("fields")
        .and_then(|f| serde_json::from_value::<Vec<FieldDef>>(f.clone()).ok())
        .unwrap_or_default()
}

/// Validate a content object's `data` against its type schema (WP1.2).
///
/// Returns a list of human-readable errors (empty = valid). Checks required
/// fields and basic type shape. Unknown field types are not type-checked.
pub fn validate(schema: &Value, data: &Value) -> Vec<String> {
    let mut errors = Vec::new();
    let Some(obj) = data.as_object() else {
        errors.push("data must be a JSON object".to_string());
        return errors;
    };

    for f in parse_fields(schema) {
        let val = obj.get(&f.key);
        let missing = matches!(val, None | Some(Value::Null))
            || matches!(val, Some(Value::String(s)) if s.trim().is_empty());

        if missing {
            if f.required {
                errors.push(format!("field '{}' is required", f.key));
            }
            continue;
        }

        let v = val.expect("present after missing check");
        let type_ok = match f.field_type.as_str() {
            "text" | "richtext" | "select" | "date" | "media" | "relation-ref" => v.is_string(),
            "number" => v.is_number(),
            _ => true,
        };
        if !type_ok {
            errors.push(format!(
                "field '{}' must be of type {}",
                f.key, f.field_type
            ));
        }
    }
    errors
}

/// Merge a base object's `data` with per-channel `overrides`.
///
/// Shallow merge: top-level keys in `overrides` replace those in `base`. This
/// is the mechanism that lets one object render differently per channel without
/// duplicating it (Whitepaper §6).
pub fn merge_overrides(base: &Value, overrides: Option<&Value>) -> Value {
    let mut out = base.clone();
    if let (Some(Value::Object(over)), Value::Object(target)) = (overrides, &mut out) {
        for (k, v) in over {
            target.insert(k.clone(), v.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn override_replaces_top_level_key() {
        let base = json!({"name": "Darmstadt", "phone": "06151"});
        let over = json!({"phone": "06151-999"});
        let merged = merge_overrides(&base, Some(&over));
        assert_eq!(merged["name"], json!("Darmstadt"));
        assert_eq!(merged["phone"], json!("06151-999"));
    }

    #[test]
    fn no_overrides_returns_base() {
        let base = json!({"name": "Darmstadt"});
        assert_eq!(merge_overrides(&base, None), base);
    }

    fn standort_schema() -> Value {
        json!({"fields": [
            {"key": "name", "type": "text", "required": true},
            {"key": "telefon", "type": "text", "required": false},
            {"key": "etagen", "type": "number", "required": false}
        ]})
    }

    #[test]
    fn validate_accepts_valid_data() {
        let data = json!({"name": "Darmstadt", "telefon": "06151"});
        assert!(validate(&standort_schema(), &data).is_empty());
    }

    #[test]
    fn validate_flags_missing_required() {
        let data = json!({"telefon": "06151"});
        let errs = validate(&standort_schema(), &data);
        assert_eq!(errs.len(), 1);
        assert!(errs[0].contains("name"));
    }

    #[test]
    fn validate_flags_empty_required_string() {
        let data = json!({"name": "   "});
        assert_eq!(validate(&standort_schema(), &data).len(), 1);
    }

    #[test]
    fn validate_flags_wrong_type() {
        let data = json!({"name": "Darmstadt", "etagen": "drei"});
        let errs = validate(&standort_schema(), &data);
        assert_eq!(errs.len(), 1);
        assert!(errs[0].contains("etagen"));
    }
}
