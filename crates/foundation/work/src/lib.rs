//! Foundation: Work (F1.4) — Rust port of the TS reference module.
//!
//! Owns cases, tasks, queues, dependencies, SLA targets, notes, participants,
//! checklists, work logs and decisions, with state-machine transitions
//! (see `modules/foundation/work`). Isolated crate.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;

pub type Id = String;
pub type IsoDateTime = String;

// --- Errors ----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WorkError {
    #[error("case '{0}' not found")]
    CaseNotFound(String),
    #[error("task '{0}' not found")]
    TaskNotFound(String),
    #[error("queue '{0}' not found")]
    QueueNotFound(String),
    #[error("participant not found")]
    ParticipantNotFound,
    #[error("checklist item not found")]
    ChecklistNotFound,
    #[error("invalid transition: {0}")]
    InvalidTransition(String),
    #[error("invalid assignment: {0}")]
    InvalidAssignment(String),
    #[error("dependency blocked: {0}")]
    DependencyBlocked(String),
    #[error("invalid work log: {0}")]
    InvalidWorkLog(String),
}

// --- Enums -----------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaseState {
    Open,
    OnHold,
    Resolved,
    Closed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Priority {
    Low,
    Normal,
    High,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Open,
    InProgress,
    Blocked,
    Completed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DependencyType {
    FinishToStart,
    Blocks,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoteVisibility {
    Internal,
    Participants,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParticipantAccess {
    Participant,
    Observer,
    Confidential,
}

// --- Value types -----------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct WorkContext {
    pub organization_id: Id,
    pub principal_id: Option<Id>,
    pub correlation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainLink {
    pub domain: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub id: Id,
    pub relation: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Case {
    pub id: Id,
    pub organization_id: Id,
    #[serde(rename = "type")]
    pub kind: String,
    pub title: String,
    pub state: CaseState,
    pub priority: Priority,
    pub party_ids: Vec<Id>,
    pub links: Vec<DomainLink>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_principal_id: Option<Id>,
    pub created_at: IsoDateTime,
    pub updated_at: IsoDateTime,
}

#[derive(Debug, Clone, Default)]
pub struct CaseInput {
    pub kind: String,
    pub title: String,
    pub priority: Option<Priority>,
    pub party_ids: Vec<Id>,
    pub links: Vec<DomainLink>,
    pub owner_principal_id: Option<Id>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: Id,
    pub organization_id: Id,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub case_id: Option<Id>,
    #[serde(rename = "type")]
    pub kind: String,
    pub title: String,
    pub state: TaskState,
    pub priority: Priority,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_id: Option<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee_principal_id: Option<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee_group_id: Option<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_at: Option<IsoDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub escalation_at: Option<IsoDateTime>,
    pub links: Vec<DomainLink>,
    pub created_at: IsoDateTime,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<IsoDateTime>,
}

#[derive(Debug, Clone, Default)]
pub struct TaskInput {
    pub case_id: Option<Id>,
    pub kind: String,
    pub title: String,
    pub priority: Option<Priority>,
    pub queue_id: Option<Id>,
    pub assignee_principal_id: Option<Id>,
    pub assignee_group_id: Option<Id>,
    pub due_at: Option<IsoDateTime>,
    pub escalation_at: Option<IsoDateTime>,
    pub links: Vec<DomainLink>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkQueue {
    pub id: Id,
    pub organization_id: Id,
    pub key: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accepted_task_types: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default)]
pub struct QueueInput {
    pub key: String,
    pub name: String,
    pub group_id: Option<Id>,
    pub accepted_task_types: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDependency {
    pub id: Id,
    pub task_id: Id,
    pub depends_on_task_id: Id,
    #[serde(rename = "type")]
    pub kind: DependencyType,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlaTarget {
    pub id: Id,
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
    pub response_minutes: i64,
    pub resolution_minutes: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub escalation_queue_id: Option<Id>,
}

#[derive(Debug, Clone, Default)]
pub struct SlaTargetInput {
    pub key: String,
    pub task_type: Option<String>,
    pub priority: Option<Priority>,
    pub response_minutes: i64,
    pub resolution_minutes: i64,
    pub escalation_queue_id: Option<Id>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlaStatus {
    pub task_id: Id,
    pub response_due_at: IsoDateTime,
    pub resolution_due_at: IsoDateTime,
    pub response_breached: bool,
    pub resolution_breached: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkNote {
    pub id: Id,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub case_id: Option<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<Id>,
    pub author_principal_id: Id,
    pub body: String,
    pub visibility: NoteVisibility,
    pub created_at: IsoDateTime,
}

#[derive(Debug, Clone, Default)]
pub struct WorkNoteInput {
    pub case_id: Option<Id>,
    pub task_id: Option<Id>,
    pub author_principal_id: Id,
    pub body: String,
    pub visibility: Option<NoteVisibility>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseParticipant {
    pub id: Id,
    pub case_id: Id,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub party_id: Option<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub principal_id: Option<Id>,
    pub role: String,
    pub access: ParticipantAccess,
    pub added_at: IsoDateTime,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed_at: Option<IsoDateTime>,
}

#[derive(Debug, Clone, Default)]
pub struct CaseParticipantInput {
    pub case_id: Id,
    pub party_id: Option<Id>,
    pub principal_id: Option<Id>,
    pub role: String,
    pub access: Option<ParticipantAccess>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistItem {
    pub id: Id,
    pub task_id: Id,
    pub label: String,
    pub required: bool,
    pub completed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_by_principal_id: Option<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<IsoDateTime>,
}

#[derive(Debug, Clone, Default)]
pub struct ChecklistItemInput {
    pub task_id: Id,
    pub label: String,
    pub required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkLog {
    pub id: Id,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub case_id: Option<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<Id>,
    pub principal_id: Id,
    pub started_at: IsoDateTime,
    pub ended_at: IsoDateTime,
    pub duration_minutes: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct WorkLogInput {
    pub case_id: Option<Id>,
    pub task_id: Option<Id>,
    pub principal_id: Id,
    pub started_at: IsoDateTime,
    pub ended_at: IsoDateTime,
    pub description: Option<String>,
    pub category: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub id: Id,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub case_id: Option<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<Id>,
    pub key: String,
    pub outcome: String,
    pub decided_by_principal_id: Id,
    pub decided_at: IsoDateTime,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence_links: Option<Vec<DomainLink>>,
}

#[derive(Debug, Clone, Default)]
pub struct DecisionInput {
    pub case_id: Option<Id>,
    pub task_id: Option<Id>,
    pub key: String,
    pub outcome: String,
    pub decided_by_principal_id: Id,
    pub reason: Option<String>,
    pub evidence_links: Option<Vec<DomainLink>>,
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

fn case_allows(from: CaseState, to: CaseState) -> bool {
    use CaseState::*;
    let allowed: &[CaseState] = match from {
        Open => &[OnHold, Resolved, Cancelled],
        OnHold => &[Open, Resolved, Cancelled],
        Resolved => &[Open, Closed],
        Closed | Cancelled => &[],
    };
    allowed.contains(&to)
}

fn task_allows(from: TaskState, to: TaskState) -> bool {
    use TaskState::*;
    let allowed: &[TaskState] = match from {
        Open => &[InProgress, Blocked, Completed, Cancelled],
        InProgress => &[Blocked, Completed, Cancelled],
        Blocked => &[Open, InProgress, Cancelled],
        Completed | Cancelled => &[],
    };
    allowed.contains(&to)
}

fn terminal(state: TaskState) -> bool {
    matches!(state, TaskState::Completed | TaskState::Cancelled)
}

// --- In-memory reference implementation ------------------------------------

#[derive(Default)]
struct Inner {
    cases: Vec<Case>,
    tasks: Vec<Task>,
    decisions: Vec<Decision>,
    queues: Vec<WorkQueue>,
    dependencies: Vec<TaskDependency>,
    sla_targets: Vec<SlaTarget>,
    notes: Vec<WorkNote>,
    participants: Vec<CaseParticipant>,
    checklist_items: Vec<ChecklistItem>,
    work_logs: Vec<WorkLog>,
    sequence: u64,
}

impl Inner {
    fn next(&mut self, prefix: &str) -> String {
        self.sequence += 1;
        format!("{prefix}-{}", self.sequence)
    }
    fn case_idx(&self, org: &str, id: &str) -> Result<usize, WorkError> {
        self.cases
            .iter()
            .position(|c| c.id == id && c.organization_id == org)
            .ok_or_else(|| WorkError::CaseNotFound(id.to_string()))
    }
    fn task_idx(&self, org: &str, id: &str) -> Result<usize, WorkError> {
        self.tasks
            .iter()
            .position(|t| t.id == id && t.organization_id == org)
            .ok_or_else(|| WorkError::TaskNotFound(id.to_string()))
    }
    fn queue_idx(&self, org: &str, id: &str) -> Result<usize, WorkError> {
        self.queues
            .iter()
            .position(|q| q.id == id && q.organization_id == org)
            .ok_or_else(|| WorkError::QueueNotFound(id.to_string()))
    }
    fn task_state(&self, id: &str) -> Option<TaskState> {
        self.tasks.iter().find(|t| t.id == id).map(|t| t.state)
    }
    fn match_sla(&self, task: &Task) -> Option<SlaTarget> {
        self.sla_targets
            .iter()
            .find(|t| {
                t.task_type
                    .as_deref()
                    .map(|tt| tt == task.kind)
                    .unwrap_or(true)
                    && t.priority.map(|p| p == task.priority).unwrap_or(true)
            })
            .cloned()
    }
    fn sla_status(task: &Task, target: &SlaTarget, at: &str) -> SlaStatus {
        let created = parse(&task.created_at).unwrap_or_else(Utc::now);
        let response_due = created + Duration::minutes(target.response_minutes);
        let resolution_due = created + Duration::minutes(target.resolution_minutes);
        let at_dt = parse(at).unwrap_or_else(Utc::now);
        SlaStatus {
            task_id: task.id.clone(),
            response_due_at: response_due.to_rfc3339(),
            resolution_due_at: resolution_due.to_rfc3339(),
            response_breached: task.state == TaskState::Open && at_dt > response_due,
            resolution_breached: !terminal(task.state) && at_dt > resolution_due,
        }
    }
}

#[derive(Default)]
pub struct ReferenceWorkStore {
    inner: RefCell<Inner>,
}

impl ReferenceWorkStore {
    pub fn new() -> Self {
        Self::default()
    }
}

// --- Cases -----------------------------------------------------------------

pub trait CaseProvider {
    fn case_create(&self, ctx: &WorkContext, input: CaseInput) -> Result<Case, WorkError>;
    fn case_get(&self, ctx: &WorkContext, id: &str) -> Result<Option<Case>, WorkError>;
    fn case_transition(
        &self,
        ctx: &WorkContext,
        id: &str,
        state: CaseState,
        reason: Option<String>,
    ) -> Result<Case, WorkError>;
}

impl CaseProvider for ReferenceWorkStore {
    fn case_create(&self, ctx: &WorkContext, input: CaseInput) -> Result<Case, WorkError> {
        let mut inner = self.inner.borrow_mut();
        let ts = now();
        let case = Case {
            id: inner.next("case"),
            organization_id: ctx.organization_id.clone(),
            kind: input.kind,
            title: input.title,
            state: CaseState::Open,
            priority: input.priority.unwrap_or(Priority::Normal),
            party_ids: input.party_ids,
            links: input.links,
            owner_principal_id: input.owner_principal_id,
            created_at: ts.clone(),
            updated_at: ts,
        };
        inner.cases.push(case.clone());
        Ok(case)
    }

    fn case_get(&self, ctx: &WorkContext, id: &str) -> Result<Option<Case>, WorkError> {
        let inner = self.inner.borrow();
        Ok(inner
            .cases
            .iter()
            .find(|c| c.id == id && c.organization_id == ctx.organization_id)
            .cloned())
    }

    fn case_transition(
        &self,
        ctx: &WorkContext,
        id: &str,
        state: CaseState,
        _reason: Option<String>,
    ) -> Result<Case, WorkError> {
        let mut inner = self.inner.borrow_mut();
        let idx = inner.case_idx(&ctx.organization_id, id)?;
        let from = inner.cases[idx].state;
        if !case_allows(from, state) {
            return Err(WorkError::InvalidTransition(format!(
                "case {from:?} -> {state:?}"
            )));
        }
        inner.cases[idx].state = state;
        inner.cases[idx].updated_at = now();
        Ok(inner.cases[idx].clone())
    }
}

// --- Tasks -----------------------------------------------------------------

pub trait TaskProvider {
    fn task_create(&self, ctx: &WorkContext, input: TaskInput) -> Result<Task, WorkError>;
    fn task_get(&self, ctx: &WorkContext, id: &str) -> Result<Option<Task>, WorkError>;
    fn task_assign(
        &self,
        ctx: &WorkContext,
        id: &str,
        principal_id: Option<Id>,
        group_id: Option<Id>,
    ) -> Result<Task, WorkError>;
    fn task_transition(
        &self,
        ctx: &WorkContext,
        id: &str,
        state: TaskState,
    ) -> Result<Task, WorkError>;
    fn task_overdue(
        &self,
        ctx: &WorkContext,
        at: Option<IsoDateTime>,
    ) -> Result<Vec<Task>, WorkError>;
    fn task_add_dependency(
        &self,
        ctx: &WorkContext,
        task_id: &str,
        depends_on_task_id: &str,
        kind: DependencyType,
    ) -> Result<TaskDependency, WorkError>;
    fn task_dependencies(
        &self,
        ctx: &WorkContext,
        task_id: &str,
    ) -> Result<Vec<TaskDependency>, WorkError>;
}

impl TaskProvider for ReferenceWorkStore {
    fn task_create(&self, ctx: &WorkContext, input: TaskInput) -> Result<Task, WorkError> {
        let mut inner = self.inner.borrow_mut();
        if let Some(case_id) = &input.case_id {
            inner.case_idx(&ctx.organization_id, case_id)?;
        }
        let task = Task {
            id: inner.next("task"),
            organization_id: ctx.organization_id.clone(),
            case_id: input.case_id,
            kind: input.kind,
            title: input.title,
            state: TaskState::Open,
            priority: input.priority.unwrap_or(Priority::Normal),
            queue_id: input.queue_id,
            assignee_principal_id: input.assignee_principal_id,
            assignee_group_id: input.assignee_group_id,
            due_at: input.due_at,
            escalation_at: input.escalation_at,
            links: input.links,
            created_at: now(),
            completed_at: None,
        };
        inner.tasks.push(task.clone());
        Ok(task)
    }

    fn task_get(&self, ctx: &WorkContext, id: &str) -> Result<Option<Task>, WorkError> {
        let inner = self.inner.borrow();
        Ok(inner
            .tasks
            .iter()
            .find(|t| t.id == id && t.organization_id == ctx.organization_id)
            .cloned())
    }

    fn task_assign(
        &self,
        ctx: &WorkContext,
        id: &str,
        principal_id: Option<Id>,
        group_id: Option<Id>,
    ) -> Result<Task, WorkError> {
        let mut inner = self.inner.borrow_mut();
        let idx = inner.task_idx(&ctx.organization_id, id)?;
        if principal_id.is_some() == group_id.is_some() {
            return Err(WorkError::InvalidAssignment(
                "assign exactly one principal or group".into(),
            ));
        }
        inner.tasks[idx].assignee_principal_id = principal_id;
        inner.tasks[idx].assignee_group_id = group_id;
        Ok(inner.tasks[idx].clone())
    }

    fn task_transition(
        &self,
        ctx: &WorkContext,
        id: &str,
        state: TaskState,
    ) -> Result<Task, WorkError> {
        let mut inner = self.inner.borrow_mut();
        let idx = inner.task_idx(&ctx.organization_id, id)?;
        let from = inner.tasks[idx].state;
        if !task_allows(from, state) {
            return Err(WorkError::InvalidTransition(format!(
                "task {from:?} -> {state:?}"
            )));
        }
        if state == TaskState::Completed
            && inner
                .checklist_items
                .iter()
                .any(|c| c.task_id == id && c.required && !c.completed)
        {
            return Err(WorkError::DependencyBlocked(
                "required checklist items are incomplete".into(),
            ));
        }
        if matches!(state, TaskState::InProgress | TaskState::Completed) {
            let blocked = inner
                .dependencies
                .iter()
                .filter(|d| d.task_id == id)
                .any(|d| inner.task_state(&d.depends_on_task_id) != Some(TaskState::Completed));
            if blocked {
                return Err(WorkError::DependencyBlocked(
                    "task has incomplete dependencies".into(),
                ));
            }
        }
        inner.tasks[idx].state = state;
        if state == TaskState::Completed {
            inner.tasks[idx].completed_at = Some(now());
        }
        Ok(inner.tasks[idx].clone())
    }

    fn task_overdue(
        &self,
        ctx: &WorkContext,
        at: Option<IsoDateTime>,
    ) -> Result<Vec<Task>, WorkError> {
        let at = at.unwrap_or_else(now);
        let at_dt = parse(&at).unwrap_or_else(Utc::now);
        let inner = self.inner.borrow();
        Ok(inner
            .tasks
            .iter()
            .filter(|t| t.organization_id == ctx.organization_id && !terminal(t.state))
            .filter(|t| {
                t.due_at
                    .as_deref()
                    .and_then(parse)
                    .map(|d| d < at_dt)
                    .unwrap_or(false)
            })
            .cloned()
            .collect())
    }

    fn task_add_dependency(
        &self,
        ctx: &WorkContext,
        task_id: &str,
        depends_on_task_id: &str,
        kind: DependencyType,
    ) -> Result<TaskDependency, WorkError> {
        let mut inner = self.inner.borrow_mut();
        inner.task_idx(&ctx.organization_id, task_id)?;
        inner.task_idx(&ctx.organization_id, depends_on_task_id)?;
        if task_id == depends_on_task_id {
            return Err(WorkError::DependencyBlocked(
                "task cannot depend on itself".into(),
            ));
        }
        let dep = TaskDependency {
            id: inner.next("dependency"),
            task_id: task_id.to_string(),
            depends_on_task_id: depends_on_task_id.to_string(),
            kind,
        };
        inner.dependencies.push(dep.clone());
        Ok(dep)
    }

    fn task_dependencies(
        &self,
        _ctx: &WorkContext,
        task_id: &str,
    ) -> Result<Vec<TaskDependency>, WorkError> {
        let inner = self.inner.borrow();
        Ok(inner
            .dependencies
            .iter()
            .filter(|d| d.task_id == task_id)
            .cloned()
            .collect())
    }
}

// --- Decisions -------------------------------------------------------------

pub trait DecisionProvider {
    fn decision_record(
        &self,
        ctx: &WorkContext,
        input: DecisionInput,
    ) -> Result<Decision, WorkError>;
    fn decision_list_for_case(
        &self,
        ctx: &WorkContext,
        case_id: &str,
    ) -> Result<Vec<Decision>, WorkError>;
}

impl DecisionProvider for ReferenceWorkStore {
    fn decision_record(
        &self,
        ctx: &WorkContext,
        input: DecisionInput,
    ) -> Result<Decision, WorkError> {
        let mut inner = self.inner.borrow_mut();
        if let Some(c) = &input.case_id {
            inner.case_idx(&ctx.organization_id, c)?;
        }
        if let Some(t) = &input.task_id {
            inner.task_idx(&ctx.organization_id, t)?;
        }
        let decision = Decision {
            id: inner.next("decision"),
            case_id: input.case_id,
            task_id: input.task_id,
            key: input.key,
            outcome: input.outcome,
            decided_by_principal_id: input.decided_by_principal_id,
            decided_at: now(),
            reason: input.reason,
            evidence_links: input.evidence_links,
        };
        inner.decisions.push(decision.clone());
        Ok(decision)
    }

    fn decision_list_for_case(
        &self,
        _ctx: &WorkContext,
        case_id: &str,
    ) -> Result<Vec<Decision>, WorkError> {
        let inner = self.inner.borrow();
        Ok(inner
            .decisions
            .iter()
            .filter(|d| d.case_id.as_deref() == Some(case_id))
            .cloned()
            .collect())
    }
}

// --- Queues ----------------------------------------------------------------

pub trait QueueProvider {
    fn queue_create(&self, ctx: &WorkContext, input: QueueInput) -> Result<WorkQueue, WorkError>;
    fn queue_enqueue(
        &self,
        ctx: &WorkContext,
        queue_id: &str,
        task_id: &str,
    ) -> Result<Task, WorkError>;
    fn queue_claim(
        &self,
        ctx: &WorkContext,
        queue_id: &str,
        task_id: &str,
        principal_id: &str,
    ) -> Result<Task, WorkError>;
    fn queue_list(&self, ctx: &WorkContext, queue_id: &str) -> Result<Vec<Task>, WorkError>;
}

impl QueueProvider for ReferenceWorkStore {
    fn queue_create(&self, ctx: &WorkContext, input: QueueInput) -> Result<WorkQueue, WorkError> {
        let mut inner = self.inner.borrow_mut();
        let queue = WorkQueue {
            id: inner.next("queue"),
            organization_id: ctx.organization_id.clone(),
            key: input.key,
            name: input.name,
            group_id: input.group_id,
            accepted_task_types: input.accepted_task_types,
        };
        inner.queues.push(queue.clone());
        Ok(queue)
    }

    fn queue_enqueue(
        &self,
        ctx: &WorkContext,
        queue_id: &str,
        task_id: &str,
    ) -> Result<Task, WorkError> {
        let mut inner = self.inner.borrow_mut();
        let qidx = inner.queue_idx(&ctx.organization_id, queue_id)?;
        let tidx = inner.task_idx(&ctx.organization_id, task_id)?;
        let accepts = match &inner.queues[qidx].accepted_task_types {
            Some(types) if !types.is_empty() => types.contains(&inner.tasks[tidx].kind),
            _ => true,
        };
        if !accepts {
            return Err(WorkError::InvalidAssignment(
                "queue rejects task type".into(),
            ));
        }
        let qid = inner.queues[qidx].id.clone();
        inner.tasks[tidx].queue_id = Some(qid);
        inner.tasks[tidx].assignee_principal_id = None;
        Ok(inner.tasks[tidx].clone())
    }

    fn queue_claim(
        &self,
        ctx: &WorkContext,
        queue_id: &str,
        task_id: &str,
        principal_id: &str,
    ) -> Result<Task, WorkError> {
        let mut inner = self.inner.borrow_mut();
        inner.queue_idx(&ctx.organization_id, queue_id)?;
        let tidx = inner.task_idx(&ctx.organization_id, task_id)?;
        if inner.tasks[tidx].queue_id.as_deref() != Some(queue_id) {
            return Err(WorkError::InvalidAssignment("task is not in queue".into()));
        }
        inner.tasks[tidx].assignee_principal_id = Some(principal_id.to_string());
        inner.tasks[tidx].queue_id = None;
        Ok(inner.tasks[tidx].clone())
    }

    fn queue_list(&self, ctx: &WorkContext, queue_id: &str) -> Result<Vec<Task>, WorkError> {
        let inner = self.inner.borrow();
        inner.queue_idx(&ctx.organization_id, queue_id)?;
        Ok(inner
            .tasks
            .iter()
            .filter(|t| {
                t.organization_id == ctx.organization_id && t.queue_id.as_deref() == Some(queue_id)
            })
            .cloned()
            .collect())
    }
}

// --- SLA -------------------------------------------------------------------

pub trait SlaProvider {
    fn sla_add_target(
        &self,
        ctx: &WorkContext,
        input: SlaTargetInput,
    ) -> Result<SlaTarget, WorkError>;
    fn sla_status(
        &self,
        ctx: &WorkContext,
        task_id: &str,
        at: Option<IsoDateTime>,
    ) -> Result<Option<SlaStatus>, WorkError>;
    fn sla_escalate_breaches(
        &self,
        ctx: &WorkContext,
        at: Option<IsoDateTime>,
    ) -> Result<Vec<Task>, WorkError>;
}

impl SlaProvider for ReferenceWorkStore {
    fn sla_add_target(
        &self,
        _ctx: &WorkContext,
        input: SlaTargetInput,
    ) -> Result<SlaTarget, WorkError> {
        let mut inner = self.inner.borrow_mut();
        let target = SlaTarget {
            id: inner.next("sla"),
            key: input.key,
            task_type: input.task_type,
            priority: input.priority,
            response_minutes: input.response_minutes,
            resolution_minutes: input.resolution_minutes,
            escalation_queue_id: input.escalation_queue_id,
        };
        inner.sla_targets.push(target.clone());
        Ok(target)
    }

    fn sla_status(
        &self,
        ctx: &WorkContext,
        task_id: &str,
        at: Option<IsoDateTime>,
    ) -> Result<Option<SlaStatus>, WorkError> {
        let at = at.unwrap_or_else(now);
        let inner = self.inner.borrow();
        let tidx = inner.task_idx(&ctx.organization_id, task_id)?;
        let task = inner.tasks[tidx].clone();
        Ok(inner
            .match_sla(&task)
            .map(|t| Inner::sla_status(&task, &t, &at)))
    }

    fn sla_escalate_breaches(
        &self,
        ctx: &WorkContext,
        at: Option<IsoDateTime>,
    ) -> Result<Vec<Task>, WorkError> {
        let at = at.unwrap_or_else(now);
        let mut inner = self.inner.borrow_mut();
        let mut escalated = Vec::new();
        let indices: Vec<usize> = (0..inner.tasks.len()).collect();
        for i in indices {
            let task = inner.tasks[i].clone();
            if task.organization_id != ctx.organization_id || terminal(task.state) {
                continue;
            }
            let Some(target) = inner.match_sla(&task) else {
                continue;
            };
            let status = Inner::sla_status(&task, &target, &at);
            if status.resolution_breached {
                if let Some(queue) = target.escalation_queue_id {
                    inner.tasks[i].queue_id = Some(queue);
                    inner.tasks[i].assignee_principal_id = None;
                    escalated.push(inner.tasks[i].clone());
                }
            }
        }
        Ok(escalated)
    }
}

// --- Notes -----------------------------------------------------------------

pub trait NoteProvider {
    fn note_add(&self, ctx: &WorkContext, input: WorkNoteInput) -> Result<WorkNote, WorkError>;
    fn note_list_for_case(
        &self,
        ctx: &WorkContext,
        case_id: &str,
    ) -> Result<Vec<WorkNote>, WorkError>;
    fn note_list_for_task(
        &self,
        ctx: &WorkContext,
        task_id: &str,
    ) -> Result<Vec<WorkNote>, WorkError>;
}

impl NoteProvider for ReferenceWorkStore {
    fn note_add(&self, ctx: &WorkContext, input: WorkNoteInput) -> Result<WorkNote, WorkError> {
        let mut inner = self.inner.borrow_mut();
        if let Some(c) = &input.case_id {
            inner.case_idx(&ctx.organization_id, c)?;
        }
        if let Some(t) = &input.task_id {
            inner.task_idx(&ctx.organization_id, t)?;
        }
        if input.case_id.is_none() && input.task_id.is_none() {
            return Err(WorkError::InvalidAssignment(
                "note needs case or task".into(),
            ));
        }
        let note = WorkNote {
            id: inner.next("note"),
            case_id: input.case_id,
            task_id: input.task_id,
            author_principal_id: input.author_principal_id,
            body: input.body,
            visibility: input.visibility.unwrap_or(NoteVisibility::Internal),
            created_at: now(),
        };
        inner.notes.push(note.clone());
        Ok(note)
    }

    fn note_list_for_case(
        &self,
        _ctx: &WorkContext,
        case_id: &str,
    ) -> Result<Vec<WorkNote>, WorkError> {
        let inner = self.inner.borrow();
        Ok(inner
            .notes
            .iter()
            .filter(|n| n.case_id.as_deref() == Some(case_id))
            .cloned()
            .collect())
    }

    fn note_list_for_task(
        &self,
        _ctx: &WorkContext,
        task_id: &str,
    ) -> Result<Vec<WorkNote>, WorkError> {
        let inner = self.inner.borrow();
        Ok(inner
            .notes
            .iter()
            .filter(|n| n.task_id.as_deref() == Some(task_id))
            .cloned()
            .collect())
    }
}

// --- Participants ----------------------------------------------------------

pub trait ParticipantProvider {
    fn participant_add(
        &self,
        ctx: &WorkContext,
        input: CaseParticipantInput,
    ) -> Result<CaseParticipant, WorkError>;
    fn participant_remove(
        &self,
        ctx: &WorkContext,
        participant_id: &str,
    ) -> Result<CaseParticipant, WorkError>;
    fn participant_list(
        &self,
        ctx: &WorkContext,
        case_id: &str,
        at: Option<IsoDateTime>,
    ) -> Result<Vec<CaseParticipant>, WorkError>;
}

impl ParticipantProvider for ReferenceWorkStore {
    fn participant_add(
        &self,
        ctx: &WorkContext,
        input: CaseParticipantInput,
    ) -> Result<CaseParticipant, WorkError> {
        let mut inner = self.inner.borrow_mut();
        inner.case_idx(&ctx.organization_id, &input.case_id)?;
        if input.party_id.is_some() == input.principal_id.is_some() {
            return Err(WorkError::InvalidAssignment(
                "participant needs exactly one party or principal".into(),
            ));
        }
        let participant = CaseParticipant {
            id: inner.next("participant"),
            case_id: input.case_id,
            party_id: input.party_id,
            principal_id: input.principal_id,
            role: input.role,
            access: input.access.unwrap_or(ParticipantAccess::Participant),
            added_at: now(),
            removed_at: None,
        };
        inner.participants.push(participant.clone());
        Ok(participant)
    }

    fn participant_remove(
        &self,
        ctx: &WorkContext,
        participant_id: &str,
    ) -> Result<CaseParticipant, WorkError> {
        let mut inner = self.inner.borrow_mut();
        let pos = inner
            .participants
            .iter()
            .position(|p| p.id == participant_id)
            .ok_or(WorkError::ParticipantNotFound)?;
        let case_id = inner.participants[pos].case_id.clone();
        inner.case_idx(&ctx.organization_id, &case_id)?;
        inner.participants[pos].removed_at = Some(now());
        Ok(inner.participants[pos].clone())
    }

    fn participant_list(
        &self,
        ctx: &WorkContext,
        case_id: &str,
        at: Option<IsoDateTime>,
    ) -> Result<Vec<CaseParticipant>, WorkError> {
        let at = at.unwrap_or_else(now);
        let point = parse(&at).unwrap_or_else(Utc::now);
        let inner = self.inner.borrow();
        inner.case_idx(&ctx.organization_id, case_id)?;
        Ok(inner
            .participants
            .iter()
            .filter(|p| p.case_id == case_id)
            .filter(|p| {
                parse(&p.added_at).map(|a| a <= point).unwrap_or(true)
                    && p.removed_at
                        .as_deref()
                        .and_then(parse)
                        .map(|r| r > point)
                        .unwrap_or(true)
            })
            .cloned()
            .collect())
    }
}

// --- Checklists ------------------------------------------------------------

pub trait ChecklistProvider {
    fn checklist_add(
        &self,
        ctx: &WorkContext,
        input: ChecklistItemInput,
    ) -> Result<ChecklistItem, WorkError>;
    fn checklist_complete(
        &self,
        ctx: &WorkContext,
        item_id: &str,
        principal_id: &str,
    ) -> Result<ChecklistItem, WorkError>;
    fn checklist_list(
        &self,
        ctx: &WorkContext,
        task_id: &str,
    ) -> Result<Vec<ChecklistItem>, WorkError>;
}

impl ChecklistProvider for ReferenceWorkStore {
    fn checklist_add(
        &self,
        ctx: &WorkContext,
        input: ChecklistItemInput,
    ) -> Result<ChecklistItem, WorkError> {
        let mut inner = self.inner.borrow_mut();
        inner.task_idx(&ctx.organization_id, &input.task_id)?;
        let item = ChecklistItem {
            id: inner.next("checklist"),
            task_id: input.task_id,
            label: input.label,
            required: input.required,
            completed: false,
            completed_by_principal_id: None,
            completed_at: None,
        };
        inner.checklist_items.push(item.clone());
        Ok(item)
    }

    fn checklist_complete(
        &self,
        ctx: &WorkContext,
        item_id: &str,
        principal_id: &str,
    ) -> Result<ChecklistItem, WorkError> {
        let mut inner = self.inner.borrow_mut();
        let pos = inner
            .checklist_items
            .iter()
            .position(|i| i.id == item_id)
            .ok_or(WorkError::ChecklistNotFound)?;
        let task_id = inner.checklist_items[pos].task_id.clone();
        inner.task_idx(&ctx.organization_id, &task_id)?;
        inner.checklist_items[pos].completed = true;
        inner.checklist_items[pos].completed_by_principal_id = Some(principal_id.to_string());
        inner.checklist_items[pos].completed_at = Some(now());
        Ok(inner.checklist_items[pos].clone())
    }

    fn checklist_list(
        &self,
        ctx: &WorkContext,
        task_id: &str,
    ) -> Result<Vec<ChecklistItem>, WorkError> {
        let inner = self.inner.borrow();
        inner.task_idx(&ctx.organization_id, task_id)?;
        Ok(inner
            .checklist_items
            .iter()
            .filter(|i| i.task_id == task_id)
            .cloned()
            .collect())
    }
}

// --- Work logs -------------------------------------------------------------

pub trait WorkLogProvider {
    fn work_log_record(&self, ctx: &WorkContext, input: WorkLogInput)
        -> Result<WorkLog, WorkError>;
    fn work_log_list_for_case(
        &self,
        ctx: &WorkContext,
        case_id: &str,
    ) -> Result<Vec<WorkLog>, WorkError>;
    fn work_log_total_minutes(
        &self,
        ctx: &WorkContext,
        case_id: Option<&str>,
        task_id: Option<&str>,
    ) -> Result<i64, WorkError>;
}

impl WorkLogProvider for ReferenceWorkStore {
    fn work_log_record(
        &self,
        ctx: &WorkContext,
        input: WorkLogInput,
    ) -> Result<WorkLog, WorkError> {
        let mut inner = self.inner.borrow_mut();
        if let Some(c) = &input.case_id {
            inner.case_idx(&ctx.organization_id, c)?;
        }
        if let Some(t) = &input.task_id {
            inner.task_idx(&ctx.organization_id, t)?;
        }
        if input.case_id.is_none() && input.task_id.is_none() {
            return Err(WorkError::InvalidWorkLog(
                "work log needs case or task".into(),
            ));
        }
        let (start, end) = match (parse(&input.started_at), parse(&input.ended_at)) {
            (Some(s), Some(e)) => (s, e),
            _ => return Err(WorkError::InvalidWorkLog("invalid timestamps".into())),
        };
        let duration_minutes = ((end - start).num_milliseconds() as f64 / 60_000.0).round() as i64;
        if duration_minutes <= 0 {
            return Err(WorkError::InvalidWorkLog(
                "duration must be positive".into(),
            ));
        }
        let log = WorkLog {
            id: inner.next("work-log"),
            case_id: input.case_id,
            task_id: input.task_id,
            principal_id: input.principal_id,
            started_at: input.started_at,
            ended_at: input.ended_at,
            duration_minutes,
            description: input.description,
            category: input.category,
        };
        inner.work_logs.push(log.clone());
        Ok(log)
    }

    fn work_log_list_for_case(
        &self,
        ctx: &WorkContext,
        case_id: &str,
    ) -> Result<Vec<WorkLog>, WorkError> {
        let inner = self.inner.borrow();
        inner.case_idx(&ctx.organization_id, case_id)?;
        Ok(inner
            .work_logs
            .iter()
            .filter(|l| l.case_id.as_deref() == Some(case_id))
            .cloned()
            .collect())
    }

    fn work_log_total_minutes(
        &self,
        _ctx: &WorkContext,
        case_id: Option<&str>,
        task_id: Option<&str>,
    ) -> Result<i64, WorkError> {
        let inner = self.inner.borrow();
        Ok(inner
            .work_logs
            .iter()
            .filter(|l| {
                case_id
                    .map(|c| l.case_id.as_deref() == Some(c))
                    .unwrap_or(true)
            })
            .filter(|l| {
                task_id
                    .map(|t| l.task_id.as_deref() == Some(t))
                    .unwrap_or(true)
            })
            .map(|l| l.duration_minutes)
            .sum())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> WorkContext {
        WorkContext {
            organization_id: "tenant-1".into(),
            principal_id: Some("principal-1".into()),
            correlation_id: "work-test".into(),
        }
    }

    fn case_input() -> CaseInput {
        CaseInput {
            kind: "privacy_request".into(),
            title: "Access request".into(),
            priority: Some(Priority::Normal),
            party_ids: vec!["party-1".into()],
            links: vec![DomainLink {
                domain: "privacy".into(),
                kind: "request".into(),
                id: "request-1".into(),
                relation: "subject".into(),
            }],
            owner_principal_id: None,
        }
    }

    fn task_input(kind: &str, title: &str, priority: Priority) -> TaskInput {
        TaskInput {
            kind: kind.into(),
            title: title.into(),
            priority: Some(priority),
            ..Default::default()
        }
    }

    #[test]
    fn case_links_domain_object_and_party() {
        let store = ReferenceWorkStore::new();
        let value = store.case_create(&ctx(), case_input()).unwrap();
        assert_eq!(value.party_ids[0], "party-1");
        assert_eq!(value.links[0].domain, "privacy");
    }

    #[test]
    fn task_can_be_assigned_to_one_principal() {
        let store = ReferenceWorkStore::new();
        let value = store
            .task_create(
                &ctx(),
                task_input("review", "Review request", Priority::High),
            )
            .unwrap();
        let assigned = store
            .task_assign(&ctx(), &value.id, Some("principal-reviewer".into()), None)
            .unwrap();
        assert_eq!(
            assigned.assignee_principal_id.as_deref(),
            Some("principal-reviewer")
        );
    }

    #[test]
    fn overdue_excludes_completed_tasks() {
        let store = ReferenceWorkStore::new();
        let mut input = task_input("deadline", "Due", Priority::High);
        input.due_at = Some((Utc::now() - Duration::seconds(1)).to_rfc3339());
        let value = store.task_create(&ctx(), input).unwrap();
        assert_eq!(store.task_overdue(&ctx(), None).unwrap().len(), 1);
        store
            .task_transition(&ctx(), &value.id, TaskState::Completed)
            .unwrap();
        assert_eq!(store.task_overdue(&ctx(), None).unwrap().len(), 0);
    }

    #[test]
    fn decision_captures_actor_outcome_evidence() {
        let store = ReferenceWorkStore::new();
        let case_value = store.case_create(&ctx(), case_input()).unwrap();
        let decision = store
            .decision_record(
                &ctx(),
                DecisionInput {
                    case_id: Some(case_value.id),
                    key: "approve".into(),
                    outcome: "approved".into(),
                    decided_by_principal_id: "principal-approver".into(),
                    reason: Some("Requirements met".into()),
                    evidence_links: Some(vec![DomainLink {
                        domain: "asset".into(),
                        kind: "document".into(),
                        id: "asset-1".into(),
                        relation: "evidence".into(),
                    }]),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(decision.outcome, "approved");
        assert_eq!(decision.evidence_links.unwrap()[0].domain, "asset");
    }

    #[test]
    fn queue_accepts_configured_type_and_supports_claiming() {
        let store = ReferenceWorkStore::new();
        let queue = store
            .queue_create(
                &ctx(),
                QueueInput {
                    key: "privacy-review".into(),
                    name: "Privacy Review".into(),
                    accepted_task_types: Some(vec!["privacy_review".into()]),
                    ..Default::default()
                },
            )
            .unwrap();
        let task = store
            .task_create(
                &ctx(),
                task_input("privacy_review", "Review erasure", Priority::High),
            )
            .unwrap();
        store.queue_enqueue(&ctx(), &queue.id, &task.id).unwrap();
        let claimed = store
            .queue_claim(&ctx(), &queue.id, &task.id, "principal-reviewer")
            .unwrap();
        assert_eq!(
            claimed.assignee_principal_id.as_deref(),
            Some("principal-reviewer")
        );
    }

    #[test]
    fn task_dependency_blocks_start_until_complete() {
        let store = ReferenceWorkStore::new();
        let first = store
            .task_create(
                &ctx(),
                task_input("verify", "Verify identity", Priority::Normal),
            )
            .unwrap();
        let second = store
            .task_create(
                &ctx(),
                task_input("export", "Create export", Priority::Normal),
            )
            .unwrap();
        store
            .task_add_dependency(&ctx(), &second.id, &first.id, DependencyType::FinishToStart)
            .unwrap();
        let err = store
            .task_transition(&ctx(), &second.id, TaskState::InProgress)
            .unwrap_err();
        assert!(matches!(err, WorkError::DependencyBlocked(_)));
        store
            .task_transition(&ctx(), &first.id, TaskState::Completed)
            .unwrap();
        assert_eq!(
            store
                .task_transition(&ctx(), &second.id, TaskState::InProgress)
                .unwrap()
                .state,
            TaskState::InProgress
        );
    }

    #[test]
    fn sla_breach_moves_task_to_escalation_queue() {
        let store = ReferenceWorkStore::new();
        let queue = store
            .queue_create(
                &ctx(),
                QueueInput {
                    key: "escalation".into(),
                    name: "Escalation".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        store
            .sla_add_target(
                &ctx(),
                SlaTargetInput {
                    key: "critical".into(),
                    priority: Some(Priority::Critical),
                    response_minutes: 5,
                    resolution_minutes: 10,
                    escalation_queue_id: Some(queue.id.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
        let task = store
            .task_create(
                &ctx(),
                task_input("incident", "Critical incident", Priority::Critical),
            )
            .unwrap();
        let at = (parse(&task.created_at).unwrap() + Duration::minutes(11)).to_rfc3339();
        let escalated = store.sla_escalate_breaches(&ctx(), Some(at)).unwrap();
        assert_eq!(escalated[0].queue_id.as_deref(), Some(queue.id.as_str()));
    }

    #[test]
    fn structured_notes_preserve_visibility_and_author() {
        let store = ReferenceWorkStore::new();
        let case_value = store.case_create(&ctx(), case_input()).unwrap();
        let note = store
            .note_add(
                &ctx(),
                WorkNoteInput {
                    case_id: Some(case_value.id.clone()),
                    author_principal_id: "principal-lawyer".into(),
                    body: "Internal legal assessment".into(),
                    visibility: Some(NoteVisibility::Internal),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(note.visibility, NoteVisibility::Internal);
        assert_eq!(
            store
                .note_list_for_case(&ctx(), &case_value.id)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn case_participants_retain_historical_membership() {
        let store = ReferenceWorkStore::new();
        let case_value = store.case_create(&ctx(), case_input()).unwrap();
        let participant = store
            .participant_add(
                &ctx(),
                CaseParticipantInput {
                    case_id: case_value.id.clone(),
                    party_id: Some("party-client".into()),
                    role: "client".into(),
                    access: Some(ParticipantAccess::Participant),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(
            store
                .participant_list(&ctx(), &case_value.id, None)
                .unwrap()
                .len(),
            1
        );
        store.participant_remove(&ctx(), &participant.id).unwrap();
        assert_eq!(
            store
                .participant_list(&ctx(), &case_value.id, None)
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn required_checklist_blocks_completion() {
        let store = ReferenceWorkStore::new();
        let task = store
            .task_create(&ctx(), task_input("review", "Review", Priority::Normal))
            .unwrap();
        let item = store
            .checklist_add(
                &ctx(),
                ChecklistItemInput {
                    task_id: task.id.clone(),
                    label: "Identity verified".into(),
                    required: true,
                },
            )
            .unwrap();
        let err = store
            .task_transition(&ctx(), &task.id, TaskState::Completed)
            .unwrap_err();
        assert!(matches!(err, WorkError::DependencyBlocked(_)));
        store
            .checklist_complete(&ctx(), &item.id, "principal-reviewer")
            .unwrap();
        assert_eq!(
            store
                .task_transition(&ctx(), &task.id, TaskState::Completed)
                .unwrap()
                .state,
            TaskState::Completed
        );
    }

    #[test]
    fn work_logs_calculate_and_aggregate_time() {
        let store = ReferenceWorkStore::new();
        let case_value = store.case_create(&ctx(), case_input()).unwrap();
        store
            .work_log_record(
                &ctx(),
                WorkLogInput {
                    case_id: Some(case_value.id.clone()),
                    principal_id: "principal-lawyer".into(),
                    started_at: "2026-06-19T09:00:00.000Z".into(),
                    ended_at: "2026-06-19T09:45:00.000Z".into(),
                    description: Some("Case review".into()),
                    category: Some("review".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        store
            .work_log_record(
                &ctx(),
                WorkLogInput {
                    case_id: Some(case_value.id.clone()),
                    principal_id: "principal-lawyer".into(),
                    started_at: "2026-06-19T10:00:00.000Z".into(),
                    ended_at: "2026-06-19T10:30:00.000Z".into(),
                    description: Some("Client call".into()),
                    category: Some("communication".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(
            store
                .work_log_total_minutes(&ctx(), Some(&case_value.id), None)
                .unwrap(),
            75
        );
    }
}
