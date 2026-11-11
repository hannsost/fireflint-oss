import type { Case, CaseParticipant, CaseProvider, ChecklistItem, ChecklistProvider, Decision, DecisionProvider, NoteProvider, ParticipantProvider, QueueProvider, SlaProvider, SlaStatus, SlaTarget, Task, TaskDependency, TaskProvider, WorkContext, WorkLog, WorkLogProvider, WorkNote, WorkQueue } from "./contracts.js";
import { WorkError } from "./errors.js";

export class ReferenceWorkStore {
  readonly cases = new Map<string, Case>();
  readonly tasks = new Map<string, Task>();
  readonly decisions: Decision[] = [];
  readonly queues = new Map<string, WorkQueue>();
  readonly dependencies: TaskDependency[] = [];
  readonly slaTargets: SlaTarget[] = [];
  readonly notes: WorkNote[] = [];
  readonly participants: CaseParticipant[] = [];
  readonly checklistItems: ChecklistItem[] = [];
  readonly workLogs: WorkLog[] = [];
  #sequence = 0;
  readonly caseProvider: CaseProvider = {
    create: async (context, input) => {
      const now = new Date().toISOString();
      const value: Case = { ...structuredClone(input), id: this.next("case"), organizationId: context.organizationId, state: "open", createdAt: now, updatedAt: now };
      this.cases.set(value.id, value);
      return structuredClone(value);
    },
    get: async (context, id) => {
      const value = this.cases.get(id);
      return value?.organizationId === context.organizationId ? structuredClone(value) : null;
    },
    transition: async (context, id, target) => {
      const value = this.requireCase(context, id);
      const allowed: Record<Case["state"], Case["state"][]> = {
        open: ["on_hold", "resolved", "cancelled"],
        on_hold: ["open", "resolved", "cancelled"],
        resolved: ["open", "closed"],
        closed: [],
        cancelled: [],
      };
      if (!allowed[value.state].includes(target)) throw new WorkError("INVALID_TRANSITION", `Cannot move case ${value.state} -> ${target}`);
      value.state = target;
      value.updatedAt = new Date().toISOString();
      return structuredClone(value);
    },
  };
  readonly taskProvider: TaskProvider = {
    create: async (context, input) => {
      if (input.caseId) this.requireCase(context, input.caseId);
      const value: Task = { ...structuredClone(input), id: this.next("task"), organizationId: context.organizationId, state: "open", createdAt: new Date().toISOString() };
      this.tasks.set(value.id, value);
      return structuredClone(value);
    },
    get: async (context, id) => {
      const value = this.tasks.get(id);
      return value?.organizationId === context.organizationId ? structuredClone(value) : null;
    },
    assign: async (context, id, input) => {
      const value = this.requireTask(context, id);
      if (!!input.principalId === !!input.groupId) throw new WorkError("INVALID_ASSIGNMENT", "Assign exactly one principal or group");
      value.assigneePrincipalId = input.principalId;
      value.assigneeGroupId = input.groupId;
      return structuredClone(value);
    },
    transition: async (context, id, target) => {
      const value = this.requireTask(context, id);
      const allowed: Record<Task["state"], Task["state"][]> = {
        open: ["in_progress", "blocked", "completed", "cancelled"],
        in_progress: ["blocked", "completed", "cancelled"],
        blocked: ["open", "in_progress", "cancelled"],
        completed: [],
        cancelled: [],
      };
      if (!allowed[value.state].includes(target)) throw new WorkError("INVALID_TRANSITION", `Cannot move task ${value.state} -> ${target}`);
      if (
        target === "completed" &&
        this.checklistItems.some(
          (item) =>
            item.taskId === id &&
            item.required &&
            !item.completed,
        )
      ) {
        throw new WorkError(
          "DEPENDENCY_BLOCKED",
          "Required checklist items are incomplete",
        );
      }
      if (
        ["in_progress", "completed"].includes(target) &&
        this.dependencies.some(
          (dependency) =>
            dependency.taskId === id &&
            this.tasks.get(dependency.dependsOnTaskId)?.state !== "completed",
        )
      ) {
        throw new WorkError(
          "DEPENDENCY_BLOCKED",
          "Task has incomplete dependencies",
        );
      }
      value.state = target;
      if (target === "completed") value.completedAt = new Date().toISOString();
      return structuredClone(value);
    },
    overdue: async (context, at = new Date().toISOString()) =>
      [...this.tasks.values()]
        .filter((task) => task.organizationId === context.organizationId && !["completed", "cancelled"].includes(task.state))
        .filter((task) => !!task.dueAt && new Date(task.dueAt) < new Date(at))
        .map((task) => structuredClone(task)),
    addDependency: async (context, input) => {
      this.requireTask(context, input.taskId);
      this.requireTask(context, input.dependsOnTaskId);
      if (input.taskId === input.dependsOnTaskId) {
        throw new WorkError("DEPENDENCY_BLOCKED", "Task cannot depend on itself");
      }
      const value = { ...structuredClone(input), id: this.next("dependency") };
      this.dependencies.push(value);
      return structuredClone(value);
    },
    dependencies: async (_context, taskId) =>
      this.dependencies
        .filter((item) => item.taskId === taskId)
        .map((item) => structuredClone(item)),
  };
  readonly decisionProvider: DecisionProvider = {
    record: async (context, input) => {
      if (input.caseId) this.requireCase(context, input.caseId);
      if (input.taskId) this.requireTask(context, input.taskId);
      const value = { ...structuredClone(input), id: this.next("decision"), decidedAt: new Date().toISOString() };
      this.decisions.push(value);
      return structuredClone(value);
    },
    listForCase: async (_context, caseId) => this.decisions.filter((item) => item.caseId === caseId).map((item) => structuredClone(item)),
  };
  readonly queueProvider: QueueProvider = {
    create: async (context, input) => {
      const value: WorkQueue = {
        ...structuredClone(input),
        id: this.next("queue"),
        organizationId: context.organizationId,
      };
      this.queues.set(value.id, value);
      return structuredClone(value);
    },
    enqueue: async (context, queueId, taskId) => {
      const queue = this.requireQueue(context, queueId);
      const task = this.requireTask(context, taskId);
      if (
        queue.acceptedTaskTypes?.length &&
        !queue.acceptedTaskTypes.includes(task.type)
      ) {
        throw new WorkError("INVALID_ASSIGNMENT", "Queue rejects task type");
      }
      task.queueId = queue.id;
      task.assigneePrincipalId = undefined;
      return structuredClone(task);
    },
    claim: async (context, queueId, taskId, principalId) => {
      this.requireQueue(context, queueId);
      const task = this.requireTask(context, taskId);
      if (task.queueId !== queueId) {
        throw new WorkError("INVALID_ASSIGNMENT", "Task is not in queue");
      }
      task.assigneePrincipalId = principalId;
      task.queueId = undefined;
      return structuredClone(task);
    },
    list: async (context, queueId) => {
      this.requireQueue(context, queueId);
      return [...this.tasks.values()]
        .filter(
          (task) =>
            task.organizationId === context.organizationId &&
            task.queueId === queueId,
        )
        .map((task) => structuredClone(task));
    },
  };
  readonly slaProvider: SlaProvider = {
    addTarget: async (_context, input) => {
      const value = { ...structuredClone(input), id: this.next("sla") };
      this.slaTargets.push(value);
      return structuredClone(value);
    },
    status: async (context, taskId, at = new Date().toISOString()) => {
      const task = this.requireTask(context, taskId);
      const target = this.matchSla(task);
      return target ? this.slaStatus(task, target, at) : null;
    },
    escalateBreaches: async (context, at = new Date().toISOString()) => {
      const escalated: Task[] = [];
      for (const task of this.tasks.values()) {
        if (
          task.organizationId !== context.organizationId ||
          ["completed", "cancelled"].includes(task.state)
        ) continue;
        const target = this.matchSla(task);
        if (!target) continue;
        const status = this.slaStatus(task, target, at);
        if (status.resolutionBreached && target.escalationQueueId) {
          task.queueId = target.escalationQueueId;
          task.assigneePrincipalId = undefined;
          escalated.push(structuredClone(task));
        }
      }
      return escalated;
    },
  };
  readonly noteProvider: NoteProvider = {
    add: async (context, input) => {
      if (input.caseId) this.requireCase(context, input.caseId);
      if (input.taskId) this.requireTask(context, input.taskId);
      if (!input.caseId && !input.taskId) {
        throw new WorkError("INVALID_ASSIGNMENT", "Note needs case or task");
      }
      const value = {
        ...structuredClone(input),
        id: this.next("note"),
        createdAt: new Date().toISOString(),
      };
      this.notes.push(value);
      return structuredClone(value);
    },
    listForCase: async (_context, caseId) =>
      this.notes
        .filter((item) => item.caseId === caseId)
        .map((item) => structuredClone(item)),
    listForTask: async (_context, taskId) =>
      this.notes
        .filter((item) => item.taskId === taskId)
        .map((item) => structuredClone(item)),
  };
  readonly participantProvider: ParticipantProvider = {
    add: async (context, input) => {
      this.requireCase(context, input.caseId);
      if (!!input.partyId === !!input.principalId) {
        throw new WorkError(
          "INVALID_ASSIGNMENT",
          "Participant needs exactly one party or principal",
        );
      }
      const value: CaseParticipant = {
        ...structuredClone(input),
        id: this.next("participant"),
        addedAt: new Date().toISOString(),
      };
      this.participants.push(value);
      return structuredClone(value);
    },
    remove: async (context, participantId) => {
      const value = this.participants.find(
        (item) => item.id === participantId,
      );
      if (!value) {
        throw new WorkError("PARTICIPANT_NOT_FOUND", "Participant not found");
      }
      this.requireCase(context, value.caseId);
      value.removedAt = new Date().toISOString();
      return structuredClone(value);
    },
    list: async (context, caseId, at = new Date().toISOString()) => {
      this.requireCase(context, caseId);
      const point = new Date(at);
      return this.participants
        .filter((item) => item.caseId === caseId)
        .filter(
          (item) =>
            new Date(item.addedAt) <= point &&
            (!item.removedAt || new Date(item.removedAt) > point),
        )
        .map((item) => structuredClone(item));
    },
  };
  readonly checklistProvider: ChecklistProvider = {
    add: async (context, input) => {
      this.requireTask(context, input.taskId);
      const value: ChecklistItem = {
        ...structuredClone(input),
        id: this.next("checklist"),
        completed: false,
      };
      this.checklistItems.push(value);
      return structuredClone(value);
    },
    complete: async (context, itemId, principalId) => {
      const value = this.checklistItems.find((item) => item.id === itemId);
      if (!value) {
        throw new WorkError("CHECKLIST_NOT_FOUND", "Checklist item not found");
      }
      this.requireTask(context, value.taskId);
      value.completed = true;
      value.completedByPrincipalId = principalId;
      value.completedAt = new Date().toISOString();
      return structuredClone(value);
    },
    list: async (context, taskId) => {
      this.requireTask(context, taskId);
      return this.checklistItems
        .filter((item) => item.taskId === taskId)
        .map((item) => structuredClone(item));
    },
  };
  readonly workLogProvider: WorkLogProvider = {
    record: async (context, input) => {
      if (input.caseId) this.requireCase(context, input.caseId);
      if (input.taskId) this.requireTask(context, input.taskId);
      if (!input.caseId && !input.taskId) {
        throw new WorkError("INVALID_WORK_LOG", "Work log needs case or task");
      }
      const durationMinutes = Math.round(
        (new Date(input.endedAt).getTime() -
          new Date(input.startedAt).getTime()) /
          60_000,
      );
      if (durationMinutes <= 0) {
        throw new WorkError("INVALID_WORK_LOG", "Work log duration must be positive");
      }
      const value: WorkLog = {
        ...structuredClone(input),
        id: this.next("work-log"),
        durationMinutes,
      };
      this.workLogs.push(value);
      return structuredClone(value);
    },
    listForCase: async (context, caseId) => {
      this.requireCase(context, caseId);
      return this.workLogs
        .filter((item) => item.caseId === caseId)
        .map((item) => structuredClone(item));
    },
    totalMinutes: async (_context, input) =>
      this.workLogs
        .filter((item) => !input.caseId || item.caseId === input.caseId)
        .filter((item) => !input.taskId || item.taskId === input.taskId)
        .reduce((sum, item) => sum + item.durationMinutes, 0),
  };
  private requireCase(context: WorkContext, id: string): Case {
    const value = this.cases.get(id);
    if (!value || value.organizationId !== context.organizationId) throw new WorkError("CASE_NOT_FOUND", `Case '${id}' not found`);
    return value;
  }
  private requireTask(context: WorkContext, id: string): Task {
    const value = this.tasks.get(id);
    if (!value || value.organizationId !== context.organizationId) throw new WorkError("TASK_NOT_FOUND", `Task '${id}' not found`);
    return value;
  }
  private requireQueue(context: WorkContext, id: string): WorkQueue {
    const value = this.queues.get(id);
    if (!value || value.organizationId !== context.organizationId) {
      throw new WorkError("QUEUE_NOT_FOUND", `Queue '${id}' not found`);
    }
    return value;
  }
  private matchSla(task: Task): SlaTarget | undefined {
    return this.slaTargets.find(
      (target) =>
        (!target.taskType || target.taskType === task.type) &&
        (!target.priority || target.priority === task.priority),
    );
  }
  private slaStatus(
    task: Task,
    target: SlaTarget,
    at: string,
  ): SlaStatus {
    const created = new Date(task.createdAt).getTime();
    const responseDueAt = new Date(
      created + target.responseMinutes * 60_000,
    ).toISOString();
    const resolutionDueAt = new Date(
      created + target.resolutionMinutes * 60_000,
    ).toISOString();
    return {
      taskId: task.id,
      responseDueAt,
      resolutionDueAt,
      responseBreached:
        task.state === "open" && new Date(at) > new Date(responseDueAt),
      resolutionBreached:
        !["completed", "cancelled"].includes(task.state) &&
        new Date(at) > new Date(resolutionDueAt),
    };
  }
  private next(prefix: string): string {
    this.#sequence += 1;
    return `${prefix}-${this.#sequence}`;
  }
}
