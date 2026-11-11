//! Foundation: Identity & Access (F1.2) — Rust port of the TS reference module.
//!
//! Owns principals, groups, roles, grants, policies, delegation and federation,
//! and the RBAC+ABAC authorization decision (see `modules/foundation/identity-access`).
//! Isolated crate: not wired into the SiteGraph core (handoff: map later).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::BTreeMap;

pub type Id = String;
pub type IsoDateTime = String;

// --- Errors ----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AccessError {
    #[error("principal '{0}' not found")]
    PrincipalNotFound(String),
    #[error("group '{0}' not found")]
    GroupNotFound(String),
    #[error("role not found: {0}")]
    RoleNotFound(String),
    #[error("policy '{0}' not found")]
    PolicyNotFound(String),
    #[error("external identity already linked")]
    ExternalIdentityConflict,
    #[error("external identity not found")]
    ExternalIdentityNotFound,
    #[error("grant '{0}' not found")]
    GrantNotFound(String),
    #[error("invalid delegation: {0}")]
    InvalidDelegation(String),
}

// --- Enums -----------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrincipalType {
    #[default]
    Human,
    Service,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrincipalStatus {
    Active,
    Disabled,
    Locked,
    Expired,
}

impl PrincipalStatus {
    fn as_str(self) -> &'static str {
        match self {
            PrincipalStatus::Active => "active",
            PrincipalStatus::Disabled => "disabled",
            PrincipalStatus::Locked => "locked",
            PrincipalStatus::Expired => "expired",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssuranceLevel {
    None,
    SingleFactor,
    Mfa,
    Hardware,
}

impl AssuranceLevel {
    fn rank(self) -> u8 {
        match self {
            AssuranceLevel::None => 0,
            AssuranceLevel::SingleFactor => 1,
            AssuranceLevel::Mfa => 2,
            AssuranceLevel::Hardware => 3,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScopeType {
    Organization,
    Channel,
    Resource,
    Domain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyEffect {
    Allow,
    Deny,
}

// --- Value types -----------------------------------------------------------

pub type Attributes = BTreeMap<String, Value>;

#[derive(Debug, Clone, Default)]
pub struct AccessContext {
    pub organization_id: Id,
    pub principal_id: Id,
    pub correlation_id: String,
    pub assurance_level: Option<AssuranceLevel>,
    pub attributes: Option<Attributes>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Principal {
    pub id: Id,
    pub organization_id: Id,
    #[serde(rename = "type")]
    pub kind: PrincipalType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub party_id: Option<Id>,
    pub display_name: String,
    pub status: PrincipalStatus,
    pub authentication_methods: Vec<String>,
    pub created_at: IsoDateTime,
}

#[derive(Debug, Clone, Default)]
pub struct PrincipalInput {
    pub kind: PrincipalType,
    pub party_id: Option<Id>,
    pub display_name: String,
    pub authentication_methods: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: Id,
    pub organization_id: Id,
    pub name: String,
    pub principal_ids: Vec<Id>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Role {
    pub id: Id,
    pub key: String,
    pub name: String,
    pub permissions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    #[serde(rename = "type")]
    pub kind: ScopeType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Id>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleGrant {
    pub id: Id,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub principal_id: Option<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<Id>,
    pub role_id: Id,
    pub scope: Scope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_from: Option<IsoDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_until: Option<IsoDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<IsoDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoked_by_principal_id: Option<Id>,
}

#[derive(Debug, Clone, Default)]
pub struct GrantInput {
    pub principal_id: Option<Id>,
    pub group_id: Option<Id>,
    pub role_id: Id,
    pub scope: Option<Scope>,
    pub valid_from: Option<IsoDateTime>,
    pub valid_until: Option<IsoDateTime>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Delegation {
    pub id: Id,
    pub from_principal_id: Id,
    pub to_principal_id: Id,
    pub permissions: Vec<String>,
    pub scope: Scope,
    pub valid_from: IsoDateTime,
    pub valid_until: IsoDateTime,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<IsoDateTime>,
}

#[derive(Debug, Clone, Default)]
pub struct DelegationInput {
    pub from_principal_id: Id,
    pub to_principal_id: Id,
    pub permissions: Vec<String>,
    pub scope: Option<Scope>,
    pub valid_from: IsoDateTime,
    pub valid_until: IsoDateTime,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalIdentity {
    pub id: Id,
    pub organization_id: Id,
    pub principal_id: Id,
    pub provider: String,
    pub issuer: String,
    pub subject: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    pub linked_at: IsoDateTime,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_authenticated_at: Option<IsoDateTime>,
}

#[derive(Debug, Clone, Default)]
pub struct ExternalIdentityInput {
    pub principal_id: Id,
    pub provider: String,
    pub issuer: String,
    pub subject: String,
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Obligation {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct ResourceRef {
    pub kind: String,
    pub id: Option<Id>,
    pub organization_id: Id,
    pub attributes: Option<Attributes>,
}

#[derive(Debug, Clone)]
pub struct AccessRequest {
    pub permission: String,
    pub resource: ResourceRef,
    pub required_assurance: Option<AssuranceLevel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessDecision {
    pub allowed: bool,
    pub reason: String,
    pub matched_grant_ids: Vec<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub obligations: Option<Vec<Obligation>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyRule {
    pub id: Id,
    pub organization_id: Id,
    pub effect: PolicyEffect,
    pub permissions: Vec<String>,
    pub principal_ids: Option<Vec<Id>>,
    pub group_ids: Option<Vec<Id>>,
    pub resource_types: Option<Vec<String>>,
    pub conditions: Option<Attributes>,
    pub obligations: Option<Vec<Obligation>>,
    pub priority: i64,
    pub enabled: bool,
}

#[derive(Debug, Clone, Default)]
pub struct PolicyInput {
    pub effect: Option<PolicyEffect>,
    pub permissions: Vec<String>,
    pub principal_ids: Option<Vec<Id>>,
    pub group_ids: Option<Vec<Id>>,
    pub resource_types: Option<Vec<String>>,
    pub conditions: Option<Attributes>,
    pub obligations: Option<Vec<Obligation>>,
    pub priority: i64,
    pub enabled: bool,
}

#[derive(Debug, Clone, Default)]
pub struct RoleInput {
    pub key: String,
    pub name: String,
    pub permissions: Vec<String>,
}

// --- Ports (provider traits) -----------------------------------------------

pub trait PrincipalProvider {
    fn create_principal(
        &self,
        ctx: &AccessContext,
        input: PrincipalInput,
    ) -> Result<Principal, AccessError>;
    fn get_principal(
        &self,
        ctx: &AccessContext,
        id: &str,
    ) -> Result<Option<Principal>, AccessError>;
    fn disable_principal(&self, ctx: &AccessContext, id: &str) -> Result<Principal, AccessError>;
}

pub trait GroupProvider {
    fn create_group(&self, ctx: &AccessContext, name: &str) -> Result<Group, AccessError>;
    fn add_member(
        &self,
        ctx: &AccessContext,
        group_id: &str,
        principal_id: &str,
    ) -> Result<Group, AccessError>;
    fn remove_member(
        &self,
        ctx: &AccessContext,
        group_id: &str,
        principal_id: &str,
    ) -> Result<Group, AccessError>;
    fn groups_for(
        &self,
        ctx: &AccessContext,
        principal_id: &str,
    ) -> Result<Vec<Group>, AccessError>;
}

pub trait RoleProvider {
    fn register_role(&self, ctx: &AccessContext, input: RoleInput) -> Result<Role, AccessError>;
    fn get_role(&self, ctx: &AccessContext, role_id: &str) -> Result<Option<Role>, AccessError>;
    fn list_roles(&self, ctx: &AccessContext) -> Result<Vec<Role>, AccessError>;
    fn update_role_permissions(
        &self,
        ctx: &AccessContext,
        role_id: &str,
        permissions: Vec<String>,
    ) -> Result<Role, AccessError>;
}

pub trait GrantProvider {
    fn grant(&self, ctx: &AccessContext, input: GrantInput) -> Result<RoleGrant, AccessError>;
    fn revoke_grant(&self, ctx: &AccessContext, grant_id: &str) -> Result<RoleGrant, AccessError>;
    fn grants_for(
        &self,
        ctx: &AccessContext,
        principal_id: &str,
    ) -> Result<Vec<RoleGrant>, AccessError>;
    fn delegate(
        &self,
        ctx: &AccessContext,
        input: DelegationInput,
    ) -> Result<Delegation, AccessError>;
    fn revoke_delegation(
        &self,
        ctx: &AccessContext,
        delegation_id: &str,
    ) -> Result<Delegation, AccessError>;
}

pub trait FederationProvider {
    fn link_identity(
        &self,
        ctx: &AccessContext,
        input: ExternalIdentityInput,
    ) -> Result<ExternalIdentity, AccessError>;
    fn resolve_identity(
        &self,
        organization_id: &str,
        provider: &str,
        issuer: &str,
        subject: &str,
    ) -> Result<Option<Principal>, AccessError>;
    fn unlink_identity(
        &self,
        ctx: &AccessContext,
        external_identity_id: &str,
    ) -> Result<(), AccessError>;
}

pub trait PolicyProvider {
    fn add_policy(
        &self,
        ctx: &AccessContext,
        input: PolicyInput,
    ) -> Result<PolicyRule, AccessError>;
    fn list_policies(&self, ctx: &AccessContext) -> Result<Vec<PolicyRule>, AccessError>;
    fn disable_policy(
        &self,
        ctx: &AccessContext,
        policy_id: &str,
    ) -> Result<PolicyRule, AccessError>;
}

pub trait AuthorizationProvider {
    fn decide(
        &self,
        ctx: &AccessContext,
        request: &AccessRequest,
    ) -> Result<AccessDecision, AccessError>;
    fn effective_permissions(
        &self,
        ctx: &AccessContext,
        resource: Option<&ResourceRef>,
    ) -> Result<Vec<String>, AccessError>;
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

fn permission_matches(pattern: &str, requested: &str) -> bool {
    pattern == "*"
        || pattern == requested
        || (pattern.ends_with(".*") && requested.starts_with(&pattern[..pattern.len() - 1]))
}

fn scope_matches(scope: &Scope, request: &AccessRequest) -> bool {
    scope.kind == ScopeType::Organization || scope.id.is_none() || scope.id == request.resource.id
}

// --- In-memory reference implementation ------------------------------------

#[derive(Default)]
struct Inner {
    principals: Vec<Principal>,
    groups: Vec<Group>,
    roles: Vec<Role>,
    grants: Vec<RoleGrant>,
    delegations: Vec<Delegation>,
    policies: Vec<PolicyRule>,
    external_identities: Vec<ExternalIdentity>,
    sequence: u64,
}

impl Inner {
    fn next(&mut self, prefix: &str) -> String {
        self.sequence += 1;
        format!("{prefix}-{}", self.sequence)
    }

    fn require_principal(&self, org: &str, id: &str) -> Result<Principal, AccessError> {
        self.principals
            .iter()
            .find(|p| p.id == id && p.organization_id == org)
            .cloned()
            .ok_or_else(|| AccessError::PrincipalNotFound(id.to_string()))
    }

    fn role(&self, id: &str) -> Option<&Role> {
        self.roles.iter().find(|r| r.id == id)
    }

    fn group_ids_for(&self, org: &str, principal_id: &str) -> Vec<Id> {
        self.groups
            .iter()
            .filter(|g| {
                g.organization_id == org && g.principal_ids.iter().any(|p| p == principal_id)
            })
            .map(|g| g.id.clone())
            .collect()
    }
}

pub struct ReferenceAccessStore {
    inner: RefCell<Inner>,
}

impl Default for ReferenceAccessStore {
    fn default() -> Self {
        let mut inner = Inner::default();
        for (id, key, name, perms) in [
            ("role-viewer", "viewer", "Viewer", vec!["*.read"]),
            (
                "role-editor",
                "editor",
                "Editor",
                vec!["*.read", "content.write", "work.manage"],
            ),
            ("role-owner", "owner", "Owner", vec!["*"]),
        ] {
            inner.roles.push(Role {
                id: id.to_string(),
                key: key.to_string(),
                name: name.to_string(),
                permissions: perms.into_iter().map(String::from).collect(),
            });
        }
        Self {
            inner: RefCell::new(inner),
        }
    }
}

impl ReferenceAccessStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn conditions_match(
        conditions: &Option<Attributes>,
        ctx: &AccessContext,
        request: &AccessRequest,
    ) -> bool {
        let Some(conditions) = conditions else {
            return true;
        };
        for (key, expected) in conditions {
            let actual = ctx
                .attributes
                .as_ref()
                .and_then(|a| a.get(key))
                .or_else(|| {
                    request
                        .resource
                        .attributes
                        .as_ref()
                        .and_then(|a| a.get(key))
                });
            if actual != Some(expected) {
                return false;
            }
        }
        true
    }
}

impl PrincipalProvider for ReferenceAccessStore {
    fn create_principal(
        &self,
        ctx: &AccessContext,
        input: PrincipalInput,
    ) -> Result<Principal, AccessError> {
        let mut inner = self.inner.borrow_mut();
        let principal = Principal {
            id: inner.next("principal"),
            organization_id: ctx.organization_id.clone(),
            kind: input.kind,
            party_id: input.party_id,
            display_name: input.display_name,
            status: PrincipalStatus::Active,
            authentication_methods: input.authentication_methods,
            created_at: now(),
        };
        inner.principals.push(principal.clone());
        Ok(principal)
    }

    fn get_principal(
        &self,
        ctx: &AccessContext,
        id: &str,
    ) -> Result<Option<Principal>, AccessError> {
        let inner = self.inner.borrow();
        Ok(inner
            .principals
            .iter()
            .find(|p| p.id == id && p.organization_id == ctx.organization_id)
            .cloned())
    }

    fn disable_principal(&self, ctx: &AccessContext, id: &str) -> Result<Principal, AccessError> {
        let mut inner = self.inner.borrow_mut();
        let pos = inner
            .principals
            .iter()
            .position(|p| p.id == id && p.organization_id == ctx.organization_id)
            .ok_or_else(|| AccessError::PrincipalNotFound(id.to_string()))?;
        inner.principals[pos].status = PrincipalStatus::Disabled;
        Ok(inner.principals[pos].clone())
    }
}

impl GroupProvider for ReferenceAccessStore {
    fn create_group(&self, ctx: &AccessContext, name: &str) -> Result<Group, AccessError> {
        let mut inner = self.inner.borrow_mut();
        let group = Group {
            id: inner.next("group"),
            organization_id: ctx.organization_id.clone(),
            name: name.to_string(),
            principal_ids: Vec::new(),
        };
        inner.groups.push(group.clone());
        Ok(group)
    }

    fn add_member(
        &self,
        ctx: &AccessContext,
        group_id: &str,
        principal_id: &str,
    ) -> Result<Group, AccessError> {
        let mut inner = self.inner.borrow_mut();
        inner.require_principal(&ctx.organization_id, principal_id)?;
        let pos = inner
            .groups
            .iter()
            .position(|g| g.id == group_id && g.organization_id == ctx.organization_id)
            .ok_or_else(|| AccessError::GroupNotFound(group_id.to_string()))?;
        if !inner.groups[pos]
            .principal_ids
            .iter()
            .any(|p| p == principal_id)
        {
            inner.groups[pos]
                .principal_ids
                .push(principal_id.to_string());
        }
        Ok(inner.groups[pos].clone())
    }

    fn remove_member(
        &self,
        ctx: &AccessContext,
        group_id: &str,
        principal_id: &str,
    ) -> Result<Group, AccessError> {
        let mut inner = self.inner.borrow_mut();
        let pos = inner
            .groups
            .iter()
            .position(|g| g.id == group_id && g.organization_id == ctx.organization_id)
            .ok_or_else(|| AccessError::GroupNotFound(group_id.to_string()))?;
        inner.groups[pos]
            .principal_ids
            .retain(|p| p != principal_id);
        Ok(inner.groups[pos].clone())
    }

    fn groups_for(
        &self,
        ctx: &AccessContext,
        principal_id: &str,
    ) -> Result<Vec<Group>, AccessError> {
        let inner = self.inner.borrow();
        inner.require_principal(&ctx.organization_id, principal_id)?;
        Ok(inner
            .groups
            .iter()
            .filter(|g| {
                g.organization_id == ctx.organization_id
                    && g.principal_ids.iter().any(|p| p == principal_id)
            })
            .cloned()
            .collect())
    }
}

impl RoleProvider for ReferenceAccessStore {
    fn register_role(&self, _ctx: &AccessContext, input: RoleInput) -> Result<Role, AccessError> {
        let mut inner = self.inner.borrow_mut();
        if inner.roles.iter().any(|r| r.key == input.key) {
            return Err(AccessError::RoleNotFound(format!(
                "role key '{}' already exists",
                input.key
            )));
        }
        let role = Role {
            id: inner.next("role"),
            key: input.key,
            name: input.name,
            permissions: input.permissions,
        };
        inner.roles.push(role.clone());
        Ok(role)
    }

    fn get_role(&self, _ctx: &AccessContext, role_id: &str) -> Result<Option<Role>, AccessError> {
        Ok(self.inner.borrow().role(role_id).cloned())
    }

    fn list_roles(&self, _ctx: &AccessContext) -> Result<Vec<Role>, AccessError> {
        Ok(self.inner.borrow().roles.clone())
    }

    fn update_role_permissions(
        &self,
        _ctx: &AccessContext,
        role_id: &str,
        permissions: Vec<String>,
    ) -> Result<Role, AccessError> {
        let mut inner = self.inner.borrow_mut();
        let pos = inner
            .roles
            .iter()
            .position(|r| r.id == role_id)
            .ok_or_else(|| AccessError::RoleNotFound(role_id.to_string()))?;
        let mut dedup: Vec<String> = Vec::new();
        for p in permissions {
            if !dedup.contains(&p) {
                dedup.push(p);
            }
        }
        inner.roles[pos].permissions = dedup;
        Ok(inner.roles[pos].clone())
    }
}

impl GrantProvider for ReferenceAccessStore {
    fn grant(&self, ctx: &AccessContext, input: GrantInput) -> Result<RoleGrant, AccessError> {
        let mut inner = self.inner.borrow_mut();
        let principal = input
            .principal_id
            .clone()
            .unwrap_or_else(|| ctx.principal_id.clone());
        inner.require_principal(&ctx.organization_id, &principal)?;
        if inner.role(&input.role_id).is_none() {
            return Err(AccessError::RoleNotFound(input.role_id.clone()));
        }
        let grant = RoleGrant {
            id: inner.next("grant"),
            principal_id: input.principal_id,
            group_id: input.group_id,
            role_id: input.role_id,
            scope: input.scope.unwrap_or(Scope {
                kind: ScopeType::Organization,
                id: None,
            }),
            valid_from: input.valid_from,
            valid_until: input.valid_until,
            revoked_at: None,
            revoked_by_principal_id: None,
        };
        inner.grants.push(grant.clone());
        Ok(grant)
    }

    fn revoke_grant(&self, ctx: &AccessContext, grant_id: &str) -> Result<RoleGrant, AccessError> {
        let mut inner = self.inner.borrow_mut();
        let pos = inner
            .grants
            .iter()
            .position(|g| g.id == grant_id)
            .ok_or_else(|| AccessError::GrantNotFound(grant_id.to_string()))?;
        inner.grants[pos].revoked_at = Some(now());
        inner.grants[pos].revoked_by_principal_id = Some(ctx.principal_id.clone());
        Ok(inner.grants[pos].clone())
    }

    fn grants_for(
        &self,
        _ctx: &AccessContext,
        principal_id: &str,
    ) -> Result<Vec<RoleGrant>, AccessError> {
        let inner = self.inner.borrow();
        Ok(inner
            .grants
            .iter()
            .filter(|g| g.principal_id.as_deref() == Some(principal_id) && g.revoked_at.is_none())
            .cloned()
            .collect())
    }

    fn delegate(
        &self,
        ctx: &AccessContext,
        input: DelegationInput,
    ) -> Result<Delegation, AccessError> {
        let mut inner = self.inner.borrow_mut();
        inner.require_principal(&ctx.organization_id, &input.from_principal_id)?;
        inner.require_principal(&ctx.organization_id, &input.to_principal_id)?;
        if let (Some(until), Some(from)) = (parse(&input.valid_until), parse(&input.valid_from)) {
            if until <= from {
                return Err(AccessError::InvalidDelegation(
                    "end must be after start".to_string(),
                ));
            }
        }
        let delegation = Delegation {
            id: inner.next("delegation"),
            from_principal_id: input.from_principal_id,
            to_principal_id: input.to_principal_id,
            permissions: input.permissions,
            scope: input.scope.unwrap_or(Scope {
                kind: ScopeType::Organization,
                id: None,
            }),
            valid_from: input.valid_from,
            valid_until: input.valid_until,
            reason: input.reason,
            revoked_at: None,
        };
        inner.delegations.push(delegation.clone());
        Ok(delegation)
    }

    fn revoke_delegation(
        &self,
        _ctx: &AccessContext,
        delegation_id: &str,
    ) -> Result<Delegation, AccessError> {
        let mut inner = self.inner.borrow_mut();
        let pos = inner
            .delegations
            .iter()
            .position(|d| d.id == delegation_id)
            .ok_or_else(|| AccessError::InvalidDelegation("delegation not found".to_string()))?;
        inner.delegations[pos].revoked_at = Some(now());
        Ok(inner.delegations[pos].clone())
    }
}

impl FederationProvider for ReferenceAccessStore {
    fn link_identity(
        &self,
        ctx: &AccessContext,
        input: ExternalIdentityInput,
    ) -> Result<ExternalIdentity, AccessError> {
        let mut inner = self.inner.borrow_mut();
        inner.require_principal(&ctx.organization_id, &input.principal_id)?;
        let conflict = inner.external_identities.iter().any(|i| {
            i.organization_id == ctx.organization_id
                && i.provider == input.provider
                && i.issuer == input.issuer
                && i.subject == input.subject
        });
        if conflict {
            return Err(AccessError::ExternalIdentityConflict);
        }
        let identity = ExternalIdentity {
            id: inner.next("external-identity"),
            organization_id: ctx.organization_id.clone(),
            principal_id: input.principal_id,
            provider: input.provider,
            issuer: input.issuer,
            subject: input.subject,
            email: input.email,
            linked_at: now(),
            last_authenticated_at: None,
        };
        inner.external_identities.push(identity.clone());
        Ok(identity)
    }

    fn resolve_identity(
        &self,
        organization_id: &str,
        provider: &str,
        issuer: &str,
        subject: &str,
    ) -> Result<Option<Principal>, AccessError> {
        let inner = self.inner.borrow();
        let identity = inner.external_identities.iter().find(|i| {
            i.organization_id == organization_id
                && i.provider == provider
                && i.issuer == issuer
                && i.subject == subject
        });
        let Some(identity) = identity else {
            return Ok(None);
        };
        Ok(inner
            .principals
            .iter()
            .find(|p| p.id == identity.principal_id)
            .cloned())
    }

    fn unlink_identity(
        &self,
        ctx: &AccessContext,
        external_identity_id: &str,
    ) -> Result<(), AccessError> {
        let mut inner = self.inner.borrow_mut();
        let pos = inner
            .external_identities
            .iter()
            .position(|i| i.id == external_identity_id && i.organization_id == ctx.organization_id)
            .ok_or(AccessError::ExternalIdentityNotFound)?;
        inner.external_identities.remove(pos);
        Ok(())
    }
}

impl PolicyProvider for ReferenceAccessStore {
    fn add_policy(
        &self,
        ctx: &AccessContext,
        input: PolicyInput,
    ) -> Result<PolicyRule, AccessError> {
        let mut inner = self.inner.borrow_mut();
        let policy = PolicyRule {
            id: inner.next("policy"),
            organization_id: ctx.organization_id.clone(),
            effect: input.effect.unwrap_or(PolicyEffect::Allow),
            permissions: input.permissions,
            principal_ids: input.principal_ids,
            group_ids: input.group_ids,
            resource_types: input.resource_types,
            conditions: input.conditions,
            obligations: input.obligations,
            priority: input.priority,
            enabled: input.enabled,
        };
        inner.policies.push(policy.clone());
        Ok(policy)
    }

    fn list_policies(&self, ctx: &AccessContext) -> Result<Vec<PolicyRule>, AccessError> {
        let inner = self.inner.borrow();
        Ok(inner
            .policies
            .iter()
            .filter(|p| p.organization_id == ctx.organization_id)
            .cloned()
            .collect())
    }

    fn disable_policy(
        &self,
        ctx: &AccessContext,
        policy_id: &str,
    ) -> Result<PolicyRule, AccessError> {
        let mut inner = self.inner.borrow_mut();
        let pos = inner
            .policies
            .iter()
            .position(|p| p.id == policy_id && p.organization_id == ctx.organization_id)
            .ok_or_else(|| AccessError::PolicyNotFound(policy_id.to_string()))?;
        inner.policies[pos].enabled = false;
        Ok(inner.policies[pos].clone())
    }
}

impl AuthorizationProvider for ReferenceAccessStore {
    fn decide(
        &self,
        ctx: &AccessContext,
        request: &AccessRequest,
    ) -> Result<AccessDecision, AccessError> {
        let inner = self.inner.borrow();
        let principal = inner.require_principal(&ctx.organization_id, &ctx.principal_id)?;
        if principal.status != PrincipalStatus::Active {
            return Ok(AccessDecision {
                allowed: false,
                reason: format!("Principal is {}", principal.status.as_str()),
                matched_grant_ids: vec![],
                obligations: None,
            });
        }
        if request.resource.organization_id != ctx.organization_id {
            return Ok(AccessDecision {
                allowed: false,
                reason: "Cross-organization access denied".to_string(),
                matched_grant_ids: vec![],
                obligations: None,
            });
        }
        if let Some(required) = request.required_assurance {
            let have = ctx.assurance_level.unwrap_or(AssuranceLevel::None);
            if have.rank() < required.rank() {
                return Ok(AccessDecision {
                    allowed: false,
                    reason: "Authentication assurance is insufficient".to_string(),
                    matched_grant_ids: vec![],
                    obligations: Some(vec![Obligation {
                        kind: "step_up_authentication".to_string(),
                        value: Some(serde_json::to_value(required).unwrap_or(Value::Null)),
                    }]),
                });
            }
        }

        let now_dt = Utc::now();
        let group_ids = inner.group_ids_for(&ctx.organization_id, &principal.id);

        let active = |from: &Option<String>, until: &Option<String>| -> bool {
            from.as_deref()
                .and_then(parse)
                .map(|f| f <= now_dt)
                .unwrap_or(true)
                && until
                    .as_deref()
                    .and_then(parse)
                    .map(|u| u > now_dt)
                    .unwrap_or(true)
        };

        let direct: Vec<&RoleGrant> = inner
            .grants
            .iter()
            .filter(|g| {
                (g.principal_id.as_deref() == Some(principal.id.as_str())
                    || g.group_id
                        .as_ref()
                        .map(|gid| group_ids.contains(gid))
                        .unwrap_or(false))
                    && g.revoked_at.is_none()
                    && active(&g.valid_from, &g.valid_until)
                    && scope_matches(&g.scope, request)
            })
            .filter(|g| {
                inner
                    .role(&g.role_id)
                    .map(|r| {
                        r.permissions
                            .iter()
                            .any(|p| permission_matches(p, &request.permission))
                    })
                    .unwrap_or(false)
            })
            .collect();

        let delegated: Vec<&Delegation> = inner
            .delegations
            .iter()
            .filter(|d| {
                d.to_principal_id == principal.id
                    && d.revoked_at.is_none()
                    && parse(&d.valid_from).map(|f| f <= now_dt).unwrap_or(false)
                    && parse(&d.valid_until).map(|u| u > now_dt).unwrap_or(false)
                    && scope_matches(&d.scope, request)
                    && d.permissions
                        .iter()
                        .any(|p| permission_matches(p, &request.permission))
            })
            .collect();

        let mut matching_policies: Vec<&PolicyRule> = inner
            .policies
            .iter()
            .filter(|p| p.organization_id == ctx.organization_id && p.enabled)
            .filter(|p| {
                p.permissions
                    .iter()
                    .any(|perm| permission_matches(perm, &request.permission))
            })
            .filter(|p| {
                p.principal_ids
                    .as_ref()
                    .map(|ids| ids.contains(&principal.id))
                    .unwrap_or(true)
            })
            .filter(|p| {
                p.group_ids
                    .as_ref()
                    .map(|ids| ids.iter().any(|id| group_ids.contains(id)))
                    .unwrap_or(true)
            })
            .filter(|p| {
                p.resource_types
                    .as_ref()
                    .map(|t| t.contains(&request.resource.kind))
                    .unwrap_or(true)
            })
            .filter(|p| Self::conditions_match(&p.conditions, ctx, request))
            .collect();
        matching_policies.sort_by_key(|a| std::cmp::Reverse(a.priority));

        if let Some(deny) = matching_policies
            .iter()
            .find(|p| p.effect == PolicyEffect::Deny)
        {
            return Ok(AccessDecision {
                allowed: false,
                reason: format!("Denied by policy '{}'", deny.id),
                matched_grant_ids: vec![deny.id.clone()],
                obligations: deny.obligations.clone(),
            });
        }

        let allow_policies: Vec<&PolicyRule> = matching_policies
            .iter()
            .filter(|p| p.effect == PolicyEffect::Allow)
            .copied()
            .collect();
        let allowed = !direct.is_empty() || !delegated.is_empty() || !allow_policies.is_empty();

        let mut matched: Vec<Id> = Vec::new();
        matched.extend(direct.iter().map(|g| g.id.clone()));
        matched.extend(delegated.iter().map(|d| d.id.clone()));
        matched.extend(allow_policies.iter().map(|p| p.id.clone()));

        let obligations: Vec<Obligation> = allow_policies
            .iter()
            .flat_map(|p| p.obligations.clone().unwrap_or_default())
            .collect();

        Ok(AccessDecision {
            allowed,
            reason: if allowed {
                "Matching grant, delegation or allow policy".to_string()
            } else {
                "No matching grant".to_string()
            },
            matched_grant_ids: matched,
            obligations: if obligations.is_empty() {
                None
            } else {
                Some(obligations)
            },
        })
    }

    fn effective_permissions(
        &self,
        ctx: &AccessContext,
        resource: Option<&ResourceRef>,
    ) -> Result<Vec<String>, AccessError> {
        let inner = self.inner.borrow();
        let principal = inner.require_principal(&ctx.organization_id, &ctx.principal_id)?;
        let now_dt = Utc::now();
        let group_ids = inner.group_ids_for(&ctx.organization_id, &principal.id);
        let mut permissions: Vec<String> = Vec::new();
        let add = |p: &str, acc: &mut Vec<String>| {
            if !acc.iter().any(|x| x == p) {
                acc.push(p.to_string());
            }
        };

        for grant in &inner.grants {
            if grant.revoked_at.is_some() {
                continue;
            }
            if grant.principal_id.as_deref() != Some(principal.id.as_str())
                && !grant
                    .group_id
                    .as_ref()
                    .map(|g| group_ids.contains(g))
                    .unwrap_or(false)
            {
                continue;
            }
            if grant
                .valid_from
                .as_deref()
                .and_then(parse)
                .map(|f| f > now_dt)
                .unwrap_or(false)
            {
                continue;
            }
            if grant
                .valid_until
                .as_deref()
                .and_then(parse)
                .map(|u| u <= now_dt)
                .unwrap_or(false)
            {
                continue;
            }
            if let Some(res) = resource {
                let req = AccessRequest {
                    permission: String::new(),
                    resource: res.clone(),
                    required_assurance: None,
                };
                if !scope_matches(&grant.scope, &req) {
                    continue;
                }
            }
            if let Some(role) = inner.role(&grant.role_id) {
                for p in &role.permissions {
                    add(p, &mut permissions);
                }
            }
        }

        for d in &inner.delegations {
            if d.to_principal_id == principal.id
                && d.revoked_at.is_none()
                && parse(&d.valid_from).map(|f| f <= now_dt).unwrap_or(false)
                && parse(&d.valid_until).map(|u| u > now_dt).unwrap_or(false)
            {
                for p in &d.permissions {
                    add(p, &mut permissions);
                }
            }
        }

        permissions.sort();
        Ok(permissions)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn admin_ctx() -> AccessContext {
        AccessContext {
            organization_id: "tenant-1".to_string(),
            principal_id: String::new(),
            correlation_id: "test".to_string(),
            ..Default::default()
        }
    }

    fn setup(kind: PrincipalType) -> (ReferenceAccessStore, Principal, AccessContext) {
        let store = ReferenceAccessStore::new();
        let principal = store
            .create_principal(
                &admin_ctx(),
                PrincipalInput {
                    kind,
                    party_id: if kind == PrincipalType::Human {
                        Some("party-1".into())
                    } else {
                        None
                    },
                    display_name: "Actor".into(),
                    authentication_methods: vec!["oidc".into()],
                },
            )
            .unwrap();
        let ctx = AccessContext {
            organization_id: "tenant-1".into(),
            principal_id: principal.id.clone(),
            correlation_id: "test".into(),
            ..Default::default()
        };
        (store, principal, ctx)
    }

    fn org_scope() -> Scope {
        Scope {
            kind: ScopeType::Organization,
            id: None,
        }
    }

    fn resource(kind: &str, org: &str) -> ResourceRef {
        ResourceRef {
            kind: kind.into(),
            id: None,
            organization_id: org.into(),
            attributes: None,
        }
    }

    #[test]
    fn principal_links_to_party_without_owning_party_data() {
        let (_s, principal, _c) = setup(PrincipalType::Human);
        assert_eq!(principal.party_id.as_deref(), Some("party-1"));
    }

    #[test]
    fn role_grant_authorizes_matching_permission() {
        let (store, principal, ctx) = setup(PrincipalType::Human);
        store
            .grant(
                &ctx,
                GrantInput {
                    principal_id: Some(principal.id),
                    role_id: "role-editor".into(),
                    scope: Some(org_scope()),
                    ..Default::default()
                },
            )
            .unwrap();
        let d = store
            .decide(
                &ctx,
                &AccessRequest {
                    permission: "content.write".into(),
                    resource: resource("content", "tenant-1"),
                    required_assurance: None,
                },
            )
            .unwrap();
        assert!(d.allowed);
    }

    #[test]
    fn cross_organization_access_is_denied() {
        let (store, principal, ctx) = setup(PrincipalType::Human);
        store
            .grant(
                &ctx,
                GrantInput {
                    principal_id: Some(principal.id),
                    role_id: "role-owner".into(),
                    scope: Some(org_scope()),
                    ..Default::default()
                },
            )
            .unwrap();
        let d = store
            .decide(
                &ctx,
                &AccessRequest {
                    permission: "anything".into(),
                    resource: resource("record", "tenant-2"),
                    required_assurance: None,
                },
            )
            .unwrap();
        assert!(!d.allowed);
    }

    #[test]
    fn temporary_delegation_grants_and_revokes() {
        let (store, principal, ctx) = setup(PrincipalType::Human);
        let delegate = store
            .create_principal(
                &admin_ctx(),
                PrincipalInput {
                    kind: PrincipalType::Human,
                    party_id: Some("party-2".into()),
                    display_name: "Delegate".into(),
                    authentication_methods: vec!["oidc".into()],
                },
            )
            .unwrap();
        let delegation = store
            .delegate(
                &ctx,
                DelegationInput {
                    from_principal_id: principal.id.clone(),
                    to_principal_id: delegate.id.clone(),
                    permissions: vec!["work.manage".into()],
                    scope: Some(org_scope()),
                    valid_from: (Utc::now() - Duration::seconds(1)).to_rfc3339(),
                    valid_until: (Utc::now() + Duration::seconds(60)).to_rfc3339(),
                    reason: None,
                },
            )
            .unwrap();
        let dctx = AccessContext {
            principal_id: delegate.id.clone(),
            ..ctx.clone()
        };
        assert!(
            store
                .decide(
                    &dctx,
                    &AccessRequest {
                        permission: "work.manage".into(),
                        resource: resource("task", "tenant-1"),
                        required_assurance: None
                    }
                )
                .unwrap()
                .allowed
        );
        store.revoke_delegation(&ctx, &delegation.id).unwrap();
        assert!(
            !store
                .decide(
                    &dctx,
                    &AccessRequest {
                        permission: "work.manage".into(),
                        resource: resource("task", "tenant-1"),
                        required_assurance: None
                    }
                )
                .unwrap()
                .allowed
        );
    }

    #[test]
    fn group_grant_authorizes_members() {
        let (store, principal, ctx) = setup(PrincipalType::Human);
        let group = store.create_group(&ctx, "Privacy Reviewers").unwrap();
        store.add_member(&ctx, &group.id, &principal.id).unwrap();
        store
            .grant(
                &ctx,
                GrantInput {
                    group_id: Some(group.id),
                    role_id: "role-editor".into(),
                    scope: Some(org_scope()),
                    ..Default::default()
                },
            )
            .unwrap();
        let d = store
            .decide(
                &ctx,
                &AccessRequest {
                    permission: "work.manage".into(),
                    resource: resource("privacy_request", "tenant-1"),
                    required_assurance: None,
                },
            )
            .unwrap();
        assert!(d.allowed);
    }

    #[test]
    fn explicit_deny_policy_overrides_owner_grant() {
        let (store, principal, ctx) = setup(PrincipalType::Human);
        store
            .grant(
                &ctx,
                GrantInput {
                    principal_id: Some(principal.id.clone()),
                    role_id: "role-owner".into(),
                    scope: Some(org_scope()),
                    ..Default::default()
                },
            )
            .unwrap();
        store
            .add_policy(
                &ctx,
                PolicyInput {
                    effect: Some(PolicyEffect::Deny),
                    permissions: vec!["asset.delete".into()],
                    principal_ids: Some(vec![principal.id]),
                    resource_types: Some(vec!["legal_hold_asset".into()]),
                    priority: 100,
                    enabled: true,
                    obligations: Some(vec![Obligation {
                        kind: "contact_privacy_officer".into(),
                        value: None,
                    }]),
                    ..Default::default()
                },
            )
            .unwrap();
        let d = store
            .decide(
                &ctx,
                &AccessRequest {
                    permission: "asset.delete".into(),
                    resource: resource("legal_hold_asset", "tenant-1"),
                    required_assurance: None,
                },
            )
            .unwrap();
        assert!(!d.allowed);
        assert_eq!(d.obligations.unwrap()[0].kind, "contact_privacy_officer");
    }

    #[test]
    fn sensitive_operation_requests_step_up() {
        let (store, principal, ctx) = setup(PrincipalType::Human);
        store
            .grant(
                &ctx,
                GrantInput {
                    principal_id: Some(principal.id),
                    role_id: "role-owner".into(),
                    scope: Some(org_scope()),
                    ..Default::default()
                },
            )
            .unwrap();
        let sctx = AccessContext {
            assurance_level: Some(AssuranceLevel::SingleFactor),
            ..ctx
        };
        let d = store
            .decide(
                &sctx,
                &AccessRequest {
                    permission: "privacy.export".into(),
                    resource: resource("privacy_request", "tenant-1"),
                    required_assurance: Some(AssuranceLevel::Mfa),
                },
            )
            .unwrap();
        assert!(!d.allowed);
        assert_eq!(d.obligations.unwrap()[0].kind, "step_up_authentication");
    }

    #[test]
    fn conditional_allow_policy_uses_context_attributes() {
        let (store, _p, ctx) = setup(PrincipalType::Human);
        let mut conditions = Attributes::new();
        conditions.insert("facility".into(), Value::String("hospital-a".into()));
        store
            .add_policy(
                &ctx,
                PolicyInput {
                    effect: Some(PolicyEffect::Allow),
                    permissions: vec!["case.read".into()],
                    resource_types: Some(vec!["medical_case".into()]),
                    conditions: Some(conditions),
                    priority: 10,
                    enabled: true,
                    obligations: Some(vec![Obligation {
                        kind: "mask_sensitive_fields".into(),
                        value: None,
                    }]),
                    ..Default::default()
                },
            )
            .unwrap();
        let mut attrs = Attributes::new();
        attrs.insert("facility".into(), Value::String("hospital-a".into()));
        let actx = AccessContext {
            attributes: Some(attrs),
            ..ctx
        };
        let d = store
            .decide(
                &actx,
                &AccessRequest {
                    permission: "case.read".into(),
                    resource: resource("medical_case", "tenant-1"),
                    required_assurance: None,
                },
            )
            .unwrap();
        assert!(d.allowed);
        assert_eq!(d.obligations.unwrap()[0].kind, "mask_sensitive_fields");
    }

    #[test]
    fn custom_role_can_be_registered_and_granted() {
        let (store, principal, ctx) = setup(PrincipalType::Human);
        let role = store
            .register_role(
                &ctx,
                RoleInput {
                    key: "edi-operator".into(),
                    name: "EDI Operator".into(),
                    permissions: vec!["edi.replay".into(), "edi.quarantine.read".into()],
                },
            )
            .unwrap();
        store
            .grant(
                &ctx,
                GrantInput {
                    principal_id: Some(principal.id),
                    role_id: role.id,
                    scope: Some(Scope {
                        kind: ScopeType::Domain,
                        id: Some("edi".into()),
                    }),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(store
            .effective_permissions(&ctx, None)
            .unwrap()
            .contains(&"edi.replay".to_string()));
    }

    #[test]
    fn external_identity_resolves_to_principal() {
        let (store, principal, ctx) = setup(PrincipalType::Human);
        let identity = store
            .link_identity(
                &ctx,
                ExternalIdentityInput {
                    principal_id: principal.id.clone(),
                    provider: "oidc".into(),
                    issuer: "https://id.example.test".into(),
                    subject: "user-123".into(),
                    email: Some("user@example.test".into()),
                },
            )
            .unwrap();
        let resolved = store
            .resolve_identity(
                &ctx.organization_id,
                &identity.provider,
                &identity.issuer,
                &identity.subject,
            )
            .unwrap();
        assert_eq!(resolved.unwrap().id, principal.id);
    }

    #[test]
    fn revoked_grant_no_longer_contributes_permissions() {
        let (store, principal, ctx) = setup(PrincipalType::Human);
        let grant = store
            .grant(
                &ctx,
                GrantInput {
                    principal_id: Some(principal.id),
                    role_id: "role-editor".into(),
                    scope: Some(org_scope()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(store
            .effective_permissions(&ctx, None)
            .unwrap()
            .contains(&"content.write".to_string()));
        store.revoke_grant(&ctx, &grant.id).unwrap();
        assert!(!store
            .effective_permissions(&ctx, None)
            .unwrap()
            .contains(&"content.write".to_string()));
    }
}
