export const privacyErrorCodes = [
  "SUBJECT_NOT_FOUND",
  "IDENTITY_NOT_VERIFIED",
  "REQUEST_NOT_FOUND",
  "REQUEST_DEADLINE_EXCEEDED",
  "DISCOVERY_FAILED",
  "EXPORT_FAILED",
  "ERASURE_BLOCKED",
  "LEGAL_HOLD_ACTIVE",
  "RETENTION_REQUIRED",
  "CONSENT_NOT_FOUND",
  "PROCESSING_NOT_DOCUMENTED",
  "DPIA_REQUIRED",
  "TRANSFER_ASSESSMENT_REQUIRED",
  "BREACH_NOT_FOUND",
  "HUMAN_REVIEW_REQUIRED",
  "IDEMPOTENCY_KEY_REQUIRED",
] as const;
export type PrivacyErrorCode = (typeof privacyErrorCodes)[number];
export class PrivacyError extends Error {
  constructor(readonly code: PrivacyErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "PrivacyError";
  }
}
