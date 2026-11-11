import type { AllocationProvider, AvailabilityRule, Blackout, CalendarException, CalendarProvider, Reservation, ReservationProvider, Resource, ResourceContext, ResourcePool, ResourceProvider, ResourceSearchProvider, TimeRange } from "./contracts.js";
import { ResourceError } from "./errors.js";

export class ReferenceResourceStore {
  readonly resources = new Map<string, Resource>();
  readonly rules: AvailabilityRule[] = [];
  readonly blackouts: Blackout[] = [];
  readonly exceptions: CalendarException[] = [];
  readonly reservations = new Map<string, Reservation>();
  readonly pools = new Map<string, ResourcePool>();
  #sequence = 0;
  readonly resource: ResourceProvider = {
    create: async (context, input) => {
      if (input.capacity < 1) throw new ResourceError("CAPACITY_EXCEEDED", "Capacity must be positive");
      const value: Resource = { ...structuredClone(input), id: this.next("resource"), organizationId: context.organizationId, status: "active" };
      this.resources.set(value.id, value);
      return structuredClone(value);
    },
    get: async (context, id) => {
      const value = this.resources.get(id);
      return value?.organizationId === context.organizationId ? structuredClone(value) : null;
    },
    setStatus: async (context, id, status) => {
      const value = this.requireResource(context, id);
      value.status = status;
      return structuredClone(value);
    },
    createPool: async (context, input) => {
      for (const resourceId of input.resourceIds) {
        this.requireResource(context, resourceId);
      }
      const value: ResourcePool = {
        ...structuredClone(input),
        id: this.next("pool"),
        organizationId: context.organizationId,
      };
      this.pools.set(value.id, value);
      return structuredClone(value);
    },
    getPool: async (context, poolId) => {
      const value = this.pools.get(poolId);
      return value?.organizationId === context.organizationId
        ? structuredClone(value)
        : null;
    },
  };
  readonly calendar: CalendarProvider = {
    addRule: async (context, input) => {
      this.requireResource(context, input.resourceId);
      const value = { ...structuredClone(input), id: this.next("rule") };
      this.rules.push(value);
      return structuredClone(value);
    },
    addBlackout: async (context, input) => {
      this.requireResource(context, input.resourceId);
      this.assertRange(input.range);
      const value = { ...structuredClone(input), id: this.next("blackout") };
      this.blackouts.push(value);
      return structuredClone(value);
    },
    addException: async (context, input) => {
      this.requireResource(context, input.resourceId);
      this.assertRange(input.range);
      const value = { ...structuredClone(input), id: this.next("exception") };
      this.exceptions.push(value);
      return structuredClone(value);
    },
    availability: async (context, resourceId, range, quantity = 1) => {
      this.assertRange(range);
      const resource = this.requireResource(context, resourceId);
      const exceptions = this.exceptions.filter(
        (item) =>
          item.resourceId === resourceId && this.overlaps(item.range, range),
      );
      const unavailableException = exceptions.some(
        (item) => item.mode === "unavailable",
      );
      const availableException = [...exceptions]
        .reverse()
        .find((item) => item.mode === "available");
      const rules = this.rules.filter((item) => item.resourceId === resourceId);
      const withinRules =
        !!availableException ||
        rules.length === 0 ||
        rules.some((rule) => this.ruleAllows(resource, rule, range, quantity));
      const overlaps = [...this.reservations.values()].filter(
        (item) =>
          item.resourceId === resourceId &&
          ["held", "confirmed"].includes(item.state) &&
          (!item.expiresAt || new Date(item.expiresAt) > new Date()) &&
          this.overlaps(item.range, range),
      );
      const reserved = overlaps.reduce((sum, item) => sum + item.quantity, 0);
      const reduction = this.blackouts
        .filter((item) => item.resourceId === resourceId && this.overlaps(item.range, range))
        .reduce((sum, item) => sum + (item.capacityReduction ?? resource.capacity), 0);
      const baseCapacity =
        availableException?.capacityOverride ?? resource.capacity;
      const availableCapacity = Math.max(0, baseCapacity - reduction - reserved);
      return {
        resourceId, range: structuredClone(range), totalCapacity: resource.capacity,
        reservedCapacity: reserved, availableCapacity,
        available:
          resource.status === "active" &&
          !unavailableException &&
          withinRules &&
          availableCapacity >= quantity,
        conflicts: overlaps.map((item) => item.id),
      };
    },
  };
  readonly reservation: ReservationProvider = {
    hold: async (context, input) => {
      const availability = await this.calendar.availability(context, input.resourceId, input.range, input.quantity);
      if (!availability.available) throw new ResourceError("RESOURCE_UNAVAILABLE", "Resource has insufficient availability");
      const value: Reservation = {
        ...structuredClone(input), id: this.next("reservation"),
        organizationId: context.organizationId, state: "held", createdAt: new Date().toISOString(),
      };
      this.reservations.set(value.id, value);
      return structuredClone(value);
    },
    confirm: async (context, id) => {
      const value = this.requireReservation(context, id);
      if (value.state !== "held") throw new ResourceError("RESOURCE_UNAVAILABLE", "Only held reservations can be confirmed");
      value.state = "confirmed";
      return structuredClone(value);
    },
    cancel: async (context, id) => {
      const value = this.requireReservation(context, id);
      value.state = "cancelled";
      return structuredClone(value);
    },
    reschedule: async (context, id, range) => {
      this.assertRange(range);
      const value = this.requireReservation(context, id);
      if (!["held", "confirmed"].includes(value.state)) {
        throw new ResourceError(
          "RESOURCE_UNAVAILABLE",
          "Only active reservations can be rescheduled",
        );
      }
      const originalRange = structuredClone(value.range);
      const originalState = value.state;
      value.state = "cancelled";
      const availability = await this.calendar.availability(
        context,
        value.resourceId,
        range,
        value.quantity,
      );
      if (!availability.available) {
        value.state = originalState;
        value.range = originalRange;
        throw new ResourceError(
          "RESOURCE_UNAVAILABLE",
          "New reservation range is unavailable",
        );
      }
      value.range = structuredClone(range);
      value.state = originalState;
      return structuredClone(value);
    },
    list: async (context, resourceId, range) =>
      [...this.reservations.values()]
        .filter((item) => item.organizationId === context.organizationId && item.resourceId === resourceId)
        .filter((item) => !range || this.overlaps(item.range, range))
        .map((item) => structuredClone(item)),
    expireHolds: async (context, at = new Date().toISOString()) => {
      const expired = [...this.reservations.values()].filter(
        (item) =>
          item.organizationId === context.organizationId &&
          item.state === "held" &&
          !!item.expiresAt &&
          new Date(item.expiresAt) <= new Date(at),
      );
      for (const item of expired) item.state = "expired";
      return expired.map((item) => structuredClone(item));
    },
  };
  readonly allocation: AllocationProvider = {
    allocate: async (context, requests) => {
      const selected: Array<{
        resourceId: string;
        request: typeof requests[number];
      }> = [];
      for (const request of requests) {
        if (!!request.resourceId === !!request.poolId) {
          throw new ResourceError(
            "RESOURCE_UNAVAILABLE",
            "Specify exactly one resource or pool",
          );
        }
        if (request.resourceId) {
          const available = await this.calendar.availability(
            context,
            request.resourceId,
            request.range,
            request.quantity,
          );
          if (!available.available) {
            throw new ResourceError(
              "RESOURCE_UNAVAILABLE",
              `Resource '${request.resourceId}' unavailable`,
            );
          }
          selected.push({ resourceId: request.resourceId, request });
          continue;
        }
        const pool = this.requirePool(context, request.poolId!);
        const candidates: string[] = [];
        for (const resourceId of pool.resourceIds) {
          const available = await this.calendar.availability(
            context,
            resourceId,
            request.range,
            request.quantity,
          );
          if (available.available) candidates.push(resourceId);
        }
        const chosen =
          pool.selection === "all"
            ? candidates.length === pool.resourceIds.length
              ? candidates
              : []
            : candidates.slice(0, 1);
        if (chosen.length === 0) {
          throw new ResourceError(
            "RESOURCE_UNAVAILABLE",
            `Pool '${pool.id}' has no suitable resources`,
          );
        }
        for (const resourceId of chosen) selected.push({ resourceId, request });
      }
      const reservations: Reservation[] = [];
      try {
        for (const item of selected) {
          reservations.push(
            await this.reservation.hold(context, {
              resourceId: item.resourceId,
              range: item.request.range,
              quantity: item.request.quantity,
              partyId: item.request.partyId,
              domainRef: item.request.domainRef,
              expiresAt: item.request.expiresAt,
            }),
          );
        }
      } catch (error) {
        for (const reservation of reservations) {
          await this.reservation.cancel(context, reservation.id);
        }
        throw error;
      }
      return {
        reservations,
        selectedResourceIds: reservations.map((item) => item.resourceId),
      };
    },
    alternatives: async (context, poolId, range, quantity = 1) => {
      const pool = this.requirePool(context, poolId);
      const results = await Promise.all(
        pool.resourceIds.map((resourceId) =>
          this.calendar.availability(context, resourceId, range, quantity),
        ),
      );
      return results
        .filter((item) => item.available)
        .sort((left, right) => right.availableCapacity - left.availableCapacity);
    },
  };
  readonly search: ResourceSearchProvider = {
    available: async (context, requirement, range, quantity = 1) => {
      const resources = [...this.resources.values()]
        .filter((item) => item.organizationId === context.organizationId)
        .filter((item) => !requirement.type || item.type === requirement.type)
        .filter(
          (item) =>
            !requirement.locationPartyId ||
            item.locationPartyId === requirement.locationPartyId,
        )
        .filter(
          (item) =>
            !requirement.minimumCapacity ||
            item.capacity >= requirement.minimumCapacity,
        )
        .filter((item) =>
          Object.entries(requirement.attributes ?? {}).every(
            ([key, value]) => item.attributes?.[key] === value,
          ),
        );
      const results = await Promise.all(
        resources.map((resource) =>
          this.calendar.availability(context, resource.id, range, quantity),
        ),
      );
      return results.filter((item) => item.available);
    },
  };
  private requireResource(context: ResourceContext, id: string): Resource {
    const value = this.resources.get(id);
    if (!value || value.organizationId !== context.organizationId) throw new ResourceError("RESOURCE_NOT_FOUND", `Resource '${id}' not found`);
    return value;
  }
  private requireReservation(context: ResourceContext, id: string): Reservation {
    const value = this.reservations.get(id);
    if (!value || value.organizationId !== context.organizationId) throw new ResourceError("RESERVATION_NOT_FOUND", `Reservation '${id}' not found`);
    return value;
  }
  private requirePool(context: ResourceContext, id: string): ResourcePool {
    const value = this.pools.get(id);
    if (!value || value.organizationId !== context.organizationId) {
      throw new ResourceError("POOL_NOT_FOUND", `Pool '${id}' not found`);
    }
    return value;
  }
  private assertRange(range: TimeRange): void {
    if (new Date(range.end) <= new Date(range.start)) throw new ResourceError("INVALID_TIME_RANGE", "End must be after start");
  }
  private overlaps(left: TimeRange, right: TimeRange): boolean {
    return new Date(left.start) < new Date(right.end) && new Date(right.start) < new Date(left.end);
  }
  private ruleAllows(
    resource: Resource,
    rule: AvailabilityRule,
    range: TimeRange,
    quantity: number,
  ): boolean {
    const start = this.localParts(range.start, resource.timezone);
    const end = this.localParts(range.end, resource.timezone);
    if (start.date !== end.date) return false;
    if (!rule.weekdays.includes(start.weekday)) return false;
    if (rule.validFrom && start.date < rule.validFrom) return false;
    if (rule.validUntil && start.date > rule.validUntil) return false;
    if (start.time < rule.localStart || end.time > rule.localEnd) return false;
    return (rule.capacity ?? resource.capacity) >= quantity;
  }
  private localParts(value: string, timezone: string): {
    date: string;
    time: string;
    weekday: number;
  } {
    const date = new Date(value);
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    });
    const parts = Object.fromEntries(
      formatter.formatToParts(date).map((part) => [part.type, part.value]),
    );
    const weekdays: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      time: `${parts.hour}:${parts.minute}`,
      weekday: weekdays[parts.weekday] ?? date.getUTCDay(),
    };
  }
  private next(prefix: string): string {
    this.#sequence += 1;
    return `${prefix}-${this.#sequence}`;
  }
}
