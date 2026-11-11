export type ResourceErrorCode = "RESOURCE_NOT_FOUND" | "POOL_NOT_FOUND" | "RESOURCE_UNAVAILABLE" | "CAPACITY_EXCEEDED" | "INVALID_TIME_RANGE" | "RESERVATION_NOT_FOUND";
export class ResourceError extends Error {
  constructor(readonly code: ResourceErrorCode, message: string) {
    super(message);
    this.name = "ResourceError";
  }
}
