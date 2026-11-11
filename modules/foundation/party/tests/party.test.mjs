import assert from "node:assert/strict";
import test from "node:test";
import { ReferencePartyStore, referencePartyContext } from "../dist/index.js";

const context = referencePartyContext();
const input = (name, email) => ({
  kind: "person",
  displayName: name,
  givenName: name.split(" ")[0],
  familyName: name.split(" ")[1],
  identifiers: [{ scheme: "email", value: email }],
  contacts: [{ id: `contact-${email}`, type: "email", value: email, primary: true }],
  addresses: [],
});

test("creates and resolves a person by identifier", async () => {
  const store = new ReferencePartyStore();
  const party = await store.party.create(context, input("Erika Beispiel", "erika@example.test"));
  const resolved = await store.party.findByIdentifier(context, { scheme: "email", value: "erika@example.test" });
  assert.equal(resolved?.id, party.id);
});

test("one party can carry multiple contextual roles", async () => {
  const store = new ReferencePartyStore();
  const party = await store.party.create(context, input("Alex Partner", "alex@example.test"));
  await store.relationships.addRole(context, { partyId: party.id, role: "customer" });
  await store.relationships.addRole(context, { partyId: party.id, role: "supplier_contact", contextId: "supplier-1" });
  assert.deepEqual((await store.relationships.roles(context, party.id)).map((item) => item.role), ["customer", "supplier_contact"]);
});

test("organization hierarchy is expressed through relationships", async () => {
  const store = new ReferencePartyStore();
  const org = await store.party.create(context, { ...input("Example Org", "org@example.test"), kind: "organization", legalName: "Example Org GmbH" });
  const unit = await store.party.create(context, { ...input("Berlin Unit", "berlin@example.test"), kind: "organizational_unit" });
  const relation = await store.relationships.relate(context, { fromPartyId: unit.id, toPartyId: org.id, type: "unit_of" });
  assert.equal(relation.type, "unit_of");
});

test("merge preserves identifiers and redirects duplicate party", async () => {
  const store = new ReferencePartyStore();
  const survivor = await store.party.create(context, input("Erika Beispiel", "erika@example.test"));
  const duplicate = await store.party.create(context, input("Erika B.", "erika.alt@example.test"));
  const result = await store.deduplication.merge(context, survivor.id, [duplicate.id]);
  assert.equal(result.survivingParty.identifiers.length, 2);
  assert.equal((await store.party.get(context, duplicate.id))?.mergedIntoId, survivor.id);
});

test("hierarchy traversal returns transitive organization ancestors", async () => {
  const store = new ReferencePartyStore();
  const group = await store.party.create(context, { ...input("Group Org", "group@example.test"), kind: "organization" });
  const company = await store.party.create(context, { ...input("Company Org", "company@example.test"), kind: "organization" });
  const unit = await store.party.create(context, { ...input("Unit Berlin", "unit@example.test"), kind: "organizational_unit" });
  await store.relationships.relate(context, { fromPartyId: company.id, toPartyId: group.id, type: "unit_of" });
  await store.relationships.relate(context, { fromPartyId: unit.id, toPartyId: company.id, type: "unit_of" });
  assert.deepEqual(
    (await store.relationships.ancestors(context, unit.id, "unit_of")).map((item) => item.id),
    [company.id, group.id],
  );
});

test("role lifecycle is ended instead of deleting historical role", async () => {
  const store = new ReferencePartyStore();
  const party = await store.party.create(context, input("Alex Role", "role@example.test"));
  const role = await store.relationships.addRole(context, { partyId: party.id, role: "employee" });
  const ended = await store.relationships.endRole(context, role.id, "2026-12-31T23:59:59.000Z");
  assert.equal(ended.validUntil, "2026-12-31T23:59:59.000Z");
});

test("merge preview exposes conflicts without changing parties", async () => {
  const store = new ReferencePartyStore();
  const survivor = await store.party.create(context, input("Erika Example", "one@example.test"));
  const duplicate = await store.party.create(context, input("Erika E.", "two@example.test"));
  const preview = await store.deduplication.previewMerge(context, survivor.id, [duplicate.id]);
  assert.equal(preview.conflicts[0].field, "displayName");
  assert.equal((await store.party.get(context, duplicate.id))?.status, "active");
});

test("preferred contact favors explicitly primary contact", async () => {
  const store = new ReferencePartyStore();
  const party = await store.party.create(context, {
    ...input("Contact Person", "default@example.test"),
    contacts: [
      { id: "email-1", type: "email", value: "first@example.test" },
      { id: "email-2", type: "email", value: "primary@example.test", primary: true },
    ],
  });
  assert.equal(
    (await store.party.preferredContact(context, party.id, "email"))?.value,
    "primary@example.test",
  );
});

test("party preserves aliases and authoritative source references", async () => {
  const store = new ReferencePartyStore();
  const party = await store.party.create(context, {
    ...input("Example Holdings", "holding@example.test"),
    kind: "organization",
    alternativeNames: [
      { value: "Example Group", type: "trade", locale: "en" },
      { value: "Beispiel Gruppe", type: "localized", locale: "de" },
    ],
    sources: [{
      system: "erp",
      externalId: "ERP-100",
      importedAt: "2026-06-19T12:00:00.000Z",
      authoritative: true,
    }],
  });
  assert.equal(party.alternativeNames?.[1].locale, "de");
  assert.equal(party.sources?.[0].authoritative, true);
});

test("roles and relationships can be queried at a historical point", async () => {
  const store = new ReferencePartyStore();
  const company = await store.party.create(context, {
    ...input("Company", "company-history@example.test"),
    kind: "organization",
  });
  const person = await store.party.create(
    context,
    input("Historic Person", "historic@example.test"),
  );
  await store.relationships.addRole(context, {
    partyId: person.id,
    role: "employee",
    validFrom: "2025-01-01T00:00:00.000Z",
    validUntil: "2025-12-31T23:59:59.000Z",
  });
  await store.relationships.relate(context, {
    fromPartyId: person.id,
    toPartyId: company.id,
    type: "employed_by",
    validFrom: "2025-01-01T00:00:00.000Z",
    validUntil: "2025-12-31T23:59:59.000Z",
  });
  assert.equal(
    (await store.relationships.activeRoles(
      context,
      person.id,
      "2025-06-01T00:00:00.000Z",
    )).length,
    1,
  );
  assert.equal(
    (await store.relationships.activeRelationships(
      context,
      person.id,
      "2026-06-01T00:00:00.000Z",
    )).length,
    0,
  );
});

test("party can be archived without deleting historical identity", async () => {
  const store = new ReferencePartyStore();
  const party = await store.party.create(
    context,
    input("Archived Party", "archived@example.test"),
  );
  assert.equal((await store.party.archive(context, party.id)).status, "archived");
  assert.equal((await store.party.get(context, party.id))?.id, party.id);
});
