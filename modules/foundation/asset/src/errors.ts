export type AssetErrorCode =
  | "ASSET_NOT_FOUND"
  | "BLOB_NOT_FOUND"
  | "INFECTED_BLOB"
  | "LEGAL_HOLD_ACTIVE"
  | "ASSET_DELETED"
  | "ASSET_NOT_DELETED"
  | "COLLECTION_NOT_FOUND";

export class AssetError extends Error {
  constructor(readonly code: AssetErrorCode, message: string) {
    super(message);
    this.name = "AssetError";
  }
}
