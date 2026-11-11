export type WorkErrorCode = "CASE_NOT_FOUND" | "TASK_NOT_FOUND" | "QUEUE_NOT_FOUND" | "PARTICIPANT_NOT_FOUND" | "CHECKLIST_NOT_FOUND" | "INVALID_TRANSITION" | "INVALID_ASSIGNMENT" | "INVALID_WORK_LOG" | "DEPENDENCY_BLOCKED";
export class WorkError extends Error {
  constructor(readonly code: WorkErrorCode, message: string) {
    super(message);
    this.name = "WorkError";
  }
}
