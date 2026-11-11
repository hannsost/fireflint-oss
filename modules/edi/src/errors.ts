export const ediErrorCodes = [
  "PARTNER_NOT_FOUND",
  "AGREEMENT_NOT_FOUND",
  "AGREEMENT_INACTIVE",
  "PROFILE_NOT_ALLOWED",
  "ENDPOINT_NOT_FOUND",
  "SIGNATURE_INVALID",
  "DECRYPTION_FAILED",
  "SYNTAX_DETECTION_FAILED",
  "PARSE_FAILED",
  "VALIDATION_FAILED",
  "MAPPING_FAILED",
  "ROUTING_FAILED",
  "TRANSPORT_FAILED",
  "ACKNOWLEDGEMENT_TIMEOUT",
  "DUPLICATE_MESSAGE",
  "IDEMPOTENCY_KEY_REQUIRED",
  "IDEMPOTENCY_CONFLICT",
  "ARCHIVE_FAILED",
  "MESSAGE_NOT_FOUND",
  "REPLAY_NOT_ALLOWED",
] as const;

export type EdiErrorCode = (typeof ediErrorCodes)[number];

export class EdiError extends Error {
  constructor(
    readonly code: EdiErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "EdiError";
  }
}
