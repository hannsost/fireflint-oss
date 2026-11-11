export const commerceErrorCodes = [
  "PRODUCT_NOT_FOUND",
  "PRICE_UNAVAILABLE",
  "INSUFFICIENT_STOCK",
  "CART_NOT_FOUND",
  "CART_NOT_OPEN",
  "CUSTOMER_NOT_FOUND",
  "CUSTOMER_ORGANIZATION_REQUIRED",
  "CONTRACT_NOT_FOUND",
  "CONTRACT_VIOLATION",
  "BUDGET_EXCEEDED",
  "APPROVAL_REQUIRED",
  "APPROVAL_NOT_FOUND",
  "PAYMENT_FAILED",
  "ORDER_NOT_FOUND",
  "INVALID_STATE_TRANSITION",
  "IDEMPOTENCY_KEY_REQUIRED",
  "IDEMPOTENCY_CONFLICT",
  "VALIDATION_FAILED",
] as const;

export type CommerceErrorCode = (typeof commerceErrorCodes)[number];

export class CommerceError extends Error {
  readonly code: CommerceErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: CommerceErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CommerceError";
    this.code = code;
    this.details = details;
  }
}

export function isCommerceError(error: unknown): error is CommerceError {
  return error instanceof CommerceError;
}
