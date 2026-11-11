export type PartyErrorCode = "PARTY_NOT_FOUND" | "IDENTIFIER_CONFLICT" | "MERGE_CONFLICT" | "INVALID_RELATIONSHIP";
export class PartyError extends Error {
  constructor(readonly code: PartyErrorCode, message: string) {
    super(message);
    this.name = "PartyError";
  }
}
