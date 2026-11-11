import type {
  ApprovalRequest,
  BudgetReservation,
  Cart,
  CommerceEvent,
  Fulfillment,
  InventoryReservation,
  Invoice,
  Order,
  PaymentIntent,
} from "./contracts.js";

export const commerceEventTypes = {
  cartCreated: "commerce.cart.created",
  cartUpdated: "commerce.cart.updated",
  inventoryReserved: "commerce.inventory.reserved",
  inventoryReleased: "commerce.inventory.released",
  orderCreated: "commerce.order.created",
  orderApproved: "commerce.order.approved",
  orderConfirmed: "commerce.order.confirmed",
  paymentAuthorized: "commerce.payment.authorized",
  paymentCaptured: "commerce.payment.captured",
  approvalRequested: "commerce.approval.requested",
  approvalDecided: "commerce.approval.decided",
  budgetReserved: "commerce.budget.reserved",
  invoiceIssued: "commerce.invoice.issued",
  fulfillmentCreated: "commerce.fulfillment.created",
} as const;

export type CommerceEventType =
  (typeof commerceEventTypes)[keyof typeof commerceEventTypes];

export interface CommerceEventPayloads {
  "commerce.cart.created": Pick<Cart, "id" | "customerId" | "customerOrganizationId">;
  "commerce.cart.updated": Pick<Cart, "id" | "version">;
  "commerce.inventory.reserved": Pick<InventoryReservation, "id" | "lines" | "expiresAt">;
  "commerce.inventory.released": { reservationId: string };
  "commerce.order.created": Pick<Order, "id" | "orderNumber" | "state" | "total">;
  "commerce.order.approved": Pick<Order, "id" | "state">;
  "commerce.order.confirmed": Pick<Order, "id" | "state">;
  "commerce.payment.authorized": Pick<PaymentIntent, "id" | "orderId" | "state" | "amount">;
  "commerce.payment.captured": Pick<PaymentIntent, "id" | "orderId" | "state" | "amount">;
  "commerce.approval.requested": Pick<ApprovalRequest, "id" | "orderId" | "state">;
  "commerce.approval.decided": Pick<ApprovalRequest, "id" | "orderId" | "state">;
  "commerce.budget.reserved": Pick<BudgetReservation, "id" | "budgetKey" | "amount">;
  "commerce.invoice.issued": Pick<Invoice, "id" | "orderId" | "number" | "format">;
  "commerce.fulfillment.created": Pick<Fulfillment, "id" | "orderId" | "state">;
}

export type TypedCommerceEvent<T extends CommerceEventType> = CommerceEvent<
  CommerceEventPayloads[T]
> & { type: T };
