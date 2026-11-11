export type Id = string;
export type IsoDateTime = string;
export interface WorkContext {
  organizationId: Id;
  principalId?: Id;
  correlationId: string;
}
export interface DomainLink {
  domain: string;
  type: string;
  id: Id;
  relation: string;
}
export interface Case {
  id: Id;
  organizationId: Id;
  type: string;
  title: string;
  state: "open" | "on_hold" | "resolved" | "closed" | "cancelled";
  priority: "low" | "normal" | "high" | "critical";
  partyIds: Id[];
  links: DomainLink[];
  ownerPrincipalId?: Id;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
export interface Task {
  id: Id;
  organizationId: Id;
  caseId?: Id;
  type: string;
  title: string;
  state: "open" | "in_progress" | "blocked" | "completed" | "cancelled";
  priority: Case["priority"];
  queueId?: Id;
  assigneePrincipalId?: Id;
  assigneeGroupId?: Id;
  dueAt?: IsoDateTime;
  escalationAt?: IsoDateTime;
  links: DomainLink[];
  createdAt: IsoDateTime;
  completedAt?: IsoDateTime;
}

export interface WorkQueue {
  id: Id;
  organizationId: Id;
  key: string;
  name: string;
  groupId?: Id;
  acceptedTaskTypes?: string[];
}

export interface TaskDependency {
  id: Id;
  taskId: Id;
  dependsOnTaskId: Id;
  type: "finish_to_start" | "blocks";
}

export interface SlaTarget {
  id: Id;
  key: string;
  taskType?: string;
  priority?: Case["priority"];
  responseMinutes: number;
  resolutionMinutes: number;
  escalationQueueId?: Id;
}

export interface SlaStatus {
  taskId: Id;
  responseDueAt: IsoDateTime;
  resolutionDueAt: IsoDateTime;
  responseBreached: boolean;
  resolutionBreached: boolean;
}

export interface WorkNote {
  id: Id;
  caseId?: Id;
  taskId?: Id;
  authorPrincipalId: Id;
  body: string;
  visibility: "internal" | "participants";
  createdAt: IsoDateTime;
}

export interface CaseParticipant {
  id: Id;
  caseId: Id;
  partyId?: Id;
  principalId?: Id;
  role: string;
  access: "participant" | "observer" | "confidential";
  addedAt: IsoDateTime;
  removedAt?: IsoDateTime;
}

export interface ChecklistItem {
  id: Id;
  taskId: Id;
  label: string;
  required: boolean;
  completed: boolean;
  completedByPrincipalId?: Id;
  completedAt?: IsoDateTime;
}

export interface WorkLog {
  id: Id;
  caseId?: Id;
  taskId?: Id;
  principalId: Id;
  startedAt: IsoDateTime;
  endedAt: IsoDateTime;
  durationMinutes: number;
  description?: string;
  category?: string;
}
export interface Decision {
  id: Id;
  caseId?: Id;
  taskId?: Id;
  key: string;
  outcome: string;
  decidedByPrincipalId: Id;
  decidedAt: IsoDateTime;
  reason?: string;
  evidenceLinks?: DomainLink[];
}
export interface CaseProvider {
  create(context: WorkContext, input: Omit<Case, "id" | "organizationId" | "state" | "createdAt" | "updatedAt">): Promise<Case>;
  get(context: WorkContext, caseId: Id): Promise<Case | null>;
  transition(context: WorkContext, caseId: Id, state: Case["state"], reason?: string): Promise<Case>;
}
export interface TaskProvider {
  create(context: WorkContext, input: Omit<Task, "id" | "organizationId" | "state" | "createdAt" | "completedAt">): Promise<Task>;
  get(context: WorkContext, taskId: Id): Promise<Task | null>;
  assign(context: WorkContext, taskId: Id, input: { principalId?: Id; groupId?: Id }): Promise<Task>;
  transition(context: WorkContext, taskId: Id, state: Task["state"]): Promise<Task>;
  overdue(context: WorkContext, at?: IsoDateTime): Promise<Task[]>;
  addDependency(
    context: WorkContext,
    dependency: Omit<TaskDependency, "id">,
  ): Promise<TaskDependency>;
  dependencies(context: WorkContext, taskId: Id): Promise<TaskDependency[]>;
}
export interface DecisionProvider {
  record(context: WorkContext, input: Omit<Decision, "id" | "decidedAt">): Promise<Decision>;
  listForCase(context: WorkContext, caseId: Id): Promise<Decision[]>;
}

export interface QueueProvider {
  create(
    context: WorkContext,
    input: Omit<WorkQueue, "id" | "organizationId">,
  ): Promise<WorkQueue>;
  enqueue(context: WorkContext, queueId: Id, taskId: Id): Promise<Task>;
  claim(context: WorkContext, queueId: Id, taskId: Id, principalId: Id): Promise<Task>;
  list(context: WorkContext, queueId: Id): Promise<Task[]>;
}

export interface SlaProvider {
  addTarget(context: WorkContext, target: Omit<SlaTarget, "id">): Promise<SlaTarget>;
  status(context: WorkContext, taskId: Id, at?: IsoDateTime): Promise<SlaStatus | null>;
  escalateBreaches(context: WorkContext, at?: IsoDateTime): Promise<Task[]>;
}

export interface NoteProvider {
  add(context: WorkContext, input: Omit<WorkNote, "id" | "createdAt">): Promise<WorkNote>;
  listForCase(context: WorkContext, caseId: Id): Promise<WorkNote[]>;
  listForTask(context: WorkContext, taskId: Id): Promise<WorkNote[]>;
}

export interface ParticipantProvider {
  add(
    context: WorkContext,
    input: Omit<CaseParticipant, "id" | "addedAt" | "removedAt">,
  ): Promise<CaseParticipant>;
  remove(context: WorkContext, participantId: Id): Promise<CaseParticipant>;
  list(context: WorkContext, caseId: Id, at?: IsoDateTime): Promise<CaseParticipant[]>;
}

export interface ChecklistProvider {
  add(
    context: WorkContext,
    input: Omit<ChecklistItem, "id" | "completed" | "completedAt" | "completedByPrincipalId">,
  ): Promise<ChecklistItem>;
  complete(
    context: WorkContext,
    itemId: Id,
    principalId: Id,
  ): Promise<ChecklistItem>;
  list(context: WorkContext, taskId: Id): Promise<ChecklistItem[]>;
}

export interface WorkLogProvider {
  record(
    context: WorkContext,
    input: Omit<WorkLog, "id" | "durationMinutes">,
  ): Promise<WorkLog>;
  listForCase(context: WorkContext, caseId: Id): Promise<WorkLog[]>;
  totalMinutes(context: WorkContext, input: { caseId?: Id; taskId?: Id }): Promise<number>;
}
