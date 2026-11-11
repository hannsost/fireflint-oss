export type AccessErrorCode = "PRINCIPAL_NOT_FOUND" | "GROUP_NOT_FOUND" | "ROLE_NOT_FOUND" | "POLICY_NOT_FOUND" | "EXTERNAL_IDENTITY_CONFLICT" | "EXTERNAL_IDENTITY_NOT_FOUND" | "GRANT_NOT_FOUND" | "ACCESS_DENIED" | "INVALID_DELEGATION";
export class AccessError extends Error {
  constructor(readonly code: AccessErrorCode, message: string) {
    super(message);
    this.name = "AccessError";
  }
}
