export type EventErrorCode =
  | "STREAM_VERSION_CONFLICT"
  | "SCHEMA_INCOMPATIBLE"
  | "INBOX_NOT_FOUND"
  | "OUTBOX_NOT_FOUND";

export class EventError extends Error {
  constructor(
    readonly code: EventErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "EventError";
  }
}
