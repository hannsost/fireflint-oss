import assert from "node:assert/strict";
import test from "node:test";

import {
  CommerceEngine,
  CommerceRegistry,
  b2cProfile,
} from "../dist/index.js";

test("registry rejects accidental provider replacement", () => {
  const registry = new CommerceRegistry();
  const events = { publish: async () => {} };

  registry.register("events", events);
  assert.throws(
    () => registry.register("events", events),
    /already registered/,
  );
  registry.register("events", events, { replace: true });
});

test("engine validates a minimal custom profile", async () => {
  const profile = {
    key: "events-only",
    audience: "b2c",
    description: "Test profile",
    capabilities: [],
    requiredProviders: ["events"],
    settings: {
      checkoutMode: "direct",
      customerMode: "guest_or_account",
      pricingMode: "public",
      taxDisplay: "gross",
      paymentRequired: false,
    },
  };
  const module = {
    manifest: {
      key: "events",
      name: "Events",
      version: "1.0.0",
      audiences: ["b2c"],
      capabilities: [],
    },
    setup(context) {
      context.registerProvider("events", { publish: async () => {} });
    },
  };

  const engine = await CommerceEngine.create({ profile, modules: [module] });
  assert.equal(engine.validate().valid, true);
  assert.deepEqual(engine.installedModules(), ["events"]);
});

test("built-in B2C profile reports missing core providers", async () => {
  const engine = await CommerceEngine.create({ profile: b2cProfile });
  const validation = engine.validate();

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes("catalog")));
  assert.ok(validation.errors.some((error) => error.includes("payments")));
});

test("module audience must match profile", async () => {
  const module = {
    manifest: {
      key: "government-only",
      name: "Government only",
      version: "1.0.0",
      audiences: ["b2g"],
      capabilities: [],
    },
    setup() {},
  };

  await assert.rejects(
    CommerceEngine.create({ profile: b2cProfile, modules: [module] }),
    /does not support profile audience/,
  );
});
