import assert from "node:assert/strict";
import test from "node:test";

import {
  b2bPrivacyProfile,
  b2cPrivacyProfile,
  b2gPrivacyProfile,
  createReferencePrivacy,
  privacyEventTypes,
  referencePrivacyContext,
} from "../dist/index.js";

const identifiers = [{ type: "email", value: "erika@example.test" }];

test("B2C access request exports records from all existing SiteGraph domains", async () => {
  const { engine, sandbox } = await createReferencePrivacy(b2cPrivacyProfile);
  assert.equal(engine.validate().valid, true);
  const result = await sandbox.fulfillAccess(
    referencePrivacyContext({ correlationId: "access-1" }),
    identifiers,
  );

  assert.equal(result.request.state, "completed");
  assert.deepEqual(
    new Set(result.exportBundle.systems),
    new Set(["content", "commerce", "forms-workflow", "edi"]),
  );
  assert.equal(
    result.exportBundle.manifest.reduce((sum, item) => sum + item.recordCount, 0),
    5,
  );
});

test("erasure deletes optional data but anonymizes retained Commerce and EDI records", async () => {
  const { sandbox } = await createReferencePrivacy(b2cPrivacyProfile);
  const result = await sandbox.fulfillErasure(
    referencePrivacyContext({ correlationId: "erasure-1" }),
    identifiers,
  );

  assert.equal(result.request.state, "completed");
  const actions = result.results.map((item) => [
    item.decision.record.system,
    item.decision.record.recordType,
    item.decision.action,
  ]);
  assert.ok(actions.some(([system, , action]) => system === "content" && action === "delete"));
  assert.ok(actions.some(([system, type, action]) => system === "commerce" && type === "order" && action === "anonymize"));
  assert.ok(actions.some(([system, , action]) => system === "edi" && action === "anonymize"));
});

test("consent withdrawal removes marketing data without touching contract records", async () => {
  const { sandbox } = await createReferencePrivacy(b2cPrivacyProfile);
  const context = referencePrivacyContext({ correlationId: "consent-1" });
  await sandbox.providers.consents.record(context, {
    subjectId: "subject-erika",
    purposeKey: "marketing",
    state: "granted",
    noticeVersion: "privacy-2026-01",
    source: "content-newsletter",
    grantedAt: new Date().toISOString(),
  });
  const result = await sandbox.withdrawConsent(context, "subject-erika", "marketing");

  assert.equal(result.consent.state, "withdrawn");
  assert.equal(result.affected.length, 1);
  assert.equal(result.affected[0].decision.record.system, "content");
});

test("B2B access also discovers business-contact data in EDI", async () => {
  const { sandbox } = await createReferencePrivacy(b2bPrivacyProfile);
  const result = await sandbox.fulfillAccess(
    referencePrivacyContext({ correlationId: "b2b-access" }),
    identifiers,
  );
  assert.ok(result.exportBundle.manifest.some((item) => item.system === "edi"));
});

test("B2G DPIA is stored as governance evidence", async () => {
  const { sandbox } = await createReferencePrivacy(b2gPrivacyProfile);
  const assessment = await sandbox.providers.governance.saveDpia(
    referencePrivacyContext({ correlationId: "dpia-1" }),
    {
      id: "dpia-formal-cases",
      organizationId: "tenant-1",
      processingActivityIds: ["activity-customer-lifecycle"],
      name: "Formal case processing",
      state: "approved",
      necessityAssessment: "Required for public task workflow",
      proportionalityAssessment: "Access and retention are limited by role and purpose",
      risks: [{
        id: "risk-special-data",
        description: "Unauthorized access to case data",
        likelihood: 2,
        impact: 5,
        affectedRights: ["privacy", "non-discrimination"],
        mitigations: ["field encryption", "role-based access", "audit"],
        residualRisk: "medium",
      }],
      dpoConsulted: true,
      approvedAt: new Date().toISOString(),
    },
  );
  assert.equal(assessment.state, "approved");
  assert.ok(sandbox.events.some((event) => event.type === privacyEventTypes.dpiaSaved));
});

test("breach assessment calculates notification deadline from awareness time", async () => {
  const { sandbox } = await createReferencePrivacy(b2gPrivacyProfile);
  const context = referencePrivacyContext({ correlationId: "breach-1" });
  const awarenessAt = "2026-06-19T08:00:00.000Z";
  const incident = await sandbox.providers.breaches.create(context, {
    organizationId: "tenant-1",
    detectedAt: awarenessAt,
    awarenessAt,
    state: "detected",
    confidentialityImpact: true,
    integrityImpact: false,
    availabilityImpact: false,
    affectedSubjectsEstimate: 100,
    affectedCategories: ["contact", "case-data"],
    systems: ["forms-workflow"],
    riskToRights: "possible",
    measures: ["credential rotation", "access revoked"],
  });
  const assessed = await sandbox.providers.breaches.assess(context, incident.id);

  assert.equal(assessed.state, "notifiable");
  assert.equal(assessed.authorityNotificationDueAt, "2026-06-22T08:00:00.000Z");
});
