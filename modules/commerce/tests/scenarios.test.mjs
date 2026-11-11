import assert from "node:assert/strict";
import test from "node:test";

import {
  b2bProfile,
  b2cProfile,
  b2gProfile,
  commerceEventTypes,
  createReferenceCommerce,
  referenceContext,
  referenceProductLine,
  referenceShippingAddress,
} from "../dist/index.js";

test("B2C: guest checkout reserves stock, captures payment and creates fulfillment", async () => {
  const { engine, sandbox } = await createReferenceCommerce(b2cProfile);
  assert.equal(engine.validate().valid, true);

  const context = referenceContext({
    correlationId: "b2c-checkout",
    idempotencyKey: "b2c-order-1",
  });
  const cart = await sandbox.providers.carts.create(context);
  await sandbox.providers.carts.addLine(
    context,
    cart.id,
    referenceProductLine(1),
  );

  const result = await sandbox.directCheckout(context, {
    cartId: cart.id,
    shippingAddress: referenceShippingAddress,
    billingAddress: referenceShippingAddress,
    paymentMethodId: "reference-card",
    shippingMethodId: "reference-standard",
  });

  assert.equal(result.order.state, "confirmed");
  assert.equal(result.payment.state, "captured");
  assert.equal(result.fulfillment.state, "processing");
  assert.equal(result.order.total.amount, 119_900);
  assert.ok(
    sandbox.events.some(
      (event) => event.type === commerceEventTypes.paymentCaptured,
    ),
  );
});

test("B2C: repeated idempotency key returns the same order", async () => {
  const { sandbox } = await createReferenceCommerce(b2cProfile);
  const context = referenceContext({
    correlationId: "b2c-idempotency",
    idempotencyKey: "same-checkout",
  });
  const cart = await sandbox.providers.carts.create(context);
  await sandbox.providers.carts.addLine(
    context,
    cart.id,
    referenceProductLine(1),
  );
  const input = {
    cartId: cart.id,
    shippingAddress: referenceShippingAddress,
    paymentMethodId: "reference-card",
  };

  const first = await sandbox.directCheckout(context, input);
  const second = await sandbox.directCheckout(context, input);

  assert.equal(second.order.id, first.order.id);
  assert.equal(second.payment.id, first.payment.id);
});

test("B2B: organization receives customer price, accepts quote and gets invoice", async () => {
  const { engine, sandbox } = await createReferenceCommerce(b2bProfile);
  assert.equal(engine.validate().valid, true);

  const customer = await sandbox.providers.customers.getCustomer(
    referenceContext(),
    "customer-buyer",
  );
  assert.ok(customer);
  const context = referenceContext({
    correlationId: "b2b-quote",
    idempotencyKey: "b2b-order-1",
    actor: {
      userId: "buyer-user",
      customerId: customer.id,
      customerOrganizationId: "customer-org-business",
      roles: ["buyer"],
    },
  });
  const cart = await sandbox.providers.carts.create(context, customer);
  await sandbox.providers.carts.addLine(
    context,
    cart.id,
    referenceProductLine(2),
  );
  await sandbox.providers.carts.patch(context, cart.id, {
    purchaseOrderNumber: "PO-2026-100",
    costCenter: "IT",
  });

  const result = await sandbox.quoteCheckout(context, {
    cartId: cart.id,
    customer,
    purchaseOrderNumber: "PO-2026-100",
    costCenter: "IT",
  });

  assert.equal(result.quote.state, "converted");
  assert.equal(result.order.state, "confirmed");
  assert.equal(result.order.total.amount, 199_800);
  assert.equal(result.order.purchaseOrderNumber, "PO-2026-100");
  assert.equal(result.invoice.format, "structured");
});

test("B2G: contract, budget and approval lead to XRechnung", async () => {
  const { engine, sandbox } = await createReferenceCommerce(b2gProfile);
  assert.equal(engine.validate().valid, true);

  const customer = await sandbox.providers.customers.getCustomer(
    referenceContext(),
    "customer-procurement",
  );
  assert.ok(customer);
  const context = referenceContext({
    correlationId: "b2g-approval",
    idempotencyKey: "b2g-order-1",
    actor: {
      userId: "procurement-user",
      customerId: customer.id,
      customerOrganizationId: "customer-org-government",
      roles: ["buyer", "approver"],
    },
  });
  const cart = await sandbox.providers.carts.create(context, customer);
  await sandbox.providers.carts.addLine(
    context,
    cart.id,
    referenceProductLine(2),
  );
  await sandbox.providers.carts.patch(context, cart.id, {
    purchaseOrderNumber: "GOV-PO-42",
    costCenter: "DIGITAL",
  });

  const result = await sandbox.approvalCheckout(context, {
    cartId: cart.id,
    customer,
    contractId: "contract-government-it",
    budgetKey: "DIGITAL-2026",
    purchaseOrderNumber: "GOV-PO-42",
    costCenter: "DIGITAL",
  });

  assert.equal(result.approval.state, "approved");
  assert.equal(result.order.state, "confirmed");
  assert.equal(result.order.total.amount, 179_800);
  assert.equal(result.invoice.format, "xrechnung");
  assert.ok(
    sandbox.events.some(
      (event) => event.type === commerceEventTypes.budgetReserved,
    ),
  );
  assert.ok(
    sandbox.events.some(
      (event) => event.type === commerceEventTypes.approvalDecided,
    ),
  );
});
