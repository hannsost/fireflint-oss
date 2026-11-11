//! Foundation: Time & Resource (F1.5) — Rust port of the TS reference module.
//!
//! Owns resources, pools, availability rules, blackouts, calendar exceptions,
//! reservations and allocation, with timezone-aware rule evaluation and
//! conflict checking (see `modules/foundation/time-resource`). Isolated crate.

use chrono::{DateTime, Datelike, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::BTreeMap;

pub type Id = String;
pub type IsoDateTime = String;

// --- Errors ----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ResourceError {
    #[error("resource '{0}' not found")]
    ResourceNotFound(String),
    #[error("reservation '{0}' not found")]
    ReservationNotFound(String),
    #[error("pool '{0}' not found")]
    PoolNotFound(String),
    #[error("invalid time range")]
    InvalidTimeRange,
    #[error("capacity exceeded: {0}")]
    CapacityExceeded(String),
    #[error("resource unavailable: {0}")]
    ResourceUnavailable(String),
}

// --- Enums -----------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceStatus {
    Active,
    Inactive,
    Maintenance,
    Retired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PoolSelection {
    Any,
    All,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReservationState {
    Held,
    Confirmed,
    Cancelled,
    Expired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExceptionMode {
    Available,
    Unavailable,
}

// --- Value types -----------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct ResourceContext {
    pub organization_id: Id,
    pub correlation_id: String,
    pub principal_id: Option<Id>,
}

pub type Attributes = BTreeMap<String, Value>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resource {
    pub id: Id,
    pub organization_id: Id,
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    pub status: ResourceStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location_party_id: Option<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub responsible_party_id: Option<Id>,
    pub timezone: String,
    pub capacity: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attributes: Option<Attributes>,
}

#[derive(Debug, Clone, Default)]
pub struct ResourceInput {
    pub kind: String,
    pub name: String,
    pub location_party_id: Option<Id>,
    pub responsible_party_id: Option<Id>,
    pub timezone: String,
    pub capacity: i64,
    pub attributes: Option<Attributes>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcePool {
    pub id: Id,
    pub organization_id: Id,
    pub key: String,
    pub name: String,
    pub resource_ids: Vec<Id>,
    pub selection: PoolSelection,
}

#[derive(Debug, Clone, Default)]
pub struct ResourcePoolInput {
    pub key: String,
    pub name: String,
    pub resource_ids: Vec<Id>,
    pub selection: Option<PoolSelection>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeRange {
    pub start: IsoDateTime,
    pub end: IsoDateTime,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailabilityRule {
    pub id: Id,
    pub resource_id: Id,
    pub weekdays: Vec<u32>,
    pub local_start: String,
    pub local_end: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_until: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capacity: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct AvailabilityRuleInput {
    pub resource_id: Id,
    pub weekdays: Vec<u32>,
    pub local_start: String,
    pub local_end: String,
    pub valid_from: Option<String>,
    pub valid_until: Option<String>,
    pub capacity: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Blackout {
    pub id: Id,
    pub resource_id: Id,
    pub range: TimeRange,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capacity_reduction: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct BlackoutInput {
    pub resource_id: Id,
    pub range: Option<TimeRange>,
    pub reason: String,
    pub capacity_reduction: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarException {
    pub id: Id,
    pub resource_id: Id,
    pub range: TimeRange,
    pub mode: ExceptionMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capacity_override: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct CalendarExceptionInput {
    pub resource_id: Id,
    pub range: Option<TimeRange>,
    pub mode: Option<ExceptionMode>,
    pub capacity_override: Option<i64>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainRef {
    pub domain: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub id: Id,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reservation {
    pub id: Id,
    pub organization_id: Id,
    pub resource_id: Id,
    pub range: TimeRange,
    pub quantity: i64,
    pub state: ReservationState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub party_id: Option<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain_ref: Option<DomainRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<IsoDateTime>,
    pub created_at: IsoDateTime,
}

#[derive(Debug, Clone, Default)]
pub struct ReservationInput {
    pub resource_id: Id,
    pub range: Option<TimeRange>,
    pub quantity: i64,
    pub party_id: Option<Id>,
    pub domain_ref: Option<DomainRef>,
    pub expires_at: Option<IsoDateTime>,
}

#[derive(Debug, Clone, Default)]
pub struct AllocationRequest {
    pub resource_id: Option<Id>,
    pub pool_id: Option<Id>,
    pub range: TimeRange,
    pub quantity: i64,
    pub party_id: Option<Id>,
    pub domain_ref: Option<DomainRef>,
    pub expires_at: Option<IsoDateTime>,
}

#[derive(Debug, Clone)]
pub struct AllocationResult {
    pub reservations: Vec<Reservation>,
    pub selected_resource_ids: Vec<Id>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailabilityResult {
    pub resource_id: Id,
    pub range: TimeRange,
    pub total_capacity: i64,
    pub reserved_capacity: i64,
    pub available_capacity: i64,
    pub available: bool,
    pub conflicts: Vec<Id>,
}

#[derive(Debug, Clone, Default)]
pub struct ResourceRequirement {
    pub kind: Option<String>,
    pub location_party_id: Option<Id>,
    pub attributes: Option<Attributes>,
    pub minimum_capacity: Option<i64>,
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

fn overlaps(left: &TimeRange, right: &TimeRange) -> bool {
    match (
        parse(&left.start),
        parse(&left.end),
        parse(&right.start),
        parse(&right.end),
    ) {
        (Some(ls), Some(le), Some(rs), Some(re)) => ls < re && rs < le,
        _ => false,
    }
}

struct LocalParts {
    date: String,
    time: String,
    weekday: u32,
}

fn local_parts(value: &str, timezone: &str) -> Option<LocalParts> {
    let utc = parse(value)?;
    let tz: Tz = timezone.parse().unwrap_or(chrono_tz::UTC);
    let local = utc.with_timezone(&tz);
    Some(LocalParts {
        date: local.format("%Y-%m-%d").to_string(),
        time: local.format("%H:%M").to_string(),
        weekday: local.weekday().num_days_from_sunday(),
    })
}

// --- In-memory reference implementation ------------------------------------

#[derive(Default)]
struct Inner {
    resources: Vec<Resource>,
    rules: Vec<AvailabilityRule>,
    blackouts: Vec<Blackout>,
    exceptions: Vec<CalendarException>,
    reservations: Vec<Reservation>,
    pools: Vec<ResourcePool>,
    sequence: u64,
}

impl Inner {
    fn next(&mut self, prefix: &str) -> String {
        self.sequence += 1;
        format!("{prefix}-{}", self.sequence)
    }
    fn resource(&self, org: &str, id: &str) -> Result<Resource, ResourceError> {
        self.resources
            .iter()
            .find(|r| r.id == id && r.organization_id == org)
            .cloned()
            .ok_or_else(|| ResourceError::ResourceNotFound(id.to_string()))
    }
    fn pool(&self, org: &str, id: &str) -> Result<ResourcePool, ResourceError> {
        self.pools
            .iter()
            .find(|p| p.id == id && p.organization_id == org)
            .cloned()
            .ok_or_else(|| ResourceError::PoolNotFound(id.to_string()))
    }
    fn reservation_idx(&self, org: &str, id: &str) -> Result<usize, ResourceError> {
        self.reservations
            .iter()
            .position(|r| r.id == id && r.organization_id == org)
            .ok_or_else(|| ResourceError::ReservationNotFound(id.to_string()))
    }
}

fn assert_range(range: &TimeRange) -> Result<(), ResourceError> {
    match (parse(&range.start), parse(&range.end)) {
        (Some(s), Some(e)) if e > s => Ok(()),
        _ => Err(ResourceError::InvalidTimeRange),
    }
}

fn rule_allows(
    resource: &Resource,
    rule: &AvailabilityRule,
    range: &TimeRange,
    quantity: i64,
) -> bool {
    let (Some(start), Some(end)) = (
        local_parts(&range.start, &resource.timezone),
        local_parts(&range.end, &resource.timezone),
    ) else {
        return false;
    };
    if start.date != end.date {
        return false;
    }
    if !rule.weekdays.contains(&start.weekday) {
        return false;
    }
    if let Some(vf) = &rule.valid_from {
        if start.date < *vf {
            return false;
        }
    }
    if let Some(vu) = &rule.valid_until {
        if start.date > *vu {
            return false;
        }
    }
    if start.time < rule.local_start || end.time > rule.local_end {
        return false;
    }
    rule.capacity.unwrap_or(resource.capacity) >= quantity
}

#[derive(Default)]
pub struct ReferenceResourceStore {
    inner: RefCell<Inner>,
}

impl ReferenceResourceStore {
    pub fn new() -> Self {
        Self::default()
    }
}

// --- Resources + pools -----------------------------------------------------

pub trait ResourceProvider {
    fn create(
        &self,
        ctx: &ResourceContext,
        input: ResourceInput,
    ) -> Result<Resource, ResourceError>;
    fn get(&self, ctx: &ResourceContext, id: &str) -> Result<Option<Resource>, ResourceError>;
    fn set_status(
        &self,
        ctx: &ResourceContext,
        id: &str,
        status: ResourceStatus,
    ) -> Result<Resource, ResourceError>;
    fn create_pool(
        &self,
        ctx: &ResourceContext,
        input: ResourcePoolInput,
    ) -> Result<ResourcePool, ResourceError>;
    fn get_pool(
        &self,
        ctx: &ResourceContext,
        id: &str,
    ) -> Result<Option<ResourcePool>, ResourceError>;
}

impl ResourceProvider for ReferenceResourceStore {
    fn create(
        &self,
        ctx: &ResourceContext,
        input: ResourceInput,
    ) -> Result<Resource, ResourceError> {
        if input.capacity < 1 {
            return Err(ResourceError::CapacityExceeded(
                "capacity must be positive".into(),
            ));
        }
        let mut inner = self.inner.borrow_mut();
        let resource = Resource {
            id: inner.next("resource"),
            organization_id: ctx.organization_id.clone(),
            kind: input.kind,
            name: input.name,
            status: ResourceStatus::Active,
            location_party_id: input.location_party_id,
            responsible_party_id: input.responsible_party_id,
            timezone: input.timezone,
            capacity: input.capacity,
            attributes: input.attributes,
        };
        inner.resources.push(resource.clone());
        Ok(resource)
    }

    fn get(&self, ctx: &ResourceContext, id: &str) -> Result<Option<Resource>, ResourceError> {
        let inner = self.inner.borrow();
        Ok(inner
            .resources
            .iter()
            .find(|r| r.id == id && r.organization_id == ctx.organization_id)
            .cloned())
    }

    fn set_status(
        &self,
        ctx: &ResourceContext,
        id: &str,
        status: ResourceStatus,
    ) -> Result<Resource, ResourceError> {
        let mut inner = self.inner.borrow_mut();
        let pos = inner
            .resources
            .iter()
            .position(|r| r.id == id && r.organization_id == ctx.organization_id)
            .ok_or_else(|| ResourceError::ResourceNotFound(id.to_string()))?;
        inner.resources[pos].status = status;
        Ok(inner.resources[pos].clone())
    }

    fn create_pool(
        &self,
        ctx: &ResourceContext,
        input: ResourcePoolInput,
    ) -> Result<ResourcePool, ResourceError> {
        let mut inner = self.inner.borrow_mut();
        for rid in &input.resource_ids {
            inner.resource(&ctx.organization_id, rid)?;
        }
        let pool = ResourcePool {
            id: inner.next("pool"),
            organization_id: ctx.organization_id.clone(),
            key: input.key,
            name: input.name,
            resource_ids: input.resource_ids,
            selection: input.selection.unwrap_or(PoolSelection::Any),
        };
        inner.pools.push(pool.clone());
        Ok(pool)
    }

    fn get_pool(
        &self,
        ctx: &ResourceContext,
        id: &str,
    ) -> Result<Option<ResourcePool>, ResourceError> {
        let inner = self.inner.borrow();
        Ok(inner
            .pools
            .iter()
            .find(|p| p.id == id && p.organization_id == ctx.organization_id)
            .cloned())
    }
}

// --- Calendar / availability -----------------------------------------------

pub trait CalendarProvider {
    fn add_rule(
        &self,
        ctx: &ResourceContext,
        input: AvailabilityRuleInput,
    ) -> Result<AvailabilityRule, ResourceError>;
    fn add_blackout(
        &self,
        ctx: &ResourceContext,
        input: BlackoutInput,
    ) -> Result<Blackout, ResourceError>;
    fn add_exception(
        &self,
        ctx: &ResourceContext,
        input: CalendarExceptionInput,
    ) -> Result<CalendarException, ResourceError>;
    fn availability(
        &self,
        ctx: &ResourceContext,
        resource_id: &str,
        range: &TimeRange,
        quantity: i64,
    ) -> Result<AvailabilityResult, ResourceError>;
}

impl CalendarProvider for ReferenceResourceStore {
    fn add_rule(
        &self,
        ctx: &ResourceContext,
        input: AvailabilityRuleInput,
    ) -> Result<AvailabilityRule, ResourceError> {
        let mut inner = self.inner.borrow_mut();
        inner.resource(&ctx.organization_id, &input.resource_id)?;
        let rule = AvailabilityRule {
            id: inner.next("rule"),
            resource_id: input.resource_id,
            weekdays: input.weekdays,
            local_start: input.local_start,
            local_end: input.local_end,
            valid_from: input.valid_from,
            valid_until: input.valid_until,
            capacity: input.capacity,
        };
        inner.rules.push(rule.clone());
        Ok(rule)
    }

    fn add_blackout(
        &self,
        ctx: &ResourceContext,
        input: BlackoutInput,
    ) -> Result<Blackout, ResourceError> {
        let range = input.range.ok_or(ResourceError::InvalidTimeRange)?;
        assert_range(&range)?;
        let mut inner = self.inner.borrow_mut();
        inner.resource(&ctx.organization_id, &input.resource_id)?;
        let blackout = Blackout {
            id: inner.next("blackout"),
            resource_id: input.resource_id,
            range,
            reason: input.reason,
            capacity_reduction: input.capacity_reduction,
        };
        inner.blackouts.push(blackout.clone());
        Ok(blackout)
    }

    fn add_exception(
        &self,
        ctx: &ResourceContext,
        input: CalendarExceptionInput,
    ) -> Result<CalendarException, ResourceError> {
        let range = input.range.ok_or(ResourceError::InvalidTimeRange)?;
        assert_range(&range)?;
        let mut inner = self.inner.borrow_mut();
        inner.resource(&ctx.organization_id, &input.resource_id)?;
        let exception = CalendarException {
            id: inner.next("exception"),
            resource_id: input.resource_id,
            range,
            mode: input.mode.unwrap_or(ExceptionMode::Available),
            capacity_override: input.capacity_override,
            reason: input.reason,
        };
        inner.exceptions.push(exception.clone());
        Ok(exception)
    }

    fn availability(
        &self,
        ctx: &ResourceContext,
        resource_id: &str,
        range: &TimeRange,
        quantity: i64,
    ) -> Result<AvailabilityResult, ResourceError> {
        assert_range(range)?;
        let inner = self.inner.borrow();
        let resource = inner.resource(&ctx.organization_id, resource_id)?;

        let exceptions: Vec<&CalendarException> = inner
            .exceptions
            .iter()
            .filter(|e| e.resource_id == resource_id && overlaps(&e.range, range))
            .collect();
        let unavailable_exception = exceptions
            .iter()
            .any(|e| e.mode == ExceptionMode::Unavailable);
        let available_exception = exceptions
            .iter()
            .rev()
            .find(|e| e.mode == ExceptionMode::Available)
            .copied();

        let rules: Vec<&AvailabilityRule> = inner
            .rules
            .iter()
            .filter(|r| r.resource_id == resource_id)
            .collect();
        let within_rules = available_exception.is_some()
            || rules.is_empty()
            || rules
                .iter()
                .any(|r| rule_allows(&resource, r, range, quantity));

        let now_dt = Utc::now();
        let overlapping: Vec<&Reservation> = inner
            .reservations
            .iter()
            .filter(|r| {
                r.resource_id == resource_id
                    && matches!(
                        r.state,
                        ReservationState::Held | ReservationState::Confirmed
                    )
                    && r.expires_at
                        .as_deref()
                        .and_then(parse)
                        .map(|e| e > now_dt)
                        .unwrap_or(true)
                    && overlaps(&r.range, range)
            })
            .collect();
        let reserved: i64 = overlapping.iter().map(|r| r.quantity).sum();

        let reduction: i64 = inner
            .blackouts
            .iter()
            .filter(|b| b.resource_id == resource_id && overlaps(&b.range, range))
            .map(|b| b.capacity_reduction.unwrap_or(resource.capacity))
            .sum();

        let base_capacity = available_exception
            .and_then(|e| e.capacity_override)
            .unwrap_or(resource.capacity);
        let available_capacity = (base_capacity - reduction - reserved).max(0);

        Ok(AvailabilityResult {
            resource_id: resource_id.to_string(),
            range: range.clone(),
            total_capacity: resource.capacity,
            reserved_capacity: reserved,
            available_capacity,
            available: resource.status == ResourceStatus::Active
                && !unavailable_exception
                && within_rules
                && available_capacity >= quantity,
            conflicts: overlapping.iter().map(|r| r.id.clone()).collect(),
        })
    }
}

// --- Reservations ----------------------------------------------------------

pub trait ReservationProvider {
    fn hold(
        &self,
        ctx: &ResourceContext,
        input: ReservationInput,
    ) -> Result<Reservation, ResourceError>;
    fn confirm(&self, ctx: &ResourceContext, id: &str) -> Result<Reservation, ResourceError>;
    fn cancel(&self, ctx: &ResourceContext, id: &str) -> Result<Reservation, ResourceError>;
    fn reschedule(
        &self,
        ctx: &ResourceContext,
        id: &str,
        range: TimeRange,
    ) -> Result<Reservation, ResourceError>;
    fn list(
        &self,
        ctx: &ResourceContext,
        resource_id: &str,
        range: Option<&TimeRange>,
    ) -> Result<Vec<Reservation>, ResourceError>;
    fn expire_holds(
        &self,
        ctx: &ResourceContext,
        at: Option<IsoDateTime>,
    ) -> Result<Vec<Reservation>, ResourceError>;
}

impl ReservationProvider for ReferenceResourceStore {
    fn hold(
        &self,
        ctx: &ResourceContext,
        input: ReservationInput,
    ) -> Result<Reservation, ResourceError> {
        let range = input.range.clone().ok_or(ResourceError::InvalidTimeRange)?;
        let availability = self.availability(ctx, &input.resource_id, &range, input.quantity)?;
        if !availability.available {
            return Err(ResourceError::ResourceUnavailable(
                "insufficient availability".into(),
            ));
        }
        let mut inner = self.inner.borrow_mut();
        let reservation = Reservation {
            id: inner.next("reservation"),
            organization_id: ctx.organization_id.clone(),
            resource_id: input.resource_id,
            range,
            quantity: input.quantity,
            state: ReservationState::Held,
            party_id: input.party_id,
            domain_ref: input.domain_ref,
            expires_at: input.expires_at,
            created_at: now(),
        };
        inner.reservations.push(reservation.clone());
        Ok(reservation)
    }

    fn confirm(&self, ctx: &ResourceContext, id: &str) -> Result<Reservation, ResourceError> {
        let mut inner = self.inner.borrow_mut();
        let idx = inner.reservation_idx(&ctx.organization_id, id)?;
        if inner.reservations[idx].state != ReservationState::Held {
            return Err(ResourceError::ResourceUnavailable(
                "only held reservations can be confirmed".into(),
            ));
        }
        inner.reservations[idx].state = ReservationState::Confirmed;
        Ok(inner.reservations[idx].clone())
    }

    fn cancel(&self, ctx: &ResourceContext, id: &str) -> Result<Reservation, ResourceError> {
        let mut inner = self.inner.borrow_mut();
        let idx = inner.reservation_idx(&ctx.organization_id, id)?;
        inner.reservations[idx].state = ReservationState::Cancelled;
        Ok(inner.reservations[idx].clone())
    }

    fn reschedule(
        &self,
        ctx: &ResourceContext,
        id: &str,
        range: TimeRange,
    ) -> Result<Reservation, ResourceError> {
        assert_range(&range)?;
        // Snapshot + temporarily free the slot so it doesn't conflict with itself.
        let (resource_id, quantity, original_range, original_state) = {
            let inner = self.inner.borrow();
            let idx = inner.reservation_idx(&ctx.organization_id, id)?;
            let r = &inner.reservations[idx];
            if !matches!(
                r.state,
                ReservationState::Held | ReservationState::Confirmed
            ) {
                return Err(ResourceError::ResourceUnavailable(
                    "only active reservations can be rescheduled".into(),
                ));
            }
            (r.resource_id.clone(), r.quantity, r.range.clone(), r.state)
        };
        {
            let mut inner = self.inner.borrow_mut();
            let idx = inner.reservation_idx(&ctx.organization_id, id)?;
            inner.reservations[idx].state = ReservationState::Cancelled;
        }
        let availability = self.availability(ctx, &resource_id, &range, quantity)?;
        let mut inner = self.inner.borrow_mut();
        let idx = inner.reservation_idx(&ctx.organization_id, id)?;
        if !availability.available {
            inner.reservations[idx].state = original_state;
            inner.reservations[idx].range = original_range;
            return Err(ResourceError::ResourceUnavailable(
                "new reservation range is unavailable".into(),
            ));
        }
        inner.reservations[idx].range = range;
        inner.reservations[idx].state = original_state;
        Ok(inner.reservations[idx].clone())
    }

    fn list(
        &self,
        ctx: &ResourceContext,
        resource_id: &str,
        range: Option<&TimeRange>,
    ) -> Result<Vec<Reservation>, ResourceError> {
        let inner = self.inner.borrow();
        Ok(inner
            .reservations
            .iter()
            .filter(|r| r.organization_id == ctx.organization_id && r.resource_id == resource_id)
            .filter(|r| range.map(|rg| overlaps(&r.range, rg)).unwrap_or(true))
            .cloned()
            .collect())
    }

    fn expire_holds(
        &self,
        ctx: &ResourceContext,
        at: Option<IsoDateTime>,
    ) -> Result<Vec<Reservation>, ResourceError> {
        let at = at.unwrap_or_else(now);
        let at_dt = parse(&at);
        let mut inner = self.inner.borrow_mut();
        let mut expired = Vec::new();
        for r in inner.reservations.iter_mut() {
            let is_expired = r.organization_id == ctx.organization_id
                && r.state == ReservationState::Held
                && r.expires_at
                    .as_deref()
                    .and_then(parse)
                    .zip(at_dt)
                    .map(|(e, a)| e <= a)
                    .unwrap_or(false);
            if is_expired {
                r.state = ReservationState::Expired;
                expired.push(r.clone());
            }
        }
        Ok(expired)
    }
}

// --- Allocation + search ---------------------------------------------------

pub trait AllocationProvider {
    fn allocate(
        &self,
        ctx: &ResourceContext,
        requests: Vec<AllocationRequest>,
    ) -> Result<AllocationResult, ResourceError>;
    fn alternatives(
        &self,
        ctx: &ResourceContext,
        pool_id: &str,
        range: &TimeRange,
        quantity: i64,
    ) -> Result<Vec<AvailabilityResult>, ResourceError>;
}

impl AllocationProvider for ReferenceResourceStore {
    fn allocate(
        &self,
        ctx: &ResourceContext,
        requests: Vec<AllocationRequest>,
    ) -> Result<AllocationResult, ResourceError> {
        let mut selected: Vec<(String, AllocationRequest)> = Vec::new();
        for request in requests {
            if request.resource_id.is_some() == request.pool_id.is_some() {
                return Err(ResourceError::ResourceUnavailable(
                    "specify exactly one resource or pool".into(),
                ));
            }
            if let Some(rid) = &request.resource_id {
                let available = self.availability(ctx, rid, &request.range, request.quantity)?;
                if !available.available {
                    return Err(ResourceError::ResourceUnavailable(format!(
                        "resource '{rid}' unavailable"
                    )));
                }
                selected.push((rid.clone(), request));
                continue;
            }
            let pool_id = request.pool_id.clone().unwrap();
            let pool = self.inner.borrow().pool(&ctx.organization_id, &pool_id)?;
            let mut candidates: Vec<String> = Vec::new();
            for rid in &pool.resource_ids {
                if self
                    .availability(ctx, rid, &request.range, request.quantity)?
                    .available
                {
                    candidates.push(rid.clone());
                }
            }
            let chosen: Vec<String> = match pool.selection {
                PoolSelection::All => {
                    if candidates.len() == pool.resource_ids.len() {
                        candidates
                    } else {
                        Vec::new()
                    }
                }
                PoolSelection::Any => candidates.into_iter().take(1).collect(),
            };
            if chosen.is_empty() {
                return Err(ResourceError::ResourceUnavailable(format!(
                    "pool '{}' has no suitable resources",
                    pool.id
                )));
            }
            for rid in chosen {
                selected.push((rid, request.clone()));
            }
        }

        let mut reservations = Vec::new();
        for (rid, request) in selected {
            let held = self.hold(
                ctx,
                ReservationInput {
                    resource_id: rid,
                    range: Some(request.range.clone()),
                    quantity: request.quantity,
                    party_id: request.party_id.clone(),
                    domain_ref: request.domain_ref.clone(),
                    expires_at: request.expires_at.clone(),
                },
            );
            match held {
                Ok(r) => reservations.push(r),
                Err(e) => {
                    for r in &reservations {
                        let _ = self.cancel(ctx, &r.id);
                    }
                    return Err(e);
                }
            }
        }
        let selected_resource_ids = reservations.iter().map(|r| r.resource_id.clone()).collect();
        Ok(AllocationResult {
            reservations,
            selected_resource_ids,
        })
    }

    fn alternatives(
        &self,
        ctx: &ResourceContext,
        pool_id: &str,
        range: &TimeRange,
        quantity: i64,
    ) -> Result<Vec<AvailabilityResult>, ResourceError> {
        let pool = self.inner.borrow().pool(&ctx.organization_id, pool_id)?;
        let mut results = Vec::new();
        for rid in &pool.resource_ids {
            let a = self.availability(ctx, rid, range, quantity)?;
            if a.available {
                results.push(a);
            }
        }
        results.sort_by_key(|l| std::cmp::Reverse(l.available_capacity));
        Ok(results)
    }
}

pub trait ResourceSearchProvider {
    fn search_available(
        &self,
        ctx: &ResourceContext,
        requirement: &ResourceRequirement,
        range: &TimeRange,
        quantity: i64,
    ) -> Result<Vec<AvailabilityResult>, ResourceError>;
}

impl ResourceSearchProvider for ReferenceResourceStore {
    fn search_available(
        &self,
        ctx: &ResourceContext,
        requirement: &ResourceRequirement,
        range: &TimeRange,
        quantity: i64,
    ) -> Result<Vec<AvailabilityResult>, ResourceError> {
        let resources: Vec<Resource> = {
            let inner = self.inner.borrow();
            inner
                .resources
                .iter()
                .filter(|r| r.organization_id == ctx.organization_id)
                .filter(|r| {
                    requirement
                        .kind
                        .as_deref()
                        .map(|k| r.kind == k)
                        .unwrap_or(true)
                })
                .filter(|r| {
                    requirement
                        .location_party_id
                        .as_deref()
                        .map(|l| r.location_party_id.as_deref() == Some(l))
                        .unwrap_or(true)
                })
                .filter(|r| {
                    requirement
                        .minimum_capacity
                        .map(|m| r.capacity >= m)
                        .unwrap_or(true)
                })
                .filter(|r| match &requirement.attributes {
                    None => true,
                    Some(req) => req
                        .iter()
                        .all(|(k, v)| r.attributes.as_ref().and_then(|a| a.get(k)) == Some(v)),
                })
                .cloned()
                .collect()
        };
        let mut results = Vec::new();
        for r in resources {
            let a = self.availability(ctx, &r.id, range, quantity)?;
            if a.available {
                results.push(a);
            }
        }
        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx() -> ResourceContext {
        ResourceContext {
            organization_id: "tenant-1".into(),
            correlation_id: "resource-test".into(),
            principal_id: None,
        }
    }

    fn base_range() -> TimeRange {
        TimeRange {
            start: "2026-07-01T12:00:00.000Z".into(),
            end: "2026-07-03T10:00:00.000Z".into(),
        }
    }

    fn res_input(kind: &str, name: &str, tz: &str, capacity: i64) -> ResourceInput {
        ResourceInput {
            kind: kind.into(),
            name: name.into(),
            timezone: tz.into(),
            capacity,
            ..Default::default()
        }
    }

    #[test]
    fn same_model_for_hotel_room_and_warehouse_dock() {
        let store = ReferenceResourceStore::new();
        let room = store
            .create(
                &ctx(),
                res_input("hotel_room", "Room 101", "Europe/Berlin", 1),
            )
            .unwrap();
        let dock = store
            .create(
                &ctx(),
                res_input("warehouse_dock", "Dock A", "Europe/Berlin", 2),
            )
            .unwrap();
        assert_eq!(room.kind, "hotel_room");
        assert_eq!(dock.capacity, 2);
    }

    #[test]
    fn reservation_prevents_overbooking() {
        let store = ReferenceResourceStore::new();
        let resource = store
            .create(&ctx(), res_input("room", "Room", "Europe/Berlin", 1))
            .unwrap();
        store
            .hold(
                &ctx(),
                ReservationInput {
                    resource_id: resource.id.clone(),
                    range: Some(base_range()),
                    quantity: 1,
                    party_id: Some("party-guest".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        let err = store
            .hold(
                &ctx(),
                ReservationInput {
                    resource_id: resource.id,
                    range: Some(base_range()),
                    quantity: 1,
                    ..Default::default()
                },
            )
            .unwrap_err();
        assert!(matches!(err, ResourceError::ResourceUnavailable(_)));
    }

    #[test]
    fn capacity_resource_allows_parallel_up_to_limit() {
        let store = ReferenceResourceStore::new();
        let resource = store
            .create(&ctx(), res_input("vehicle_pool", "Vans", "UTC", 3))
            .unwrap();
        store
            .hold(
                &ctx(),
                ReservationInput {
                    resource_id: resource.id.clone(),
                    range: Some(base_range()),
                    quantity: 2,
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(
            store
                .availability(&ctx(), &resource.id, &base_range(), 1)
                .unwrap()
                .available
        );
        assert!(
            !store
                .availability(&ctx(), &resource.id, &base_range(), 2)
                .unwrap()
                .available
        );
    }

    #[test]
    fn blackout_removes_capacity() {
        let store = ReferenceResourceStore::new();
        let resource = store
            .create(
                &ctx(),
                res_input("treatment_room", "Room", "Europe/Berlin", 1),
            )
            .unwrap();
        store
            .add_blackout(
                &ctx(),
                BlackoutInput {
                    resource_id: resource.id.clone(),
                    range: Some(base_range()),
                    reason: "maintenance".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(
            !store
                .availability(&ctx(), &resource.id, &base_range(), 1)
                .unwrap()
                .available
        );
    }

    #[test]
    fn availability_rule_evaluated_in_resource_timezone() {
        let store = ReferenceResourceStore::new();
        let resource = store
            .create(
                &ctx(),
                res_input("doctor", "Dr. Example", "Europe/Berlin", 1),
            )
            .unwrap();
        store
            .add_rule(
                &ctx(),
                AvailabilityRuleInput {
                    resource_id: resource.id.clone(),
                    weekdays: vec![1],
                    local_start: "09:00".into(),
                    local_end: "17:00".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        let monday = TimeRange {
            start: "2026-06-22T08:00:00.000Z".into(),
            end: "2026-06-22T09:00:00.000Z".into(),
        };
        let evening = TimeRange {
            start: "2026-06-22T18:00:00.000Z".into(),
            end: "2026-06-22T19:00:00.000Z".into(),
        };
        assert!(
            store
                .availability(&ctx(), &resource.id, &monday, 1)
                .unwrap()
                .available
        );
        assert!(
            !store
                .availability(&ctx(), &resource.id, &evening, 1)
                .unwrap()
                .available
        );
    }

    #[test]
    fn expired_hold_releases_capacity() {
        let store = ReferenceResourceStore::new();
        let resource = store
            .create(&ctx(), res_input("room", "Room", "UTC", 1))
            .unwrap();
        store
            .hold(
                &ctx(),
                ReservationInput {
                    resource_id: resource.id.clone(),
                    range: Some(base_range()),
                    quantity: 1,
                    expires_at: Some("2026-06-20T00:00:00.000Z".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        store
            .expire_holds(&ctx(), Some("2026-06-21T00:00:00.000Z".into()))
            .unwrap();
        assert_eq!(
            store.list(&ctx(), &resource.id, None).unwrap()[0].state,
            ReservationState::Expired
        );
        assert!(
            store
                .availability(&ctx(), &resource.id, &base_range(), 1)
                .unwrap()
                .available
        );
    }

    #[test]
    fn pool_selects_available_resource() {
        let store = ReferenceResourceStore::new();
        let first = store
            .create(&ctx(), res_input("van", "Van 1", "UTC", 1))
            .unwrap();
        let second = store
            .create(&ctx(), res_input("van", "Van 2", "UTC", 1))
            .unwrap();
        let pool = store
            .create_pool(
                &ctx(),
                ResourcePoolInput {
                    key: "delivery-vans".into(),
                    name: "Delivery Vans".into(),
                    resource_ids: vec![first.id, second.id],
                    selection: Some(PoolSelection::Any),
                },
            )
            .unwrap();
        let result = store
            .allocate(
                &ctx(),
                vec![AllocationRequest {
                    pool_id: Some(pool.id),
                    range: base_range(),
                    quantity: 1,
                    ..Default::default()
                }],
            )
            .unwrap();
        assert_eq!(result.selected_resource_ids.len(), 1);
    }

    #[test]
    fn multi_resource_allocation_is_all_or_nothing() {
        let store = ReferenceResourceStore::new();
        let room = store
            .create(&ctx(), res_input("room", "Room", "UTC", 1))
            .unwrap();
        let device = store
            .create(&ctx(), res_input("device", "Device", "UTC", 1))
            .unwrap();
        store
            .hold(
                &ctx(),
                ReservationInput {
                    resource_id: device.id.clone(),
                    range: Some(base_range()),
                    quantity: 1,
                    ..Default::default()
                },
            )
            .unwrap();
        let err = store
            .allocate(
                &ctx(),
                vec![
                    AllocationRequest {
                        resource_id: Some(room.id.clone()),
                        range: base_range(),
                        quantity: 1,
                        ..Default::default()
                    },
                    AllocationRequest {
                        resource_id: Some(device.id),
                        range: base_range(),
                        quantity: 1,
                        ..Default::default()
                    },
                ],
            )
            .unwrap_err();
        assert!(matches!(err, ResourceError::ResourceUnavailable(_)));
        assert!(
            store
                .availability(&ctx(), &room.id, &base_range(), 1)
                .unwrap()
                .available
        );
    }

    #[test]
    fn calendar_exception_opens_availability() {
        let store = ReferenceResourceStore::new();
        let resource = store
            .create(&ctx(), res_input("clinic", "Clinic", "Europe/Berlin", 1))
            .unwrap();
        store
            .add_rule(
                &ctx(),
                AvailabilityRuleInput {
                    resource_id: resource.id.clone(),
                    weekdays: vec![1],
                    local_start: "09:00".into(),
                    local_end: "17:00".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        let saturday = TimeRange {
            start: "2026-06-27T08:00:00.000Z".into(),
            end: "2026-06-27T09:00:00.000Z".into(),
        };
        assert!(
            !store
                .availability(&ctx(), &resource.id, &saturday, 1)
                .unwrap()
                .available
        );
        store
            .add_exception(
                &ctx(),
                CalendarExceptionInput {
                    resource_id: resource.id.clone(),
                    range: Some(saturday.clone()),
                    mode: Some(ExceptionMode::Available),
                    reason: Some("special clinic".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(
            store
                .availability(&ctx(), &resource.id, &saturday, 1)
                .unwrap()
                .available
        );
    }

    #[test]
    fn search_returns_matching_resources() {
        let store = ReferenceResourceStore::new();
        let mut a = res_input("hotel_room", "Accessible Room", "UTC", 2);
        a.attributes = Some(BTreeMap::from([
            ("accessible".into(), json!(true)),
            ("seaView".into(), json!(false)),
        ]));
        store.create(&ctx(), a).unwrap();
        let mut b = res_input("hotel_room", "Standard Room", "UTC", 2);
        b.attributes = Some(BTreeMap::from([
            ("accessible".into(), json!(false)),
            ("seaView".into(), json!(true)),
        ]));
        store.create(&ctx(), b).unwrap();
        let req = ResourceRequirement {
            kind: Some("hotel_room".into()),
            attributes: Some(BTreeMap::from([("accessible".into(), json!(true))])),
            ..Default::default()
        };
        let results = store
            .search_available(&ctx(), &req, &base_range(), 1)
            .unwrap();
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn reservation_can_be_rescheduled_without_self_conflict() {
        let store = ReferenceResourceStore::new();
        let resource = store
            .create(&ctx(), res_input("room", "Room", "UTC", 1))
            .unwrap();
        let reservation = store
            .hold(
                &ctx(),
                ReservationInput {
                    resource_id: resource.id,
                    range: Some(base_range()),
                    quantity: 1,
                    ..Default::default()
                },
            )
            .unwrap();
        let new_range = TimeRange {
            start: "2026-07-04T12:00:00.000Z".into(),
            end: "2026-07-05T10:00:00.000Z".into(),
        };
        let moved = store
            .reschedule(&ctx(), &reservation.id, new_range.clone())
            .unwrap();
        assert_eq!(moved.range, new_range);
    }

    #[test]
    fn pool_alternatives_ranked_by_remaining_capacity() {
        let store = ReferenceResourceStore::new();
        let small = store
            .create(&ctx(), res_input("dock", "Small Dock", "UTC", 1))
            .unwrap();
        let large = store
            .create(&ctx(), res_input("dock", "Large Dock", "UTC", 3))
            .unwrap();
        let pool = store
            .create_pool(
                &ctx(),
                ResourcePoolInput {
                    key: "docks".into(),
                    name: "Docks".into(),
                    resource_ids: vec![small.id, large.id.clone()],
                    selection: Some(PoolSelection::Any),
                },
            )
            .unwrap();
        let alternatives = store
            .alternatives(&ctx(), &pool.id, &base_range(), 1)
            .unwrap();
        assert_eq!(alternatives[0].resource_id, large.id);
    }
}
