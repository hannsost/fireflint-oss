import assert from "node:assert/strict";
import test from "node:test";
import { ReferenceResourceStore } from "../dist/index.js";

const context = { organizationId: "tenant-1", correlationId: "resource-test" };
const range = { start: "2026-07-01T12:00:00.000Z", end: "2026-07-03T10:00:00.000Z" };

test("same model represents hotel room and warehouse dock", async () => {
  const store = new ReferenceResourceStore();
  const room = await store.resource.create(context, { type: "hotel_room", name: "Room 101", timezone: "Europe/Berlin", capacity: 1 });
  const dock = await store.resource.create(context, { type: "warehouse_dock", name: "Dock A", timezone: "Europe/Berlin", capacity: 2 });
  assert.equal(room.type, "hotel_room");
  assert.equal(dock.capacity, 2);
});
test("reservation prevents overbooking", async () => {
  const store = new ReferenceResourceStore();
  const resource = await store.resource.create(context, { type: "room", name: "Room", timezone: "Europe/Berlin", capacity: 1 });
  await store.reservation.hold(context, { resourceId: resource.id, range, quantity: 1, partyId: "party-guest" });
  await assert.rejects(
    store.reservation.hold(context, { resourceId: resource.id, range, quantity: 1 }),
    (error) => error?.code === "RESOURCE_UNAVAILABLE",
  );
});
test("capacity resource allows parallel reservations up to limit", async () => {
  const store = new ReferenceResourceStore();
  const resource = await store.resource.create(context, { type: "vehicle_pool", name: "Vans", timezone: "UTC", capacity: 3 });
  await store.reservation.hold(context, { resourceId: resource.id, range, quantity: 2 });
  assert.equal((await store.calendar.availability(context, resource.id, range, 1)).available, true);
  assert.equal((await store.calendar.availability(context, resource.id, range, 2)).available, false);
});
test("blackout removes resource capacity", async () => {
  const store = new ReferenceResourceStore();
  const resource = await store.resource.create(context, { type: "treatment_room", name: "Room", timezone: "Europe/Berlin", capacity: 1 });
  await store.calendar.addBlackout(context, { resourceId: resource.id, range, reason: "maintenance" });
  assert.equal((await store.calendar.availability(context, resource.id, range)).available, false);
});

test("availability rule is evaluated in resource timezone", async () => {
  const store = new ReferenceResourceStore();
  const resource = await store.resource.create(context, {
    type: "doctor",
    name: "Dr. Example",
    timezone: "Europe/Berlin",
    capacity: 1,
  });
  await store.calendar.addRule(context, {
    resourceId: resource.id,
    weekdays: [1],
    localStart: "09:00",
    localEnd: "17:00",
  });
  const monday = {
    start: "2026-06-22T08:00:00.000Z",
    end: "2026-06-22T09:00:00.000Z",
  };
  const evening = {
    start: "2026-06-22T18:00:00.000Z",
    end: "2026-06-22T19:00:00.000Z",
  };
  assert.equal(
    (await store.calendar.availability(context, resource.id, monday)).available,
    true,
  );
  assert.equal(
    (await store.calendar.availability(context, resource.id, evening)).available,
    false,
  );
});

test("expired hold releases capacity", async () => {
  const store = new ReferenceResourceStore();
  const resource = await store.resource.create(context, {
    type: "room",
    name: "Room",
    timezone: "UTC",
    capacity: 1,
  });
  const hold = await store.reservation.hold(context, {
    resourceId: resource.id,
    range,
    quantity: 1,
    expiresAt: "2026-06-20T00:00:00.000Z",
  });
  await store.reservation.expireHolds(
    context,
    "2026-06-21T00:00:00.000Z",
  );
  assert.equal(
    (await store.reservation.list(context, resource.id))[0].state,
    "expired",
  );
  assert.equal(
    (await store.calendar.availability(context, resource.id, range)).available,
    true,
  );
  assert.ok(hold.id);
});

test("pool selects an available resource", async () => {
  const store = new ReferenceResourceStore();
  const first = await store.resource.create(context, {
    type: "van",
    name: "Van 1",
    timezone: "UTC",
    capacity: 1,
  });
  const second = await store.resource.create(context, {
    type: "van",
    name: "Van 2",
    timezone: "UTC",
    capacity: 1,
  });
  const pool = await store.resource.createPool(context, {
    key: "delivery-vans",
    name: "Delivery Vans",
    resourceIds: [first.id, second.id],
    selection: "any",
  });
  const result = await store.allocation.allocate(context, [{
    poolId: pool.id,
    range,
    quantity: 1,
  }]);
  assert.equal(result.selectedResourceIds.length, 1);
});

test("multi-resource allocation is all-or-nothing", async () => {
  const store = new ReferenceResourceStore();
  const room = await store.resource.create(context, {
    type: "room",
    name: "Room",
    timezone: "UTC",
    capacity: 1,
  });
  const device = await store.resource.create(context, {
    type: "device",
    name: "Device",
    timezone: "UTC",
    capacity: 1,
  });
  await store.reservation.hold(context, {
    resourceId: device.id,
    range,
    quantity: 1,
  });
  await assert.rejects(
    store.allocation.allocate(context, [
      { resourceId: room.id, range, quantity: 1 },
      { resourceId: device.id, range, quantity: 1 },
    ]),
    (error) => error?.code === "RESOURCE_UNAVAILABLE",
  );
  assert.equal(
    (await store.calendar.availability(context, room.id, range)).available,
    true,
  );
});

test("calendar exception can open availability outside regular rule", async () => {
  const store = new ReferenceResourceStore();
  const resource = await store.resource.create(context, {
    type: "clinic",
    name: "Clinic",
    timezone: "Europe/Berlin",
    capacity: 1,
  });
  await store.calendar.addRule(context, {
    resourceId: resource.id,
    weekdays: [1],
    localStart: "09:00",
    localEnd: "17:00",
  });
  const saturday = {
    start: "2026-06-27T08:00:00.000Z",
    end: "2026-06-27T09:00:00.000Z",
  };
  assert.equal(
    (await store.calendar.availability(context, resource.id, saturday)).available,
    false,
  );
  await store.calendar.addException(context, {
    resourceId: resource.id,
    range: saturday,
    mode: "available",
    reason: "special clinic",
  });
  assert.equal(
    (await store.calendar.availability(context, resource.id, saturday)).available,
    true,
  );
});

test("search returns resources matching attributes and availability", async () => {
  const store = new ReferenceResourceStore();
  await store.resource.create(context, {
    type: "hotel_room",
    name: "Accessible Room",
    timezone: "UTC",
    capacity: 2,
    attributes: { accessible: true, seaView: false },
  });
  await store.resource.create(context, {
    type: "hotel_room",
    name: "Standard Room",
    timezone: "UTC",
    capacity: 2,
    attributes: { accessible: false, seaView: true },
  });
  const results = await store.search.available(
    context,
    { type: "hotel_room", attributes: { accessible: true } },
    range,
  );
  assert.equal(results.length, 1);
});

test("reservation can be rescheduled without conflicting with itself", async () => {
  const store = new ReferenceResourceStore();
  const resource = await store.resource.create(context, {
    type: "room",
    name: "Room",
    timezone: "UTC",
    capacity: 1,
  });
  const reservation = await store.reservation.hold(context, {
    resourceId: resource.id,
    range,
    quantity: 1,
  });
  const newRange = {
    start: "2026-07-04T12:00:00.000Z",
    end: "2026-07-05T10:00:00.000Z",
  };
  const moved = await store.reservation.reschedule(
    context,
    reservation.id,
    newRange,
  );
  assert.deepEqual(moved.range, newRange);
});

test("pool alternatives are ranked by remaining capacity", async () => {
  const store = new ReferenceResourceStore();
  const small = await store.resource.create(context, {
    type: "dock",
    name: "Small Dock",
    timezone: "UTC",
    capacity: 1,
  });
  const large = await store.resource.create(context, {
    type: "dock",
    name: "Large Dock",
    timezone: "UTC",
    capacity: 3,
  });
  const pool = await store.resource.createPool(context, {
    key: "docks",
    name: "Docks",
    resourceIds: [small.id, large.id],
    selection: "any",
  });
  const alternatives = await store.allocation.alternatives(
    context,
    pool.id,
    range,
  );
  assert.equal(alternatives[0].resourceId, large.id);
});
