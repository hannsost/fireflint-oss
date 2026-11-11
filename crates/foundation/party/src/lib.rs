//! Foundation: Party (F1.1) — Rust port of the TypeScript reference module.
//!
//! Owns natural persons, organizations, organizational units, locations,
//! their roles, relationships, addresses, contact points, and dedup/merge
//! (see `modules/foundation/party`, Capability Map). Transport-neutral: types
//! serialize to the same JSON shape (camelCase) as the TS contract.
//!
//! This crate is isolated — it does not depend on, nor is it yet wired into,
//! the SiteGraph content core (handoff: no big-bang; map later).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cell::RefCell;

pub type Id = String;
pub type IsoDateTime = String;

// --- Errors ----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PartyError {
    #[error("party '{0}' not found")]
    PartyNotFound(String),
    #[error("identifier already exists")]
    IdentifierConflict,
    #[error("invalid relationship: {0}")]
    InvalidRelationship(String),
}

// --- Enums -----------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PartyKind {
    Person,
    Organization,
    OrganizationalUnit,
    Location,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PartyStatus {
    Active,
    Inactive,
    Merged,
    Archived,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContactType {
    Email,
    Phone,
    Mobile,
    Fax,
    Url,
    Messaging,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AddressType {
    Postal,
    Billing,
    Shipping,
    Visiting,
    Legal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlternativeNameType {
    Alias,
    Former,
    Trade,
    Localized,
}

// --- Value types -----------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PartyContext {
    pub organization_id: Id,
    pub correlation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<Id>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartyIdentifier {
    pub scheme: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issuer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_from: Option<IsoDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_until: Option<IsoDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verified: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactPoint {
    pub id: Id,
    #[serde(rename = "type")]
    pub kind: ContactType,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verified: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Address {
    pub id: Id,
    #[serde(rename = "type")]
    pub kind: AddressType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub street: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub street2: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub postal_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub city: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    pub country_code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_from: Option<IsoDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_until: Option<IsoDateTime>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlternativeName {
    pub value: String,
    #[serde(rename = "type")]
    pub kind: AlternativeNameType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_from: Option<IsoDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_until: Option<IsoDateTime>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceReference {
    pub system: String,
    pub external_id: String,
    pub imported_at: IsoDateTime,
    pub authoritative: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Party {
    pub id: Id,
    pub tenant_id: Id,
    pub kind: PartyKind,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legal_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub given_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alternative_names: Option<Vec<AlternativeName>>,
    pub status: PartyStatus,
    pub identifiers: Vec<PartyIdentifier>,
    pub contacts: Vec<ContactPoint>,
    pub addresses: Vec<Address>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<SourceReference>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged_into_id: Option<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
    pub created_at: IsoDateTime,
    pub updated_at: IsoDateTime,
}

/// Creatable fields (mirror of `Omit<Party, id|tenantId|status|createdAt|updatedAt>`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartyInput {
    pub kind: Option<PartyKind>,
    pub display_name: String,
    pub legal_name: Option<String>,
    pub given_name: Option<String>,
    pub family_name: Option<String>,
    pub alternative_names: Option<Vec<AlternativeName>>,
    #[serde(default)]
    pub identifiers: Vec<PartyIdentifier>,
    #[serde(default)]
    pub contacts: Vec<ContactPoint>,
    #[serde(default)]
    pub addresses: Vec<Address>,
    pub sources: Option<Vec<SourceReference>>,
    pub merged_into_id: Option<Id>,
    pub metadata: Option<Value>,
}

/// Updatable fields.
#[derive(Debug, Clone, Default)]
pub struct PartyPatch {
    pub display_name: Option<String>,
    pub legal_name: Option<String>,
    pub given_name: Option<String>,
    pub family_name: Option<String>,
    pub contacts: Option<Vec<ContactPoint>>,
    pub addresses: Option<Vec<Address>>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartyRole {
    pub id: Id,
    pub party_id: Id,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_id: Option<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_from: Option<IsoDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_until: Option<IsoDateTime>,
}

/// `PartyRole` without the generated `id`.
#[derive(Debug, Clone, Default)]
pub struct PartyRoleInput {
    pub party_id: Id,
    pub role: String,
    pub context_type: Option<String>,
    pub context_id: Option<Id>,
    pub valid_from: Option<IsoDateTime>,
    pub valid_until: Option<IsoDateTime>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartyRelationship {
    pub id: Id,
    pub from_party_id: Id,
    pub to_party_id: Id,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_from: Option<IsoDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_until: Option<IsoDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

/// `PartyRelationship` without the generated `id`.
#[derive(Debug, Clone, Default)]
pub struct PartyRelationshipInput {
    pub from_party_id: Id,
    pub to_party_id: Id,
    pub kind: String,
    pub valid_from: Option<IsoDateTime>,
    pub valid_until: Option<IsoDateTime>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateCandidate {
    pub party_id: Id,
    pub score: f64,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldConflict {
    pub field: String,
    pub values: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub surviving_party: Party,
    pub merged_party_ids: Vec<Id>,
    pub conflicts: Vec<FieldConflict>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentifierConflict {
    pub scheme: String,
    pub values: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePreview {
    pub surviving_party: Party,
    pub merged_party_ids: Vec<Id>,
    pub conflicts: Vec<FieldConflict>,
    pub identifier_conflicts: Vec<IdentifierConflict>,
}

// --- Ports (provider traits) -----------------------------------------------

pub trait PartyProvider {
    fn create(&self, ctx: &PartyContext, input: PartyInput) -> Result<Party, PartyError>;
    fn get(&self, ctx: &PartyContext, id: &str) -> Result<Option<Party>, PartyError>;
    fn find_by_identifier(
        &self,
        ctx: &PartyContext,
        identifier: &PartyIdentifier,
    ) -> Result<Option<Party>, PartyError>;
    fn search(&self, ctx: &PartyContext, query: &str) -> Result<Vec<Party>, PartyError>;
    fn update(&self, ctx: &PartyContext, id: &str, patch: PartyPatch) -> Result<Party, PartyError>;
    fn archive(&self, ctx: &PartyContext, id: &str) -> Result<Party, PartyError>;
    fn preferred_contact(
        &self,
        ctx: &PartyContext,
        id: &str,
        kind: ContactType,
    ) -> Result<Option<ContactPoint>, PartyError>;
}

pub trait RelationshipProvider {
    fn add_role(&self, ctx: &PartyContext, input: PartyRoleInput) -> Result<PartyRole, PartyError>;
    fn end_role(
        &self,
        ctx: &PartyContext,
        role_id: &str,
        valid_until: Option<IsoDateTime>,
    ) -> Result<PartyRole, PartyError>;
    fn roles(&self, ctx: &PartyContext, party_id: &str) -> Result<Vec<PartyRole>, PartyError>;
    fn active_roles(
        &self,
        ctx: &PartyContext,
        party_id: &str,
        at: Option<IsoDateTime>,
    ) -> Result<Vec<PartyRole>, PartyError>;
    fn relate(
        &self,
        ctx: &PartyContext,
        input: PartyRelationshipInput,
    ) -> Result<PartyRelationship, PartyError>;
    fn relationships(
        &self,
        ctx: &PartyContext,
        party_id: &str,
    ) -> Result<Vec<PartyRelationship>, PartyError>;
    fn active_relationships(
        &self,
        ctx: &PartyContext,
        party_id: &str,
        at: Option<IsoDateTime>,
    ) -> Result<Vec<PartyRelationship>, PartyError>;
    fn ancestors(
        &self,
        ctx: &PartyContext,
        party_id: &str,
        relationship_type: &str,
    ) -> Result<Vec<Party>, PartyError>;
    fn descendants(
        &self,
        ctx: &PartyContext,
        party_id: &str,
        relationship_type: &str,
    ) -> Result<Vec<Party>, PartyError>;
}

pub trait DeduplicationProvider {
    fn candidates(
        &self,
        ctx: &PartyContext,
        party: &Party,
    ) -> Result<Vec<DuplicateCandidate>, PartyError>;
    fn preview_merge(
        &self,
        ctx: &PartyContext,
        surviving_id: &str,
        merged_ids: &[Id],
    ) -> Result<MergePreview, PartyError>;
    fn merge(
        &self,
        ctx: &PartyContext,
        surviving_id: &str,
        merged_ids: &[Id],
    ) -> Result<MergeResult, PartyError>;
}

// --- In-memory reference implementation ------------------------------------

fn now() -> IsoDateTime {
    Utc::now().to_rfc3339()
}

/// True if `at` falls within [valid_from, valid_until) (open bounds allowed).
fn active_at(valid_from: Option<&str>, valid_until: Option<&str>, at: &str) -> bool {
    let parse = |s: &str| DateTime::parse_from_rfc3339(s).ok();
    let point = match parse(at) {
        Some(p) => p,
        None => return true,
    };
    let from_ok = valid_from
        .and_then(parse)
        .map(|f| f <= point)
        .unwrap_or(true);
    let until_ok = valid_until
        .and_then(parse)
        .map(|u| u > point)
        .unwrap_or(true);
    from_ok && until_ok
}

#[derive(Default)]
struct Inner {
    parties: Vec<Party>,
    roles: Vec<PartyRole>,
    relations: Vec<PartyRelationship>,
    sequence: u64,
}

impl Inner {
    fn next(&mut self, prefix: &str) -> String {
        self.sequence += 1;
        format!("{prefix}-{}", self.sequence)
    }

    fn index_of(&self, ctx: &PartyContext, id: &str) -> Result<usize, PartyError> {
        self.parties
            .iter()
            .position(|p| p.id == id && p.tenant_id == ctx.organization_id)
            .ok_or_else(|| PartyError::PartyNotFound(id.to_string()))
    }

    fn create(&mut self, ctx: &PartyContext, input: PartyInput) -> Result<Party, PartyError> {
        for ident in &input.identifiers {
            let conflict = self.parties.iter().any(|p| {
                p.tenant_id == ctx.organization_id
                    && p.status != PartyStatus::Merged
                    && p.identifiers
                        .iter()
                        .any(|i| i.scheme == ident.scheme && i.value == ident.value)
            });
            if conflict {
                return Err(PartyError::IdentifierConflict);
            }
        }
        let now = now();
        let party = Party {
            id: self.next("party"),
            tenant_id: ctx.organization_id.clone(),
            kind: input.kind.unwrap_or(PartyKind::Person),
            display_name: input.display_name,
            legal_name: input.legal_name,
            given_name: input.given_name,
            family_name: input.family_name,
            alternative_names: input.alternative_names,
            status: PartyStatus::Active,
            identifiers: input.identifiers,
            contacts: input.contacts,
            addresses: input.addresses,
            sources: input.sources,
            merged_into_id: None,
            metadata: input.metadata,
            created_at: now.clone(),
            updated_at: now,
        };
        self.parties.push(party.clone());
        Ok(party)
    }

    fn update(
        &mut self,
        ctx: &PartyContext,
        id: &str,
        patch: PartyPatch,
    ) -> Result<Party, PartyError> {
        let idx = self.index_of(ctx, id)?;
        let p = &mut self.parties[idx];
        if let Some(v) = patch.display_name {
            p.display_name = v;
        }
        if let Some(v) = patch.legal_name {
            p.legal_name = Some(v);
        }
        if let Some(v) = patch.given_name {
            p.given_name = Some(v);
        }
        if let Some(v) = patch.family_name {
            p.family_name = Some(v);
        }
        if let Some(v) = patch.contacts {
            p.contacts = v;
        }
        if let Some(v) = patch.addresses {
            p.addresses = v;
        }
        if let Some(v) = patch.metadata {
            p.metadata = Some(v);
        }
        p.updated_at = now();
        Ok(p.clone())
    }
}

#[derive(Default)]
pub struct ReferencePartyStore {
    inner: RefCell<Inner>,
}

impl ReferencePartyStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl PartyProvider for ReferencePartyStore {
    fn create(&self, ctx: &PartyContext, input: PartyInput) -> Result<Party, PartyError> {
        self.inner.borrow_mut().create(ctx, input)
    }

    fn get(&self, ctx: &PartyContext, id: &str) -> Result<Option<Party>, PartyError> {
        let inner = self.inner.borrow();
        Ok(inner
            .parties
            .iter()
            .find(|p| p.id == id && p.tenant_id == ctx.organization_id)
            .cloned())
    }

    fn find_by_identifier(
        &self,
        ctx: &PartyContext,
        identifier: &PartyIdentifier,
    ) -> Result<Option<Party>, PartyError> {
        let inner = self.inner.borrow();
        Ok(inner
            .parties
            .iter()
            .find(|p| {
                p.tenant_id == ctx.organization_id
                    && p.status != PartyStatus::Merged
                    && p.identifiers
                        .iter()
                        .any(|i| i.scheme == identifier.scheme && i.value == identifier.value)
            })
            .cloned())
    }

    fn search(&self, ctx: &PartyContext, query: &str) -> Result<Vec<Party>, PartyError> {
        let needle = query.to_lowercase();
        let inner = self.inner.borrow();
        Ok(inner
            .parties
            .iter()
            .filter(|p| p.tenant_id == ctx.organization_id && p.status != PartyStatus::Merged)
            .filter(|p| p.display_name.to_lowercase().contains(&needle))
            .cloned()
            .collect())
    }

    fn update(&self, ctx: &PartyContext, id: &str, patch: PartyPatch) -> Result<Party, PartyError> {
        self.inner.borrow_mut().update(ctx, id, patch)
    }

    fn archive(&self, ctx: &PartyContext, id: &str) -> Result<Party, PartyError> {
        let mut inner = self.inner.borrow_mut();
        let idx = inner.index_of(ctx, id)?;
        inner.parties[idx].status = PartyStatus::Archived;
        inner.parties[idx].updated_at = now();
        Ok(inner.parties[idx].clone())
    }

    fn preferred_contact(
        &self,
        ctx: &PartyContext,
        id: &str,
        kind: ContactType,
    ) -> Result<Option<ContactPoint>, PartyError> {
        let inner = self.inner.borrow();
        let idx = inner.index_of(ctx, id)?;
        let contacts: Vec<&ContactPoint> = inner.parties[idx]
            .contacts
            .iter()
            .filter(|c| c.kind == kind)
            .collect();
        let chosen = contacts
            .iter()
            .find(|c| c.primary == Some(true))
            .or_else(|| contacts.first())
            .map(|c| (*c).clone());
        Ok(chosen)
    }
}

impl RelationshipProvider for ReferencePartyStore {
    fn add_role(&self, ctx: &PartyContext, input: PartyRoleInput) -> Result<PartyRole, PartyError> {
        let mut inner = self.inner.borrow_mut();
        inner.index_of(ctx, &input.party_id)?;
        let role = PartyRole {
            id: inner.next("role"),
            party_id: input.party_id,
            role: input.role,
            context_type: input.context_type,
            context_id: input.context_id,
            valid_from: input.valid_from,
            valid_until: input.valid_until,
        };
        inner.roles.push(role.clone());
        Ok(role)
    }

    fn end_role(
        &self,
        ctx: &PartyContext,
        role_id: &str,
        valid_until: Option<IsoDateTime>,
    ) -> Result<PartyRole, PartyError> {
        let mut inner = self.inner.borrow_mut();
        let pos = inner
            .roles
            .iter()
            .position(|r| r.id == role_id)
            .ok_or_else(|| PartyError::PartyNotFound(role_id.to_string()))?;
        let party_id = inner.roles[pos].party_id.clone();
        inner.index_of(ctx, &party_id)?;
        inner.roles[pos].valid_until = Some(valid_until.unwrap_or_else(now));
        Ok(inner.roles[pos].clone())
    }

    fn roles(&self, _ctx: &PartyContext, party_id: &str) -> Result<Vec<PartyRole>, PartyError> {
        let inner = self.inner.borrow();
        Ok(inner
            .roles
            .iter()
            .filter(|r| r.party_id == party_id)
            .cloned()
            .collect())
    }

    fn active_roles(
        &self,
        _ctx: &PartyContext,
        party_id: &str,
        at: Option<IsoDateTime>,
    ) -> Result<Vec<PartyRole>, PartyError> {
        let at = at.unwrap_or_else(now);
        let inner = self.inner.borrow();
        Ok(inner
            .roles
            .iter()
            .filter(|r| r.party_id == party_id)
            .filter(|r| active_at(r.valid_from.as_deref(), r.valid_until.as_deref(), &at))
            .cloned()
            .collect())
    }

    fn relate(
        &self,
        ctx: &PartyContext,
        input: PartyRelationshipInput,
    ) -> Result<PartyRelationship, PartyError> {
        let mut inner = self.inner.borrow_mut();
        inner.index_of(ctx, &input.from_party_id)?;
        inner.index_of(ctx, &input.to_party_id)?;
        if input.from_party_id == input.to_party_id {
            return Err(PartyError::InvalidRelationship(
                "self relationship is not allowed".to_string(),
            ));
        }
        let relation = PartyRelationship {
            id: inner.next("relationship"),
            from_party_id: input.from_party_id,
            to_party_id: input.to_party_id,
            kind: input.kind,
            valid_from: input.valid_from,
            valid_until: input.valid_until,
            metadata: input.metadata,
        };
        inner.relations.push(relation.clone());
        Ok(relation)
    }

    fn relationships(
        &self,
        _ctx: &PartyContext,
        party_id: &str,
    ) -> Result<Vec<PartyRelationship>, PartyError> {
        let inner = self.inner.borrow();
        Ok(inner
            .relations
            .iter()
            .filter(|r| r.from_party_id == party_id || r.to_party_id == party_id)
            .cloned()
            .collect())
    }

    fn active_relationships(
        &self,
        _ctx: &PartyContext,
        party_id: &str,
        at: Option<IsoDateTime>,
    ) -> Result<Vec<PartyRelationship>, PartyError> {
        let at = at.unwrap_or_else(now);
        let inner = self.inner.borrow();
        Ok(inner
            .relations
            .iter()
            .filter(|r| r.from_party_id == party_id || r.to_party_id == party_id)
            .filter(|r| active_at(r.valid_from.as_deref(), r.valid_until.as_deref(), &at))
            .cloned()
            .collect())
    }

    fn ancestors(
        &self,
        ctx: &PartyContext,
        party_id: &str,
        relationship_type: &str,
    ) -> Result<Vec<Party>, PartyError> {
        self.traverse(ctx, party_id, relationship_type, Direction::Up)
    }

    fn descendants(
        &self,
        ctx: &PartyContext,
        party_id: &str,
        relationship_type: &str,
    ) -> Result<Vec<Party>, PartyError> {
        self.traverse(ctx, party_id, relationship_type, Direction::Down)
    }
}

#[derive(Clone, Copy)]
enum Direction {
    Up,
    Down,
}

impl ReferencePartyStore {
    fn traverse(
        &self,
        ctx: &PartyContext,
        party_id: &str,
        relationship_type: &str,
        direction: Direction,
    ) -> Result<Vec<Party>, PartyError> {
        let inner = self.inner.borrow();
        inner.index_of(ctx, party_id)?;
        let mut found = Vec::new();
        let mut visited = vec![party_id.to_string()];
        let mut queue = vec![party_id.to_string()];
        while let Some(current) = queue.pop() {
            let related: Vec<String> = inner
                .relations
                .iter()
                .filter(|r| {
                    r.kind == relationship_type
                        && match direction {
                            Direction::Up => r.from_party_id == current,
                            Direction::Down => r.to_party_id == current,
                        }
                })
                .map(|r| match direction {
                    Direction::Up => r.to_party_id.clone(),
                    Direction::Down => r.from_party_id.clone(),
                })
                .collect();
            for id in related {
                if visited.contains(&id) {
                    continue;
                }
                visited.push(id.clone());
                if let Some(p) = inner
                    .parties
                    .iter()
                    .find(|p| p.id == id && p.tenant_id == ctx.organization_id)
                {
                    found.push(p.clone());
                    queue.push(id);
                }
            }
        }
        Ok(found)
    }

    fn build_merge_preview(
        &self,
        ctx: &PartyContext,
        surviving_id: &str,
        merged_ids: &[Id],
    ) -> Result<MergePreview, PartyError> {
        let inner = self.inner.borrow();
        let survivor_idx = inner.index_of(ctx, surviving_id)?;
        let survivor = inner.parties[survivor_idx].clone();

        let mut parties = vec![survivor.clone()];
        for id in merged_ids {
            let idx = inner.index_of(ctx, id)?;
            parties.push(inner.parties[idx].clone());
        }

        let mut names: Vec<String> = Vec::new();
        for p in &parties {
            if !names.contains(&p.display_name) {
                names.push(p.display_name.clone());
            }
        }
        let conflicts = if names.len() > 1 {
            vec![FieldConflict {
                field: "displayName".to_string(),
                values: names.into_iter().map(Value::String).collect(),
            }]
        } else {
            Vec::new()
        };

        // Identifier conflicts grouped by scheme (preserve first-seen order).
        let mut by_scheme: Vec<(String, Vec<String>)> = Vec::new();
        for p in &parties {
            for ident in &p.identifiers {
                match by_scheme.iter_mut().find(|(s, _)| *s == ident.scheme) {
                    Some((_, values)) => {
                        if !values.contains(&ident.value) {
                            values.push(ident.value.clone());
                        }
                    }
                    None => by_scheme.push((ident.scheme.clone(), vec![ident.value.clone()])),
                }
            }
        }
        let identifier_conflicts = by_scheme
            .into_iter()
            .filter(|(_, values)| values.len() > 1)
            .map(|(scheme, values)| IdentifierConflict { scheme, values })
            .collect();

        Ok(MergePreview {
            surviving_party: survivor,
            merged_party_ids: merged_ids.to_vec(),
            conflicts,
            identifier_conflicts,
        })
    }
}

impl DeduplicationProvider for ReferencePartyStore {
    fn candidates(
        &self,
        ctx: &PartyContext,
        party: &Party,
    ) -> Result<Vec<DuplicateCandidate>, PartyError> {
        let inner = self.inner.borrow();
        Ok(inner
            .parties
            .iter()
            .filter(|c| {
                c.tenant_id == ctx.organization_id
                    && c.id != party.id
                    && c.status == PartyStatus::Active
            })
            .filter_map(|c| {
                let identifier_match = c.identifiers.iter().any(|l| {
                    party
                        .identifiers
                        .iter()
                        .any(|r| l.scheme == r.scheme && l.value == r.value)
                });
                let name_match = c.display_name.to_lowercase() == party.display_name.to_lowercase();
                let (score, reasons) = if identifier_match {
                    (1.0, vec!["identifier".to_string()])
                } else if name_match {
                    (0.7, vec!["display_name".to_string()])
                } else {
                    (0.0, Vec::new())
                };
                if score > 0.0 {
                    Some(DuplicateCandidate {
                        party_id: c.id.clone(),
                        score,
                        reasons,
                    })
                } else {
                    None
                }
            })
            .collect())
    }

    fn preview_merge(
        &self,
        ctx: &PartyContext,
        surviving_id: &str,
        merged_ids: &[Id],
    ) -> Result<MergePreview, PartyError> {
        self.build_merge_preview(ctx, surviving_id, merged_ids)
    }

    fn merge(
        &self,
        ctx: &PartyContext,
        surviving_id: &str,
        merged_ids: &[Id],
    ) -> Result<MergeResult, PartyError> {
        let preview = self.build_merge_preview(ctx, surviving_id, merged_ids)?;
        let mut inner = self.inner.borrow_mut();
        let survivor_idx = inner.index_of(ctx, surviving_id)?;

        for id in merged_ids {
            let merged_idx = inner.index_of(ctx, id)?;
            let merged_identifiers = inner.parties[merged_idx].identifiers.clone();
            for ident in merged_identifiers {
                let exists = inner.parties[survivor_idx]
                    .identifiers
                    .iter()
                    .any(|i| i.scheme == ident.scheme && i.value == ident.value);
                if !exists {
                    inner.parties[survivor_idx].identifiers.push(ident);
                }
            }
            inner.parties[merged_idx].status = PartyStatus::Merged;
            inner.parties[merged_idx].merged_into_id = Some(surviving_id.to_string());
        }
        inner.parties[survivor_idx].updated_at = now();

        Ok(MergeResult {
            surviving_party: inner.parties[survivor_idx].clone(),
            merged_party_ids: merged_ids.to_vec(),
            conflicts: preview.conflicts,
        })
    }
}

/// Reference context, mirrors `referencePartyContext()`.
pub fn reference_party_context(organization_id: &str) -> PartyContext {
    PartyContext {
        organization_id: organization_id.to_string(),
        correlation_id: "party-reference".to_string(),
        actor_id: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> PartyContext {
        reference_party_context("tenant-1")
    }

    fn input(name: &str, email: &str) -> PartyInput {
        let parts: Vec<&str> = name.split(' ').collect();
        PartyInput {
            kind: Some(PartyKind::Person),
            display_name: name.to_string(),
            given_name: parts.first().map(|s| s.to_string()),
            family_name: parts.get(1).map(|s| s.to_string()),
            identifiers: vec![PartyIdentifier {
                scheme: "email".to_string(),
                value: email.to_string(),
                issuer: None,
                valid_from: None,
                valid_until: None,
                verified: None,
            }],
            contacts: vec![ContactPoint {
                id: format!("contact-{email}"),
                kind: ContactType::Email,
                value: email.to_string(),
                label: None,
                primary: Some(true),
                verified: None,
            }],
            ..Default::default()
        }
    }

    #[test]
    fn creates_and_resolves_person_by_identifier() {
        let store = ReferencePartyStore::new();
        let party = store
            .create(&ctx(), input("Erika Beispiel", "erika@example.test"))
            .unwrap();
        let resolved = store
            .find_by_identifier(
                &ctx(),
                &PartyIdentifier {
                    scheme: "email".into(),
                    value: "erika@example.test".into(),
                    issuer: None,
                    valid_from: None,
                    valid_until: None,
                    verified: None,
                },
            )
            .unwrap();
        assert_eq!(resolved.unwrap().id, party.id);
    }

    #[test]
    fn one_party_carries_multiple_contextual_roles() {
        let store = ReferencePartyStore::new();
        let party = store
            .create(&ctx(), input("Alex Partner", "alex@example.test"))
            .unwrap();
        store
            .add_role(
                &ctx(),
                PartyRoleInput {
                    party_id: party.id.clone(),
                    role: "customer".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        store
            .add_role(
                &ctx(),
                PartyRoleInput {
                    party_id: party.id.clone(),
                    role: "supplier_contact".into(),
                    context_id: Some("supplier-1".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        let roles: Vec<String> = store
            .roles(&ctx(), &party.id)
            .unwrap()
            .into_iter()
            .map(|r| r.role)
            .collect();
        assert_eq!(roles, vec!["customer", "supplier_contact"]);
    }

    #[test]
    fn organization_hierarchy_through_relationships() {
        let store = ReferencePartyStore::new();
        let mut org_in = input("Example Org", "org@example.test");
        org_in.kind = Some(PartyKind::Organization);
        org_in.legal_name = Some("Example Org GmbH".into());
        let org = store.create(&ctx(), org_in).unwrap();
        let mut unit_in = input("Berlin Unit", "berlin@example.test");
        unit_in.kind = Some(PartyKind::OrganizationalUnit);
        let unit = store.create(&ctx(), unit_in).unwrap();
        let relation = store
            .relate(
                &ctx(),
                PartyRelationshipInput {
                    from_party_id: unit.id,
                    to_party_id: org.id,
                    kind: "unit_of".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(relation.kind, "unit_of");
    }

    #[test]
    fn merge_preserves_identifiers_and_redirects_duplicate() {
        let store = ReferencePartyStore::new();
        let survivor = store
            .create(&ctx(), input("Erika Beispiel", "erika@example.test"))
            .unwrap();
        let duplicate = store
            .create(&ctx(), input("Erika B.", "erika.alt@example.test"))
            .unwrap();
        let result = store
            .merge(&ctx(), &survivor.id, std::slice::from_ref(&duplicate.id))
            .unwrap();
        assert_eq!(result.surviving_party.identifiers.len(), 2);
        assert_eq!(
            store
                .get(&ctx(), &duplicate.id)
                .unwrap()
                .unwrap()
                .merged_into_id,
            Some(survivor.id)
        );
    }

    #[test]
    fn hierarchy_traversal_returns_transitive_ancestors() {
        let store = ReferencePartyStore::new();
        let mut g = input("Group Org", "group@example.test");
        g.kind = Some(PartyKind::Organization);
        let group = store.create(&ctx(), g).unwrap();
        let mut c = input("Company Org", "company@example.test");
        c.kind = Some(PartyKind::Organization);
        let company = store.create(&ctx(), c).unwrap();
        let mut u = input("Unit Berlin", "unit@example.test");
        u.kind = Some(PartyKind::OrganizationalUnit);
        let unit = store.create(&ctx(), u).unwrap();
        store
            .relate(
                &ctx(),
                PartyRelationshipInput {
                    from_party_id: company.id.clone(),
                    to_party_id: group.id.clone(),
                    kind: "unit_of".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        store
            .relate(
                &ctx(),
                PartyRelationshipInput {
                    from_party_id: unit.id.clone(),
                    to_party_id: company.id.clone(),
                    kind: "unit_of".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        let ancestors: Vec<String> = store
            .ancestors(&ctx(), &unit.id, "unit_of")
            .unwrap()
            .into_iter()
            .map(|p| p.id)
            .collect();
        assert_eq!(ancestors, vec![company.id, group.id]);
    }

    #[test]
    fn role_lifecycle_is_ended_not_deleted() {
        let store = ReferencePartyStore::new();
        let party = store
            .create(&ctx(), input("Alex Role", "role@example.test"))
            .unwrap();
        let role = store
            .add_role(
                &ctx(),
                PartyRoleInput {
                    party_id: party.id,
                    role: "employee".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        let ended = store
            .end_role(&ctx(), &role.id, Some("2026-12-31T23:59:59.000Z".into()))
            .unwrap();
        assert_eq!(
            ended.valid_until.as_deref(),
            Some("2026-12-31T23:59:59.000Z")
        );
    }

    #[test]
    fn merge_preview_exposes_conflicts_without_changing_parties() {
        let store = ReferencePartyStore::new();
        let survivor = store
            .create(&ctx(), input("Erika Example", "one@example.test"))
            .unwrap();
        let duplicate = store
            .create(&ctx(), input("Erika E.", "two@example.test"))
            .unwrap();
        let preview = store
            .preview_merge(&ctx(), &survivor.id, std::slice::from_ref(&duplicate.id))
            .unwrap();
        assert_eq!(preview.conflicts[0].field, "displayName");
        assert_eq!(
            store.get(&ctx(), &duplicate.id).unwrap().unwrap().status,
            PartyStatus::Active
        );
    }

    #[test]
    fn preferred_contact_favors_primary() {
        let store = ReferencePartyStore::new();
        let mut in_ = input("Contact Person", "default@example.test");
        in_.contacts = vec![
            ContactPoint {
                id: "email-1".into(),
                kind: ContactType::Email,
                value: "first@example.test".into(),
                label: None,
                primary: None,
                verified: None,
            },
            ContactPoint {
                id: "email-2".into(),
                kind: ContactType::Email,
                value: "primary@example.test".into(),
                label: None,
                primary: Some(true),
                verified: None,
            },
        ];
        let party = store.create(&ctx(), in_).unwrap();
        assert_eq!(
            store
                .preferred_contact(&ctx(), &party.id, ContactType::Email)
                .unwrap()
                .unwrap()
                .value,
            "primary@example.test"
        );
    }

    #[test]
    fn party_preserves_aliases_and_authoritative_sources() {
        let store = ReferencePartyStore::new();
        let mut in_ = input("Example Holdings", "holding@example.test");
        in_.kind = Some(PartyKind::Organization);
        in_.alternative_names = Some(vec![
            AlternativeName {
                value: "Example Group".into(),
                kind: AlternativeNameType::Trade,
                locale: Some("en".into()),
                valid_from: None,
                valid_until: None,
            },
            AlternativeName {
                value: "Beispiel Gruppe".into(),
                kind: AlternativeNameType::Localized,
                locale: Some("de".into()),
                valid_from: None,
                valid_until: None,
            },
        ]);
        in_.sources = Some(vec![SourceReference {
            system: "erp".into(),
            external_id: "ERP-100".into(),
            imported_at: "2026-06-19T12:00:00.000Z".into(),
            authoritative: true,
        }]);
        let party = store.create(&ctx(), in_).unwrap();
        assert_eq!(
            party.alternative_names.as_ref().unwrap()[1]
                .locale
                .as_deref(),
            Some("de")
        );
        assert!(party.sources.as_ref().unwrap()[0].authoritative);
    }

    #[test]
    fn roles_and_relationships_queryable_at_point_in_time() {
        let store = ReferencePartyStore::new();
        let mut c = input("Company", "company-history@example.test");
        c.kind = Some(PartyKind::Organization);
        let company = store.create(&ctx(), c).unwrap();
        let person = store
            .create(&ctx(), input("Historic Person", "historic@example.test"))
            .unwrap();
        store
            .add_role(
                &ctx(),
                PartyRoleInput {
                    party_id: person.id.clone(),
                    role: "employee".into(),
                    valid_from: Some("2025-01-01T00:00:00.000Z".into()),
                    valid_until: Some("2025-12-31T23:59:59.000Z".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        store
            .relate(
                &ctx(),
                PartyRelationshipInput {
                    from_party_id: person.id.clone(),
                    to_party_id: company.id,
                    kind: "employed_by".into(),
                    valid_from: Some("2025-01-01T00:00:00.000Z".into()),
                    valid_until: Some("2025-12-31T23:59:59.000Z".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(
            store
                .active_roles(&ctx(), &person.id, Some("2025-06-01T00:00:00.000Z".into()))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .active_relationships(&ctx(), &person.id, Some("2026-06-01T00:00:00.000Z".into()))
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn party_can_be_archived_without_deleting_identity() {
        let store = ReferencePartyStore::new();
        let party = store
            .create(&ctx(), input("Archived Party", "archived@example.test"))
            .unwrap();
        assert_eq!(
            store.archive(&ctx(), &party.id).unwrap().status,
            PartyStatus::Archived
        );
        assert_eq!(store.get(&ctx(), &party.id).unwrap().unwrap().id, party.id);
    }
}
