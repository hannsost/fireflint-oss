import assert from "node:assert/strict";
import test from "node:test";

import {
  FormsEngine,
  FormsRegistry,
  b2cFormsProfile,
} from "../dist/index.js";

test("registry rejects accidental provider replacement", () => {
  const registry = new FormsRegistry();
  const events = { publish: async () => {} };
  registry.register("events", events);
  assert.throws(() => registry.register("events", events), /already registered/);
  registry.register("events", events, { replace: true });
});

test("built-in profile reports missing providers", async () => {
  const engine = await FormsEngine.create({ profile: b2cFormsProfile });
  const result = engine.validate();
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("definitions")));
});

test("module audience must match profile", async () => {
  await assert.rejects(
    FormsEngine.create({
      profile: b2cFormsProfile,
      modules: [
        {
          manifest: {
            key: "government-only",
            name: "Government only",
            version: "1.0.0",
            audiences: ["b2g"],
            capabilities: [],
          },
          setup() {},
        },
      ],
    }),
    /does not support profile audience/,
  );
});
