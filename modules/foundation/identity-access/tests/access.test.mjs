import assert from "node:assert/strict";
import test from "node:test";
import { ReferenceAccessStore } from "../dist/index.js";

async function setup(type = "human") {
  const store = new ReferenceAccessStore();
  const principal = await store.principal.create(
    { organizationId: "tenant-1", correlationId: "test" },
    { type, partyId: type === "human" ? "party-1" : undefined, displayName: "Actor", authenticationMethods: ["oidc"] },
  );
  return { store, principal, context: { organizationId: "tenant-1", principalId: principal.id, correlationId: "test" } };
}
test("principal links to party without owning party data", async () => {
  const { principal } = await setup();
  assert.equal(principal.partyId, "party-1");
});
test("role grant authorizes matching permission", async () => {
  const { store, principal, context } = await setup();
  await store.grant.grant(context, { principalId: principal.id, roleId: "role-editor", scope: { type: "organization" } });
  assert.equal((await store.authorization.decide(context, { permission: "content.write", resource: { type: "content", organizationId: "tenant-1" } })).allowed, true);
});
test("cross-organization access is denied", async () => {
  const { store, principal, context } = await setup();
  await store.grant.grant(context, { principalId: principal.id, roleId: "role-owner", scope: { type: "organization" } });
  assert.equal((await store.authorization.decide(context, { permission: "anything", resource: { type: "record", organizationId: "tenant-2" } })).allowed, false);
});
test("temporary delegation grants and revokes permission", async () => {
  const first = await setup();
  const delegate = await first.store.principal.create(
    { organizationId: "tenant-1", correlationId: "test" },
    { type: "human", partyId: "party-2", displayName: "Delegate", authenticationMethods: ["oidc"] },
  );
  const delegation = await first.store.grant.delegate(first.context, {
    fromPrincipalId: first.principal.id, toPrincipalId: delegate.id,
    permissions: ["work.manage"], scope: { type: "organization" },
    validFrom: new Date(Date.now() - 1000).toISOString(),
    validUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  const delegateContext = { ...first.context, principalId: delegate.id };
  assert.equal((await first.store.authorization.decide(delegateContext, { permission: "work.manage", resource: { type: "task", organizationId: "tenant-1" } })).allowed, true);
  await first.store.grant.revokeDelegation(first.context, delegation.id);
  assert.equal((await first.store.authorization.decide(delegateContext, { permission: "work.manage", resource: { type: "task", organizationId: "tenant-1" } })).allowed, false);
});

test("group grant authorizes all current group members", async () => {
  const { store, principal, context } = await setup();
  const group = await store.group.create(context, { name: "Privacy Reviewers" });
  await store.group.addMember(context, group.id, principal.id);
  await store.grant.grant(context, {
    groupId: group.id,
    roleId: "role-editor",
    scope: { type: "organization" },
  });
  assert.equal(
    (await store.authorization.decide(context, {
      permission: "work.manage",
      resource: { type: "privacy_request", organizationId: "tenant-1" },
    })).allowed,
    true,
  );
});

test("explicit deny policy overrides owner grant", async () => {
  const { store, principal, context } = await setup();
  await store.grant.grant(context, {
    principalId: principal.id,
    roleId: "role-owner",
    scope: { type: "organization" },
  });
  await store.policy.add(context, {
    effect: "deny",
    permissions: ["asset.delete"],
    principalIds: [principal.id],
    resourceTypes: ["legal_hold_asset"],
    priority: 100,
    enabled: true,
    obligations: [{ type: "contact_privacy_officer" }],
  });
  const decision = await store.authorization.decide(context, {
    permission: "asset.delete",
    resource: {
      type: "legal_hold_asset",
      organizationId: "tenant-1",
    },
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.obligations?.[0].type, "contact_privacy_officer");
});

test("sensitive operation requests step-up authentication", async () => {
  const { store, principal, context } = await setup();
  await store.grant.grant(context, {
    principalId: principal.id,
    roleId: "role-owner",
    scope: { type: "organization" },
  });
  const decision = await store.authorization.decide(
    { ...context, assuranceLevel: "single_factor" },
    {
      permission: "privacy.export",
      requiredAssurance: "mfa",
      resource: { type: "privacy_request", organizationId: "tenant-1" },
    },
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.obligations?.[0].type, "step_up_authentication");
});

test("conditional allow policy uses context attributes", async () => {
  const { store, context } = await setup();
  await store.policy.add(context, {
    effect: "allow",
    permissions: ["case.read"],
    resourceTypes: ["medical_case"],
    conditions: { facility: "hospital-a" },
    priority: 10,
    enabled: true,
    obligations: [{ type: "mask_sensitive_fields" }],
  });
  const decision = await store.authorization.decide(
    { ...context, attributes: { facility: "hospital-a" } },
    {
      permission: "case.read",
      resource: { type: "medical_case", organizationId: "tenant-1" },
    },
  );
  assert.equal(decision.allowed, true);
  assert.equal(decision.obligations?.[0].type, "mask_sensitive_fields");
});

test("custom role can be registered and granted", async () => {
  const { store, principal, context } = await setup();
  const role = await store.role.register(context, {
    key: "edi-operator",
    name: "EDI Operator",
    permissions: ["edi.replay", "edi.quarantine.read"],
  });
  await store.grant.grant(context, {
    principalId: principal.id,
    roleId: role.id,
    scope: { type: "domain", id: "edi" },
  });
  assert.ok(
    (await store.authorization.effectivePermissions(context))
      .includes("edi.replay"),
  );
});

test("external identity resolves to linked principal without storing secrets", async () => {
  const { store, principal, context } = await setup();
  const identity = await store.federation.link(context, {
    principalId: principal.id,
    provider: "oidc",
    issuer: "https://id.example.test",
    subject: "user-123",
    email: "user@example.test",
  });
  const resolved = await store.federation.resolve(context, identity);
  assert.equal(resolved?.id, principal.id);
  assert.equal("secret" in identity, false);
});

test("revoked grant no longer contributes permissions", async () => {
  const { store, principal, context } = await setup();
  const grant = await store.grant.grant(context, {
    principalId: principal.id,
    roleId: "role-editor",
    scope: { type: "organization" },
  });
  assert.ok(
    (await store.authorization.effectivePermissions(context))
      .includes("content.write"),
  );
  await store.grant.revokeGrant(context, grant.id);
  assert.equal(
    (await store.authorization.effectivePermissions(context))
      .includes("content.write"),
    false,
  );
});
