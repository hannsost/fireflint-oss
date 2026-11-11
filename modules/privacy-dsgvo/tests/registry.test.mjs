import assert from "node:assert/strict";
import test from "node:test";

import {
  PrivacyEngine,
  PrivacyRegistry,
  b2cPrivacyProfile,
} from "../dist/index.js";

test("registry rejects accidental provider replacement", () => {
  const registry = new PrivacyRegistry();
  const events = { publish: async () => {} };
  registry.register("events", events);
  assert.throws(() => registry.register("events", events), /already registered/);
  registry.register("events", events, { replace: true });
});

test("empty engine reports required providers", async () => {
  const engine = await PrivacyEngine.create({ profile: b2cPrivacyProfile });
  const result = engine.validate();
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("subjects")));
});
