export const formsErrorCodes = [
  "FORM_NOT_FOUND",
  "FORM_NOT_PUBLISHED",
  "VALIDATION_FAILED",
  "SPAM_REJECTED",
  "FILE_REJECTED",
  "MALWARE_DETECTED",
  "CONSENT_REQUIRED",
  "SIGNATURE_REQUIRED",
  "SUBMISSION_NOT_FOUND",
  "SUBMISSION_NOT_EDITABLE",
  "WORKFLOW_NOT_FOUND",
  "TRANSITION_NOT_ALLOWED",
  "AUTHENTICATION_REQUIRED",
  "ORGANIZATION_CONTEXT_REQUIRED",
  "IDEMPOTENCY_KEY_REQUIRED",
  "IDEMPOTENCY_CONFLICT",
  "RETENTION_POLICY_NOT_FOUND",
  "INTEGRATION_FAILED",
] as const;

export type FormsErrorCode = (typeof formsErrorCodes)[number];

export class FormsError extends Error {
  constructor(
    readonly code: FormsErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FormsError";
  }
}

export function isFormsError(error: unknown): error is FormsError {
  return error instanceof FormsError;
}
