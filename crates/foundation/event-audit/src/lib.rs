//! Foundation: Event & Audit (F1.3) — Rust port of the TS reference module.
//!
//! Owns the event envelope, outbox/inbox delivery, schema registry, event
//! streams with optimistic concurrency, and an append-only hash-chained audit
//! log (see `modules/foundation/event-audit`). Isolated crate.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::cell::RefCell;

pub type Id = String;
pub type IsoDateTime = String;

// --- Errors ----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EventError {
    #[error("outbox '{0}' not found")]
    OutboxNotFound(String),
    #[error("inbox '{0}' not found")]
    InboxNotFound(String),
    #[error("event schema '{0}' already exists")]
    SchemaConflict(String),
    #[error("expected stream version {expected}, current is {current}")]
    StreamVersionConflict { expected: u64, current: u64 },
}

// --- Enums -----------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutboxState {
    Pending,
    Leased,
    Delivered,
    Failed,
    DeadLetter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryState {
    Delivered,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InboxState {
    Processing,
    Processed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditOutcome {
    Success,
    Failure,
    Denied,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SchemaCompatibility {
    Backward,
    Forward,
    Full,
    None,
}

// --- Value types -----------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorRef {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub principal_id: Option<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub party_id: Option<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ip_address: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ref {
    #[serde(rename = "type")]
    pub kind: String,
    pub id: Id,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamPos {
    #[serde(rename = "type")]
    pub kind: String,
    pub id: Id,
    pub version: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope {
    pub id: Id,
    #[serde(rename = "type")]
    pub kind: String,
    pub version: u64,
    pub organization_id: Id,
    pub occurred_at: IsoDateTime,
    pub correlation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub causation_id: Option<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor: Option<ActorRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<Ref>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream: Option<StreamPos>,
    pub payload: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Map<String, Value>>,
}

/// Event without server-assigned `id`/`occurredAt` (and `stream` for appends).
#[derive(Debug, Clone, Default)]
pub struct EventInput {
    pub kind: String,
    pub version: u64,
    pub organization_id: Id,
    pub correlation_id: String,
    pub causation_id: Option<Id>,
    pub actor: Option<ActorRef>,
    pub subject: Option<Ref>,
    pub payload: Value,
    pub metadata: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxItem {
    pub id: Id,
    pub event: EventEnvelope,
    pub state: OutboxState,
    pub attempts: u32,
    pub available_at: IsoDateTime,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_until: Option<IsoDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct DeliveryReceipt {
    pub destination: String,
    pub state: Option<DeliveryState>,
    pub delivered_at: Option<IsoDateTime>,
    pub remote_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub id: Id,
    pub consumer: String,
    pub event_id: Id,
    pub event_type: String,
    pub state: InboxState,
    pub received_at: IsoDateTime,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub processed_at: Option<IsoDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

pub struct BeginResult {
    pub accepted: bool,
    pub item: InboxItem,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventSchema {
    #[serde(rename = "type")]
    pub kind: String,
    pub version: u64,
    pub compatibility: SchemaCompatibility,
    pub required_payload_fields: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deprecated: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationResult {
    pub valid: bool,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub field: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: Id,
    pub organization_id: Id,
    pub occurred_at: IsoDateTime,
    pub action: String,
    pub outcome: AuditOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor: Option<ActorRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<Ref>,
    pub correlation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changes: Option<Vec<Change>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_hash: Option<String>,
    pub hash: String,
}

#[derive(Debug, Clone, Default)]
pub struct AuditInput {
    pub organization_id: Id,
    pub action: String,
    pub outcome: Option<AuditOutcome>,
    pub actor: Option<ActorRef>,
    pub target: Option<Ref>,
    pub correlation_id: String,
    pub reason: Option<String>,
    pub changes: Option<Vec<Change>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyResult {
    pub valid: bool,
    pub broken_at: Option<Id>,
}

// --- Helpers ---------------------------------------------------------------

fn now() -> IsoDateTime {
    Utc::now().to_rfc3339()
}

fn parse(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

/// FNV-1a over a string (matches the TS reference hash; used only internally
/// for the audit chain's self-consistency).
fn fnv1a(s: &str) -> String {
    let mut hash: u32 = 2166136261;
    for b in s.bytes() {
        hash ^= b as u32;
        hash = hash.wrapping_mul(16777619);
    }
    format!("{hash:x}")
}

/// Hash of an audit entry excluding its own `hash` field. serde_json's default
/// Map is key-sorted, so the serialization is deterministic.
fn audit_hash(entry: &AuditEntry) -> String {
    let mut value = serde_json::to_value(entry).unwrap_or(Value::Null);
    if let Value::Object(ref mut map) = value {
        map.remove("hash");
    }
    fnv1a(&value.to_string())
}

// --- In-memory reference implementation ------------------------------------

#[derive(Default)]
struct Inner {
    events: Vec<EventEnvelope>,
    outbox: Vec<OutboxItem>,
    inbox: Vec<InboxItem>,
    schemas: Vec<EventSchema>,
    streams: Vec<(String, Vec<EventEnvelope>)>,
    audit: Vec<AuditEntry>,
    sequence: u64,
}

impl Inner {
    fn next(&mut self, prefix: &str) -> String {
        self.sequence += 1;
        format!("{prefix}-{}", self.sequence)
    }

    fn enqueue(&mut self, event: EventEnvelope) -> OutboxItem {
        let item = OutboxItem {
            id: self.next("outbox"),
            event,
            state: OutboxState::Pending,
            attempts: 0,
            available_at: now(),
            lease_until: None,
            last_error: None,
        };
        self.outbox.push(item.clone());
        item
    }

    fn stream_mut(&mut self, key: &str) -> &mut Vec<EventEnvelope> {
        if !self.streams.iter().any(|(k, _)| k == key) {
            self.streams.push((key.to_string(), Vec::new()));
        }
        &mut self.streams.iter_mut().find(|(k, _)| k == key).unwrap().1
    }

    fn stream_get(&self, key: &str) -> &[EventEnvelope] {
        self.streams
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_slice())
            .unwrap_or(&[])
    }
}

#[derive(Default)]
pub struct ReferenceEventAuditStore {
    inner: RefCell<Inner>,
}

impl ReferenceEventAuditStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn schema_key(kind: &str, version: u64) -> String {
        format!("{kind}@{version}")
    }
    fn stream_key(kind: &str, id: &str) -> String {
        format!("{kind}:{id}")
    }

    fn build_event(
        inner: &mut Inner,
        input: EventInput,
        stream: Option<StreamPos>,
    ) -> EventEnvelope {
        EventEnvelope {
            id: inner.next("event"),
            kind: input.kind,
            version: input.version,
            organization_id: input.organization_id,
            occurred_at: now(),
            correlation_id: input.correlation_id,
            causation_id: input.causation_id,
            actor: input.actor,
            subject: input.subject,
            stream,
            payload: input.payload,
            metadata: input.metadata,
        }
    }
}

// --- Publisher + Outbox ----------------------------------------------------

pub trait EventPublisher {
    fn publish(&self, input: EventInput) -> EventEnvelope;
}

impl EventPublisher for ReferenceEventAuditStore {
    fn publish(&self, input: EventInput) -> EventEnvelope {
        let mut inner = self.inner.borrow_mut();
        let event = Self::build_event(&mut inner, input, None);
        inner.events.push(event.clone());
        inner.enqueue(event.clone());
        event
    }
}

pub trait OutboxProvider {
    fn outbox_enqueue(&self, event: EventEnvelope) -> OutboxItem;
    fn outbox_lease(&self, limit: usize, lease_seconds: i64) -> Vec<OutboxItem>;
    fn outbox_acknowledge(
        &self,
        id: &str,
        receipt: DeliveryReceipt,
    ) -> Result<OutboxItem, EventError>;
    fn outbox_fail(
        &self,
        id: &str,
        error: &str,
        retry_at: Option<IsoDateTime>,
    ) -> Result<OutboxItem, EventError>;
    fn outbox_recover_expired_leases(&self, at: Option<IsoDateTime>) -> Vec<OutboxItem>;
}

impl OutboxProvider for ReferenceEventAuditStore {
    fn outbox_enqueue(&self, event: EventEnvelope) -> OutboxItem {
        self.inner.borrow_mut().enqueue(event)
    }

    fn outbox_lease(&self, limit: usize, lease_seconds: i64) -> Vec<OutboxItem> {
        let now_dt = Utc::now();
        let mut inner = self.inner.borrow_mut();
        let mut leased = Vec::new();
        for item in inner.outbox.iter_mut() {
            if leased.len() >= limit {
                break;
            }
            let due = parse(&item.available_at)
                .map(|a| a <= now_dt)
                .unwrap_or(true);
            if (item.state == OutboxState::Pending || item.state == OutboxState::Failed) && due {
                item.state = OutboxState::Leased;
                item.lease_until = Some((now_dt + Duration::seconds(lease_seconds)).to_rfc3339());
                item.attempts += 1;
                leased.push(item.clone());
            }
        }
        leased
    }

    fn outbox_acknowledge(
        &self,
        id: &str,
        receipt: DeliveryReceipt,
    ) -> Result<OutboxItem, EventError> {
        let mut inner = self.inner.borrow_mut();
        let pos = inner
            .outbox
            .iter()
            .position(|i| i.id == id)
            .ok_or_else(|| EventError::OutboxNotFound(id.to_string()))?;
        inner.outbox[pos].state = if receipt.state == Some(DeliveryState::Delivered) {
            OutboxState::Delivered
        } else {
            OutboxState::Failed
        };
        inner.outbox[pos].lease_until = None;
        inner.outbox[pos].last_error = receipt.error;
        Ok(inner.outbox[pos].clone())
    }

    fn outbox_fail(
        &self,
        id: &str,
        error: &str,
        retry_at: Option<IsoDateTime>,
    ) -> Result<OutboxItem, EventError> {
        let mut inner = self.inner.borrow_mut();
        let pos = inner
            .outbox
            .iter()
            .position(|i| i.id == id)
            .ok_or_else(|| EventError::OutboxNotFound(id.to_string()))?;
        inner.outbox[pos].state = if inner.outbox[pos].attempts >= 3 {
            OutboxState::DeadLetter
        } else {
            OutboxState::Failed
        };
        inner.outbox[pos].last_error = Some(error.to_string());
        inner.outbox[pos].available_at = retry_at.unwrap_or_else(now);
        inner.outbox[pos].lease_until = None;
        Ok(inner.outbox[pos].clone())
    }

    fn outbox_recover_expired_leases(&self, at: Option<IsoDateTime>) -> Vec<OutboxItem> {
        let at = at.unwrap_or_else(now);
        let at_dt = parse(&at);
        let mut inner = self.inner.borrow_mut();
        let mut recovered = Vec::new();
        for item in inner.outbox.iter_mut() {
            let expired = item.state == OutboxState::Leased
                && item
                    .lease_until
                    .as_deref()
                    .and_then(parse)
                    .zip(at_dt)
                    .map(|(lu, a)| lu <= a)
                    .unwrap_or(false);
            if expired {
                item.state = OutboxState::Pending;
                item.lease_until = None;
                item.available_at = at.clone();
                recovered.push(item.clone());
            }
        }
        recovered
    }
}

// --- Inbox -----------------------------------------------------------------

pub trait InboxProvider {
    fn inbox_begin(&self, consumer: &str, event: &EventEnvelope) -> BeginResult;
    fn inbox_complete(&self, id: &str) -> Result<InboxItem, EventError>;
    fn inbox_fail(&self, id: &str, error: &str) -> Result<InboxItem, EventError>;
}

impl InboxProvider for ReferenceEventAuditStore {
    fn inbox_begin(&self, consumer: &str, event: &EventEnvelope) -> BeginResult {
        let mut inner = self.inner.borrow_mut();
        if let Some(existing) = inner
            .inbox
            .iter()
            .find(|i| i.consumer == consumer && i.event_id == event.id)
        {
            return BeginResult {
                accepted: false,
                item: existing.clone(),
            };
        }
        let item = InboxItem {
            id: inner.next("inbox"),
            consumer: consumer.to_string(),
            event_id: event.id.clone(),
            event_type: event.kind.clone(),
            state: InboxState::Processing,
            received_at: now(),
            processed_at: None,
            last_error: None,
        };
        inner.inbox.push(item.clone());
        BeginResult {
            accepted: true,
            item,
        }
    }

    fn inbox_complete(&self, id: &str) -> Result<InboxItem, EventError> {
        let mut inner = self.inner.borrow_mut();
        let pos = inner
            .inbox
            .iter()
            .position(|i| i.id == id)
            .ok_or_else(|| EventError::InboxNotFound(id.to_string()))?;
        inner.inbox[pos].state = InboxState::Processed;
        inner.inbox[pos].processed_at = Some(now());
        Ok(inner.inbox[pos].clone())
    }

    fn inbox_fail(&self, id: &str, error: &str) -> Result<InboxItem, EventError> {
        let mut inner = self.inner.borrow_mut();
        let pos = inner
            .inbox
            .iter()
            .position(|i| i.id == id)
            .ok_or_else(|| EventError::InboxNotFound(id.to_string()))?;
        inner.inbox[pos].state = InboxState::Failed;
        inner.inbox[pos].last_error = Some(error.to_string());
        Ok(inner.inbox[pos].clone())
    }
}

// --- Schema registry -------------------------------------------------------

pub trait EventSchemaProvider {
    fn schema_register(&self, schema: EventSchema) -> Result<EventSchema, EventError>;
    fn schema_get(&self, kind: &str, version: u64) -> Option<EventSchema>;
    fn schema_validate(&self, event: &EventEnvelope) -> ValidationResult;
}

impl EventSchemaProvider for ReferenceEventAuditStore {
    fn schema_register(&self, schema: EventSchema) -> Result<EventSchema, EventError> {
        let key = Self::schema_key(&schema.kind, schema.version);
        let mut inner = self.inner.borrow_mut();
        if inner
            .schemas
            .iter()
            .any(|s| Self::schema_key(&s.kind, s.version) == key)
        {
            return Err(EventError::SchemaConflict(key));
        }
        inner.schemas.push(schema.clone());
        Ok(schema)
    }

    fn schema_get(&self, kind: &str, version: u64) -> Option<EventSchema> {
        self.inner
            .borrow()
            .schemas
            .iter()
            .find(|s| s.kind == kind && s.version == version)
            .cloned()
    }

    fn schema_validate(&self, event: &EventEnvelope) -> ValidationResult {
        let inner = self.inner.borrow();
        let Some(schema) = inner
            .schemas
            .iter()
            .find(|s| s.kind == event.kind && s.version == event.version)
        else {
            return ValidationResult {
                valid: false,
                errors: vec!["schema_not_registered".to_string()],
            };
        };
        let empty = Map::new();
        let payload = event.payload.as_object().unwrap_or(&empty);
        let errors: Vec<String> = schema
            .required_payload_fields
            .iter()
            .filter(|f| !payload.contains_key(*f))
            .map(|f| format!("missing:{f}"))
            .collect();
        ValidationResult {
            valid: errors.is_empty(),
            errors,
        }
    }
}

// --- Event streams ---------------------------------------------------------

pub trait EventStreamProvider {
    fn stream_append(
        &self,
        kind: &str,
        id: &str,
        expected_version: u64,
        events: Vec<EventInput>,
    ) -> Result<Vec<EventEnvelope>, EventError>;
    fn stream_read(&self, kind: &str, id: &str, from_version: u64) -> Vec<EventEnvelope>;
    fn stream_version(&self, kind: &str, id: &str) -> u64;
}

impl EventStreamProvider for ReferenceEventAuditStore {
    fn stream_append(
        &self,
        kind: &str,
        id: &str,
        expected_version: u64,
        events: Vec<EventInput>,
    ) -> Result<Vec<EventEnvelope>, EventError> {
        let key = Self::stream_key(kind, id);
        let mut inner = self.inner.borrow_mut();
        let current = inner.stream_get(&key).len() as u64;
        if current != expected_version {
            return Err(EventError::StreamVersionConflict {
                expected: expected_version,
                current,
            });
        }
        let mut appended = Vec::new();
        for (offset, input) in events.into_iter().enumerate() {
            let pos = StreamPos {
                kind: kind.to_string(),
                id: id.to_string(),
                version: current + offset as u64 + 1,
            };
            let event = Self::build_event(&mut inner, input, Some(pos));
            appended.push(event.clone());
            inner.events.push(event.clone());
            inner.enqueue(event);
        }
        for event in &appended {
            inner.stream_mut(&key).push(event.clone());
        }
        Ok(appended)
    }

    fn stream_read(&self, kind: &str, id: &str, from_version: u64) -> Vec<EventEnvelope> {
        let key = Self::stream_key(kind, id);
        let inner = self.inner.borrow();
        inner
            .stream_get(&key)
            .iter()
            .filter(|e| e.stream.as_ref().map(|s| s.version).unwrap_or(0) >= from_version)
            .cloned()
            .collect()
    }

    fn stream_version(&self, kind: &str, id: &str) -> u64 {
        let key = Self::stream_key(kind, id);
        self.inner.borrow().stream_get(&key).len() as u64
    }
}

// --- Audit -----------------------------------------------------------------

pub trait AuditProvider {
    fn audit_append(&self, input: AuditInput) -> AuditEntry;
    fn audit_list(&self, organization_id: &str, target: Option<&Ref>) -> Vec<AuditEntry>;
    fn audit_by_correlation(&self, organization_id: &str, correlation_id: &str) -> Vec<AuditEntry>;
    fn audit_verify(&self, organization_id: &str) -> VerifyResult;
}

impl AuditProvider for ReferenceEventAuditStore {
    fn audit_append(&self, input: AuditInput) -> AuditEntry {
        let mut inner = self.inner.borrow_mut();
        let previous_hash = inner
            .audit
            .iter()
            .rev()
            .find(|e| e.organization_id == input.organization_id)
            .map(|e| e.hash.clone());
        let mut entry = AuditEntry {
            id: inner.next("audit"),
            organization_id: input.organization_id,
            occurred_at: now(),
            action: input.action,
            outcome: input.outcome.unwrap_or(AuditOutcome::Success),
            actor: input.actor,
            target: input.target,
            correlation_id: input.correlation_id,
            reason: input.reason,
            changes: input.changes,
            previous_hash,
            hash: String::new(),
        };
        entry.hash = audit_hash(&entry);
        inner.audit.push(entry.clone());
        entry
    }

    fn audit_list(&self, organization_id: &str, target: Option<&Ref>) -> Vec<AuditEntry> {
        let inner = self.inner.borrow();
        inner
            .audit
            .iter()
            .filter(|e| e.organization_id == organization_id)
            .filter(|e| match target {
                None => true,
                Some(t) => e
                    .target
                    .as_ref()
                    .map(|et| et.kind == t.kind && et.id == t.id)
                    .unwrap_or(false),
            })
            .cloned()
            .collect()
    }

    fn audit_by_correlation(&self, organization_id: &str, correlation_id: &str) -> Vec<AuditEntry> {
        let inner = self.inner.borrow();
        inner
            .audit
            .iter()
            .filter(|e| e.organization_id == organization_id && e.correlation_id == correlation_id)
            .cloned()
            .collect()
    }

    fn audit_verify(&self, organization_id: &str) -> VerifyResult {
        let inner = self.inner.borrow();
        let mut previous_hash: Option<String> = None;
        for entry in inner
            .audit
            .iter()
            .filter(|e| e.organization_id == organization_id)
        {
            if entry.previous_hash != previous_hash || audit_hash(entry) != entry.hash {
                return VerifyResult {
                    valid: false,
                    broken_at: Some(entry.id.clone()),
                };
            }
            previous_hash = Some(entry.hash.clone());
        }
        VerifyResult {
            valid: true,
            broken_at: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(kind: &str, corr: &str) -> EventInput {
        EventInput {
            kind: kind.into(),
            version: 1,
            organization_id: "tenant-1".into(),
            correlation_id: corr.into(),
            payload: json!({}),
            ..Default::default()
        }
    }

    #[test]
    fn published_event_carries_correlation_causation_actor() {
        let store = ReferenceEventAuditStore::new();
        let event = store.publish(EventInput {
            kind: "commerce.order.created".into(),
            version: 1,
            organization_id: "tenant-1".into(),
            correlation_id: "corr-1".into(),
            causation_id: Some("command-1".into()),
            actor: Some(ActorRef {
                principal_id: Some("principal-1".into()),
                party_id: Some("party-1".into()),
                ..Default::default()
            }),
            payload: json!({ "orderId": "order-1" }),
            ..Default::default()
        });
        assert_eq!(event.correlation_id, "corr-1");
        assert_eq!(event.actor.unwrap().party_id.as_deref(), Some("party-1"));
    }

    #[test]
    fn publish_creates_outbox_item() {
        let store = ReferenceEventAuditStore::new();
        store.publish(ev("work.task.created", "corr"));
        assert_eq!(store.inner.borrow().outbox.len(), 1);
    }

    #[test]
    fn failed_delivery_becomes_dead_letter() {
        let store = ReferenceEventAuditStore::new();
        store.publish(ev("test", "corr"));
        let id = store.inner.borrow().outbox[0].id.clone();
        for _ in 0..3 {
            store.outbox_lease(1, 30);
            store.outbox_fail(&id, "network", None).unwrap();
        }
        let state = store.inner.borrow().outbox[0].state;
        assert_eq!(state, OutboxState::DeadLetter);
    }

    #[test]
    fn audit_chain_detects_tampering() {
        let store = ReferenceEventAuditStore::new();
        store.audit_append(AuditInput {
            organization_id: "tenant-1".into(),
            action: "create".into(),
            outcome: Some(AuditOutcome::Success),
            correlation_id: "corr".into(),
            target: Some(Ref {
                kind: "party".into(),
                id: "party-1".into(),
            }),
            ..Default::default()
        });
        store.audit_append(AuditInput {
            organization_id: "tenant-1".into(),
            action: "update".into(),
            outcome: Some(AuditOutcome::Success),
            correlation_id: "corr".into(),
            target: Some(Ref {
                kind: "party".into(),
                id: "party-1".into(),
            }),
            ..Default::default()
        });
        assert!(store.audit_verify("tenant-1").valid);
        store.inner.borrow_mut().audit[0].reason = Some("tampered".into());
        assert!(!store.audit_verify("tenant-1").valid);
    }

    #[test]
    fn inbox_accepts_event_once_per_consumer() {
        let store = ReferenceEventAuditStore::new();
        let event = store.publish(ev("forms.submission.created", "corr-inbox"));
        let first = store.inbox_begin("privacy-connector", &event);
        let second = store.inbox_begin("privacy-connector", &event);
        assert!(first.accepted);
        assert!(!second.accepted);
    }

    #[test]
    fn event_schema_validates_required_payload_fields() {
        let store = ReferenceEventAuditStore::new();
        store
            .schema_register(EventSchema {
                kind: "commerce.order.created".into(),
                version: 1,
                compatibility: SchemaCompatibility::Backward,
                required_payload_fields: vec!["orderId".into(), "total".into()],
                deprecated: None,
            })
            .unwrap();
        let valid = store.schema_validate(&EventEnvelope {
            id: "event-1".into(),
            kind: "commerce.order.created".into(),
            version: 1,
            organization_id: "tenant-1".into(),
            occurred_at: now(),
            correlation_id: "corr".into(),
            causation_id: None,
            actor: None,
            subject: None,
            stream: None,
            payload: json!({ "orderId": "order-1", "total": 100 }),
            metadata: None,
        });
        let invalid = store.schema_validate(&EventEnvelope {
            id: "event-2".into(),
            kind: "commerce.order.created".into(),
            version: 1,
            organization_id: "tenant-1".into(),
            occurred_at: now(),
            correlation_id: "corr".into(),
            causation_id: None,
            actor: None,
            subject: None,
            stream: None,
            payload: json!({ "orderId": "order-1" }),
            metadata: None,
        });
        assert!(valid.valid);
        assert_eq!(invalid.errors, vec!["missing:total".to_string()]);
    }

    #[test]
    fn expired_outbox_lease_is_recovered() {
        let store = ReferenceEventAuditStore::new();
        store.publish(ev("test", "corr-recovery"));
        let leased = store.outbox_lease(1, 1);
        let recovered = store
            .outbox_recover_expired_leases(Some((Utc::now() + Duration::seconds(2)).to_rfc3339()));
        assert_eq!(recovered[0].id, leased[0].id);
        assert_eq!(store.inner.borrow().outbox[0].state, OutboxState::Pending);
    }

    #[test]
    fn audit_entries_reconstructed_by_correlation() {
        let store = ReferenceEventAuditStore::new();
        store.audit_append(AuditInput {
            organization_id: "tenant-1".into(),
            action: "request.received".into(),
            correlation_id: "corr-audit".into(),
            ..Default::default()
        });
        store.audit_append(AuditInput {
            organization_id: "tenant-1".into(),
            action: "request.completed".into(),
            correlation_id: "corr-audit".into(),
            ..Default::default()
        });
        assert_eq!(
            store.audit_by_correlation("tenant-1", "corr-audit").len(),
            2
        );
    }

    #[test]
    fn event_stream_assigns_monotonic_versions() {
        let store = ReferenceEventAuditStore::new();
        let first = store
            .stream_append(
                "order",
                "order-1",
                0,
                vec![ev("commerce.order.created", "corr-stream")],
            )
            .unwrap();
        let second = store
            .stream_append(
                "order",
                "order-1",
                1,
                vec![ev("commerce.order.confirmed", "corr-stream")],
            )
            .unwrap();
        assert_eq!(first[0].stream.as_ref().unwrap().version, 1);
        assert_eq!(second[0].stream.as_ref().unwrap().version, 2);
    }

    #[test]
    fn expected_version_detects_concurrent_update() {
        let store = ReferenceEventAuditStore::new();
        store
            .stream_append(
                "case",
                "case-1",
                0,
                vec![ev("work.case.created", "corr-conflict")],
            )
            .unwrap();
        let err = store
            .stream_append(
                "case",
                "case-1",
                0,
                vec![ev("work.case.closed", "corr-conflict")],
            )
            .unwrap_err();
        assert!(matches!(err, EventError::StreamVersionConflict { .. }));
    }

    #[test]
    fn stream_can_be_read_from_later_version() {
        let store = ReferenceEventAuditStore::new();
        store
            .stream_append(
                "asset",
                "asset-1",
                0,
                vec![
                    ev("asset.created", "corr-read"),
                    ev("asset.activated", "corr-read"),
                ],
            )
            .unwrap();
        let events = store.stream_read("asset", "asset-1", 2);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "asset.activated");
    }
}
