export type Id = string;
export type IsoDateTime = string;
export interface ResourceContext {
  organizationId: Id;
  correlationId: string;
  principalId?: Id;
}
export interface Resource {
  id: Id;
  organizationId: Id;
  type: string;
  name: string;
  status: "active" | "inactive" | "maintenance" | "retired";
  locationPartyId?: Id;
  responsiblePartyId?: Id;
  timezone: string;
  capacity: number;
  attributes?: Record<string, string | number | boolean>;
}

export interface ResourcePool {
  id: Id;
  organizationId: Id;
  key: string;
  name: string;
  resourceIds: Id[];
  selection: "any" | "all";
}
export interface TimeRange {
  start: IsoDateTime;
  end: IsoDateTime;
}
export interface AvailabilityRule {
  id: Id;
  resourceId: Id;
  weekdays: number[];
  localStart: string;
  localEnd: string;
  validFrom?: string;
  validUntil?: string;
  capacity?: number;
}
export interface Blackout {
  id: Id;
  resourceId: Id;
  range: TimeRange;
  reason: string;
  capacityReduction?: number;
}

export interface CalendarException {
  id: Id;
  resourceId: Id;
  range: TimeRange;
  mode: "available" | "unavailable";
  capacityOverride?: number;
  reason?: string;
}
export interface Reservation {
  id: Id;
  organizationId: Id;
  resourceId: Id;
  range: TimeRange;
  quantity: number;
  state: "held" | "confirmed" | "cancelled" | "expired";
  partyId?: Id;
  domainRef?: { domain: string; type: string; id: Id };
  expiresAt?: IsoDateTime;
  createdAt: IsoDateTime;
}

export interface AllocationRequest {
  resourceId?: Id;
  poolId?: Id;
  range: TimeRange;
  quantity: number;
  partyId?: Id;
  domainRef?: Reservation["domainRef"];
  expiresAt?: IsoDateTime;
}

export interface AllocationResult {
  reservations: Reservation[];
  selectedResourceIds: Id[];
}
export interface AvailabilityResult {
  resourceId: Id;
  range: TimeRange;
  totalCapacity: number;
  reservedCapacity: number;
  availableCapacity: number;
  available: boolean;
  conflicts: Id[];
}

export interface ResourceRequirement {
  type?: string;
  locationPartyId?: Id;
  attributes?: Record<string, string | number | boolean>;
  minimumCapacity?: number;
}
export interface ResourceProvider {
  create(context: ResourceContext, input: Omit<Resource, "id" | "organizationId" | "status">): Promise<Resource>;
  get(context: ResourceContext, resourceId: Id): Promise<Resource | null>;
  setStatus(context: ResourceContext, resourceId: Id, status: Resource["status"]): Promise<Resource>;
  createPool(
    context: ResourceContext,
    input: Omit<ResourcePool, "id" | "organizationId">,
  ): Promise<ResourcePool>;
  getPool(context: ResourceContext, poolId: Id): Promise<ResourcePool | null>;
}
export interface CalendarProvider {
  addRule(context: ResourceContext, rule: Omit<AvailabilityRule, "id">): Promise<AvailabilityRule>;
  addBlackout(context: ResourceContext, blackout: Omit<Blackout, "id">): Promise<Blackout>;
  addException(
    context: ResourceContext,
    exception: Omit<CalendarException, "id">,
  ): Promise<CalendarException>;
  availability(context: ResourceContext, resourceId: Id, range: TimeRange, quantity?: number): Promise<AvailabilityResult>;
}
export interface ReservationProvider {
  hold(context: ResourceContext, input: Omit<Reservation, "id" | "organizationId" | "state" | "createdAt">): Promise<Reservation>;
  confirm(context: ResourceContext, reservationId: Id): Promise<Reservation>;
  cancel(context: ResourceContext, reservationId: Id): Promise<Reservation>;
  reschedule(
    context: ResourceContext,
    reservationId: Id,
    range: TimeRange,
  ): Promise<Reservation>;
  list(context: ResourceContext, resourceId: Id, range?: TimeRange): Promise<Reservation[]>;
  expireHolds(context: ResourceContext, at?: IsoDateTime): Promise<Reservation[]>;
}

export interface AllocationProvider {
  allocate(
    context: ResourceContext,
    requests: AllocationRequest[],
  ): Promise<AllocationResult>;
  alternatives(
    context: ResourceContext,
    poolId: Id,
    range: TimeRange,
    quantity?: number,
  ): Promise<AvailabilityResult[]>;
}

export interface ResourceSearchProvider {
  available(
    context: ResourceContext,
    requirement: ResourceRequirement,
    range: TimeRange,
    quantity?: number,
  ): Promise<AvailabilityResult[]>;
}
