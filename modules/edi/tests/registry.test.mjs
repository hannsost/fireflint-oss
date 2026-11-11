import assert from "node:assert/strict";
import test from "node:test";

import {
  EdiEngine,
  EdiRegistry,
  supplyChainEdiProfile,
} from "../dist/index.js";

test("registry rejects accidental provider replacement", () => {
  const registry = new EdiRegistry();
  const events = { publish: async () => {} };
  registry.register("events", events);
  assert.throws(() => registry.register("events", events), /already registered/);
  registry.register("events", events, { replace: true });
});

test("empty engine reports required providers", async () => {
  const engine = await EdiEngine.create({ profile: supplyChainEdiProfile });
  const result = engine.validate();
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("partners")));
});
