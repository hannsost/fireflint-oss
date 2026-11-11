import assert from "node:assert/strict";
import test from "node:test";

import {
  b2bFormsProfile,
  b2cFormsProfile,
  b2gFormsProfile,
  createReferenceForms,
  formsEventTypes,
  referenceFormsContext,
} from "../dist/index.js";

test("B2C: public contact form validates consent and sends confirmation", async () => {
  const { engine, sandbox } = await createReferenceForms(b2cFormsProfile);
  assert.equal(engine.validate().valid, true);
  const context = referenceFormsContext({
    correlationId: "contact-1",
    idempotencyKey: "contact-idempotency",
  });

  const result = await sandbox.submitPublicForm(context, {
    formId: "form-contact",
    submitterEmail: "PERSON@EXAMPLE.TEST",
    data: {
      name: "Erika Beispiel",
      email: "PERSON@EXAMPLE.TEST",
      message: "Bitte zurückrufen.",
      privacy: true,
    },
    consents: [
      { key: "privacy", textVersion: "privacy-2026-01", accepted: true },
    ],
  });

  assert.equal(result.submission.state, "submitted");
  assert.equal(result.submission.data.email, "person@example.test");
  assert.equal(result.confirmation.state, "sent");
  assert.ok(
    sandbox.events.some((event) => event.type === formsEventTypes.submitted),
  );
});

test("idempotent submission returns the same submission", async () => {
  const { sandbox } = await createReferenceForms(b2cFormsProfile);
  const context = referenceFormsContext({
    correlationId: "contact-idempotent",
    idempotencyKey: "same-form-submit",
  });
  const input = {
    formId: "form-contact",
    submitterEmail: "person@example.test",
    data: {
      name: "Erika Beispiel",
      email: "person@example.test",
      message: "Hallo",
      privacy: true,
    },
    consents: [
      { key: "privacy", textVersion: "privacy-2026-01", accepted: true },
    ],
  };

  const first = await sandbox.submitPublicForm(context, input);
  const second = await sandbox.submitPublicForm(context, input);
  assert.equal(second.submission.id, first.submission.id);
});

test("B2B: partner registration creates review task and CRM record", async () => {
  const { engine, sandbox } = await createReferenceForms(b2bFormsProfile);
  assert.equal(engine.validate().valid, true);
  const context = referenceFormsContext({
    correlationId: "partner-1",
    idempotencyKey: "partner-submit-1",
    actor: {
      userId: "buyer-user",
      customerOrganizationId: "buyer-org",
      roles: ["buyer"],
    },
  });
  const file = await sandbox.providers.files.upload(context, {
    filename: "handelsregister.pdf",
    mimeType: "application/pdf",
    size: 50_000,
  });

  const result = await sandbox.submitBusinessRegistration(context, {
    formId: "form-partner",
    submitterEmail: "buyer@company.test",
    data: {
      company: "Beispiel GmbH",
      email: "buyer@company.test",
      vat_id: "DE123456789",
      documents: [file.id],
      privacy: true,
    },
    fileIds: [file.id],
    consents: [
      { key: "privacy", textVersion: "privacy-2026-01", accepted: true },
    ],
  });

  assert.equal(result.submission.state, "in_review");
  assert.equal(result.task.state, "open");
  assert.equal(result.integration.system, "crm");
  assert.match(result.integration.externalId, /^CRM-/);
});

test("B2G: signed application opens case and creates XFall export", async () => {
  const { engine, sandbox } = await createReferenceForms(b2gFormsProfile);
  assert.equal(engine.validate().valid, true);
  const context = referenceFormsContext({
    correlationId: "government-1",
    idempotencyKey: "government-submit-1",
    actor: { userId: "citizen-user", roles: ["applicant"] },
  });
  const file = await sandbox.providers.files.upload(context, {
    filename: "projektplan.pdf",
    mimeType: "application/pdf",
    size: 75_000,
  });
  const signature = await sandbox.providers.signatures.create(context, {
    method: "qualified",
    signerName: "Max Mustermann",
  });

  const result = await sandbox.submitGovernmentApplication(context, {
    formId: "form-government",
    submitterEmail: "max@example.test",
    data: {
      applicant: "Max Mustermann",
      project: "Digitales Vorhaben",
      amount: 100_000,
      attachment: [file.id],
      declaration: true,
      signature: signature.id,
    },
    fileIds: [file.id],
    signatureIds: [signature.id],
    consents: [
      { key: "declaration", textVersion: "declaration-2026-01", accepted: true },
    ],
  });

  assert.equal(result.submission.state, "in_review");
  assert.equal(result.task.assigneeRole, "case-worker");
  assert.equal(result.exportBundle.format, "xfall");
  assert.equal(result.integration.system, "case_management");
});

test("spam is rejected with stable error semantics", async () => {
  const { sandbox } = await createReferenceForms(b2cFormsProfile);
  const context = referenceFormsContext({
    correlationId: "spam-1",
    idempotencyKey: "spam-submit-1",
  });

  await assert.rejects(
    sandbox.submitPublicForm(context, {
      formId: "form-contact",
      data: {
        name: "Bot",
        email: "bot@example.test",
        message: "buy followers now",
        privacy: true,
      },
      consents: [
        { key: "privacy", textVersion: "privacy-2026-01", accepted: true },
      ],
    }),
    (error) => error?.code === "SPAM_REJECTED",
  );
});
