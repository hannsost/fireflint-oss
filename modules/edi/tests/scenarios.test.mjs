import assert from "node:assert/strict";
import test from "node:test";

import {
  createReferenceEdi,
  ediEventTypes,
  publicSectorEdiProfile,
  referenceEdiContext,
  referenceEnvelope,
  supplyChainEdiProfile,
} from "../dist/index.js";

test("EDIFACT ORDERS becomes canonical purchase order with CONTRL and APERAK", async () => {
  const { engine, sandbox } = await createReferenceEdi(supplyChainEdiProfile);
  assert.equal(engine.validate().valid, true);
  const result = await sandbox.processInbound(
    referenceEdiContext({ correlationId: "edifact-1" }),
    referenceEnvelope("edifact-orders"),
  );

  assert.equal(result.message.state, "acknowledged");
  assert.equal(result.message.canonicalDocument?.type, "purchase_order");
  assert.equal(result.message.canonicalDocument?.documentNumber, "PO-4711");
  assert.equal(result.functionalAcknowledgement?.kind, "contrl");
  assert.equal(result.applicationAcknowledgement?.kind, "aperak");
  assert.ok(
    sandbox.events.some((event) => event.type === ediEventTypes.mapped),
  );
});

test("X12 850 becomes canonical purchase order and 997 acknowledgement", async () => {
  const { sandbox } = await createReferenceEdi(supplyChainEdiProfile);
  const result = await sandbox.processInbound(
    referenceEdiContext({ correlationId: "x12-1" }),
    referenceEnvelope("x12-850"),
  );

  assert.equal(result.message.canonicalDocument?.documentNumber, "PO-850-1");
  assert.equal(result.message.canonicalDocument?.lines[0]?.itemId, "SKU-X12");
  assert.equal(result.functionalAcknowledgement?.kind, "997");
});

test("Peppol UBL invoice is validated, mapped and acknowledged", async () => {
  const { engine, sandbox } = await createReferenceEdi(publicSectorEdiProfile);
  assert.equal(engine.validate().valid, true);
  const result = await sandbox.processInbound(
    referenceEdiContext({ correlationId: "peppol-1" }),
    referenceEnvelope("peppol-invoice"),
  );

  assert.equal(result.message.canonicalDocument?.type, "invoice");
  assert.equal(result.message.canonicalDocument?.documentNumber, "INV-2026-1");
  assert.equal(result.message.canonicalDocument?.totals?.payable, 1199);
  assert.equal(result.functionalAcknowledgement?.kind, "peppol-receipt");
});

test("duplicate inbound message is rejected deterministically", async () => {
  const { sandbox } = await createReferenceEdi(supplyChainEdiProfile);
  const envelope = referenceEnvelope("edifact-orders");
  await sandbox.processInbound(
    referenceEdiContext({ correlationId: "duplicate-1" }),
    envelope,
  );
  await assert.rejects(
    sandbox.processInbound(
      referenceEdiContext({ correlationId: "duplicate-2" }),
      envelope,
    ),
    (error) => error?.code === "DUPLICATE_MESSAGE",
  );
});

test("invalid inbound message is quarantined", async () => {
  const { sandbox } = await createReferenceEdi(supplyChainEdiProfile);
  await assert.rejects(
    sandbox.processInbound(
      referenceEdiContext({ correlationId: "invalid-1" }),
      referenceEnvelope("invalid"),
    ),
    (error) => error?.code === "VALIDATION_FAILED",
  );
  assert.ok(
    sandbox.events.some((event) => event.type === ediEventTypes.quarantined),
  );
});

test("canonical order response is serialized and delivered over partner transport", async () => {
  const { sandbox } = await createReferenceEdi(supplyChainEdiProfile);
  const result = await sandbox.sendCanonical(
    referenceEdiContext({
      correlationId: "outbound-1",
      idempotencyKey: "outbound-order-response-1",
    }),
    "agreement-edifact",
    "profile-edifact-ordrsp",
    {
      id: "canonical-response-1",
      type: "order_response",
      documentNumber: "PO-4711",
      lines: [{ lineNumber: "1", itemId: "SKU-1", quantity: 1 }],
    },
  );

  assert.equal(result.message.state, "delivered");
  assert.equal(result.message.envelope.transport, "as2");
  assert.equal(result.message.envelope.headers?.["x-reference-signed"], "true");
  assert.equal(result.message.envelope.headers?.["x-reference-encrypted"], "true");
});
