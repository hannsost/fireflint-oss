export type Id = string;
export type IsoDateTime = string;
export type CurrencyCode = string;
export type Audience = "b2c" | "b2b" | "b2g";

export interface CommerceContext {
  organizationId: Id;
  channelId: Id;
  locale: string;
  currency: CurrencyCode;
  actor?: {
    userId?: Id;
    customerId?: Id;
    customerOrganizationId?: Id;
    roles?: string[];
  };
  correlationId: string;
  idempotencyKey?: string;
}

export interface Money {
  /** Integer minor units: 1099 means 10.99 in a two-decimal currency. */
  amount: number;
  currency: CurrencyCode;
}

export interface Address {
  name?: string;
  company?: string;
  street: string;
  street2?: string;
  postalCode: string;
  city: string;
  region?: string;
  countryCode: string;
}

export interface ProductRef {
  productId: Id;
  variantId?: Id;
  sku: string;
}

export interface Product {
  id: Id;
  organizationId: Id;
  contentObjectId?: Id;
  sku: string;
  status: "draft" | "active" | "archived";
  productType: "physical" | "digital" | "service";
  taxClass?: string;
  variants: ProductVariant[];
  attributes?: Record<string, unknown>;
}

export interface ProductVariant {
  id: Id;
  sku: string;
  options?: Record<string, string>;
  attributes?: Record<string, unknown>;
}

export interface ProductQuery {
  search?: string;
  skus?: string[];
  productIds?: Id[];
  cursor?: string;
  limit?: number;
}

export interface ProductPage {
  items: Product[];
  nextCursor?: string;
}

export interface PriceRequestLine extends ProductRef {
  quantity: number;
}

export interface PriceLine {
  lineId?: Id;
  product: ProductRef;
  quantity: number;
  unitPrice: Money;
  listPrice?: Money;
  subtotal: Money;
  discounts?: Adjustment[];
  tax?: Money;
  total: Money;
  priceSource?: string;
}

export interface Adjustment {
  code: string;
  label: string;
  amount: Money;
  source: "discount" | "surcharge" | "contract" | "manual";
}

export interface PriceQuote {
  lines: PriceLine[];
  subtotal: Money;
  adjustments: Adjustment[];
  taxTotal?: Money;
  grandTotal: Money;
  expiresAt?: IsoDateTime;
}

export interface InventoryStatus {
  product: ProductRef;
  state: "in_stock" | "low_stock" | "out_of_stock" | "backorder" | "unknown";
  available?: number;
  leadTimeDays?: number;
}

export interface InventoryReservation {
  id: Id;
  expiresAt: IsoDateTime;
  lines: Array<ProductRef & { quantity: number }>;
}

export interface Customer {
  id: Id;
  email?: string;
  organizationId?: Id;
  billingAddress?: Address;
  shippingAddresses?: Address[];
  groups?: string[];
  taxIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface CustomerOrganization {
  id: Id;
  name: string;
  customerNumber?: string;
  groups?: string[];
  costCenters?: string[];
  budgets?: Array<{ key: string; remaining: Money; period?: string }>;
  contractIds?: Id[];
  metadata?: Record<string, unknown>;
}

export interface ProcurementContract {
  id: Id;
  customerOrganizationId: Id;
  contractNumber: string;
  state: "draft" | "active" | "expired" | "cancelled";
  validFrom: IsoDateTime;
  validUntil?: IsoDateTime;
  allowedProductIds?: Id[];
  allowedCategories?: string[];
  priceListId?: Id;
  maximumOrderValue?: Money;
  metadata?: Record<string, unknown>;
}

export interface BudgetDecision {
  allowed: boolean;
  budgetKey: string;
  requested: Money;
  remainingBefore?: Money;
  remainingAfter?: Money;
  reasons?: string[];
}

export interface BudgetReservation {
  id: Id;
  budgetKey: string;
  amount: Money;
  expiresAt?: IsoDateTime;
}

export interface CartLine extends ProductRef {
  id: Id;
  quantity: number;
  metadata?: Record<string, unknown>;
}

export interface Cart {
  id: Id;
  organizationId: Id;
  channelId: Id;
  customerId?: Id;
  customerOrganizationId?: Id;
  status: "open" | "locked" | "converted" | "abandoned";
  lines: CartLine[];
  couponCodes?: string[];
  purchaseOrderNumber?: string;
  costCenter?: string;
  version: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface CartPatch {
  couponCodes?: string[];
  purchaseOrderNumber?: string;
  costCenter?: string;
  metadata?: Record<string, unknown>;
}

export interface CheckoutInput {
  cartId: Id;
  customer?: Customer;
  billingAddress?: Address;
  shippingAddress?: Address;
  shippingMethodId?: Id;
  paymentMethodId?: Id;
  purchaseOrderNumber?: string;
  costCenter?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
}

export interface CheckoutSession {
  id: Id;
  cartId: Id;
  state:
    | "collecting"
    | "ready"
    | "approval_required"
    | "payment_required"
    | "completed"
    | "failed";
  missingFields?: string[];
  quote?: PriceQuote;
  nextAction?: Record<string, unknown>;
}

export interface OrderLine extends ProductRef {
  id: Id;
  quantity: number;
  unitPrice: Money;
  tax?: Money;
  total: Money;
  metadata?: Record<string, unknown>;
}

export type OrderState =
  | "pending"
  | "awaiting_approval"
  | "approved"
  | "payment_pending"
  | "confirmed"
  | "in_fulfillment"
  | "fulfilled"
  | "cancelled"
  | "rejected";

export interface Order {
  id: Id;
  organizationId: Id;
  channelId: Id;
  orderNumber: string;
  customerId?: Id;
  customerOrganizationId?: Id;
  state: OrderState;
  lines: OrderLine[];
  total: Money;
  billingAddress?: Address;
  shippingAddress?: Address;
  purchaseOrderNumber?: string;
  costCenter?: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  metadata?: Record<string, unknown>;
}

export interface PaymentIntent {
  id: Id;
  orderId: Id;
  amount: Money;
  state: "created" | "requires_action" | "authorized" | "captured" | "failed" | "cancelled";
  nextAction?: Record<string, unknown>;
}

export interface ShippingOption {
  id: Id;
  label: string;
  price: Money;
  estimatedDelivery?: { earliest?: IsoDateTime; latest?: IsoDateTime };
  metadata?: Record<string, unknown>;
}

export interface Fulfillment {
  id: Id;
  orderId: Id;
  state: "pending" | "processing" | "shipped" | "ready_for_pickup" | "delivered" | "cancelled";
  trackingCodes?: string[];
  lines: Array<{ orderLineId: Id; quantity: number }>;
}

export interface ApprovalRequest {
  id: Id;
  orderId?: Id;
  quoteId?: Id;
  requestedBy: Id;
  state: "pending" | "approved" | "rejected" | "cancelled";
  steps: Array<{
    key: string;
    approverRole?: string;
    approverUserId?: Id;
    state: "pending" | "approved" | "rejected" | "skipped";
  }>;
}

export interface CommercialQuote {
  id: Id;
  customerId?: Id;
  customerOrganizationId?: Id;
  state: "draft" | "sent" | "accepted" | "rejected" | "expired" | "converted";
  pricing: PriceQuote;
  validUntil: IsoDateTime;
  version: number;
}

export interface Invoice {
  id: Id;
  orderId: Id;
  number: string;
  format: "pdf" | "zugferd" | "xrechnung" | "structured";
  state: "draft" | "issued" | "cancelled" | "paid";
  total: Money;
  downloadUrl?: string;
}

export interface ReturnRequest {
  id: Id;
  orderId: Id;
  state: "requested" | "approved" | "rejected" | "received" | "refunded" | "closed";
  lines: Array<{ orderLineId: Id; quantity: number; reason?: string }>;
}

export interface CommerceEvent<T = unknown> {
  id: Id;
  type: string;
  organizationId: Id;
  channelId?: Id;
  occurredAt: IsoDateTime;
  correlationId: string;
  payload: T;
}

export interface CatalogProvider {
  getProduct(context: CommerceContext, ref: { productId?: Id; sku?: string }): Promise<Product | null>;
  listProducts(context: CommerceContext, query: ProductQuery): Promise<ProductPage>;
}

export interface PricingProvider {
  quote(context: CommerceContext, lines: PriceRequestLine[], customer?: Customer): Promise<PriceQuote>;
}

export interface InventoryProvider {
  check(context: CommerceContext, lines: PriceRequestLine[]): Promise<InventoryStatus[]>;
  reserve(context: CommerceContext, lines: PriceRequestLine[]): Promise<InventoryReservation>;
  release(context: CommerceContext, reservationId: Id): Promise<void>;
  commit(context: CommerceContext, reservationId: Id, orderId: Id): Promise<void>;
}

export interface CustomerProvider {
  getCustomer(context: CommerceContext, customerId: Id): Promise<Customer | null>;
  getOrganization(context: CommerceContext, organizationId: Id): Promise<CustomerOrganization | null>;
  saveCustomer(context: CommerceContext, customer: Customer): Promise<Customer>;
}

export interface CartProvider {
  create(context: CommerceContext, customer?: Customer): Promise<Cart>;
  get(context: CommerceContext, cartId: Id): Promise<Cart | null>;
  addLine(context: CommerceContext, cartId: Id, line: Omit<CartLine, "id">): Promise<Cart>;
  updateLine(context: CommerceContext, cartId: Id, lineId: Id, quantity: number): Promise<Cart>;
  removeLine(context: CommerceContext, cartId: Id, lineId: Id): Promise<Cart>;
  patch(context: CommerceContext, cartId: Id, patch: CartPatch): Promise<Cart>;
}

export interface CheckoutProvider {
  start(context: CommerceContext, input: CheckoutInput): Promise<CheckoutSession>;
  update(context: CommerceContext, sessionId: Id, input: Partial<CheckoutInput>): Promise<CheckoutSession>;
  complete(context: CommerceContext, sessionId: Id): Promise<Order>;
}

export interface OrderProvider {
  get(context: CommerceContext, orderId: Id): Promise<Order | null>;
  list(context: CommerceContext, query?: { customerId?: Id; state?: OrderState }): Promise<Order[]>;
  transition(context: CommerceContext, orderId: Id, target: OrderState, reason?: string): Promise<Order>;
  cancel(context: CommerceContext, orderId: Id, reason: string): Promise<Order>;
}

export interface PaymentProvider {
  createIntent(context: CommerceContext, order: Order, methodId: Id): Promise<PaymentIntent>;
  authorize(context: CommerceContext, intentId: Id): Promise<PaymentIntent>;
  capture(context: CommerceContext, intentId: Id, amount?: Money): Promise<PaymentIntent>;
  refund(context: CommerceContext, intentId: Id, amount: Money, reason?: string): Promise<PaymentIntent>;
  cancel(context: CommerceContext, intentId: Id): Promise<PaymentIntent>;
}

export interface TaxProvider {
  calculate(
    context: CommerceContext,
    lines: PriceLine[],
    billingAddress?: Address,
    shippingAddress?: Address,
  ): Promise<{ lines: Array<{ lineId?: Id; amount: Money; rate?: number }>; total: Money }>;
}

export interface DiscountProvider {
  apply(
    context: CommerceContext,
    quote: PriceQuote,
    couponCodes: string[],
    customer?: Customer,
  ): Promise<PriceQuote>;
}

export interface FulfillmentProvider {
  quoteShipping(
    context: CommerceContext,
    lines: CartLine[],
    destination: Address,
  ): Promise<ShippingOption[]>;
  create(context: CommerceContext, order: Order, shippingMethodId?: Id): Promise<Fulfillment>;
  get(context: CommerceContext, fulfillmentId: Id): Promise<Fulfillment | null>;
  cancel(context: CommerceContext, fulfillmentId: Id): Promise<Fulfillment>;
}

export interface ApprovalProvider {
  evaluate(context: CommerceContext, input: CheckoutInput, quote: PriceQuote): Promise<{
    required: boolean;
    reasons?: string[];
  }>;
  request(context: CommerceContext, order: Order): Promise<ApprovalRequest>;
  decide(
    context: CommerceContext,
    approvalId: Id,
    decision: "approve" | "reject",
    comment?: string,
  ): Promise<ApprovalRequest>;
}

export interface ContractProvider {
  get(context: CommerceContext, contractId: Id): Promise<ProcurementContract | null>;
  listForCustomerOrganization(
    context: CommerceContext,
    customerOrganizationId: Id,
  ): Promise<ProcurementContract[]>;
  validateCart(
    context: CommerceContext,
    contractId: Id,
    cart: Cart,
  ): Promise<{ valid: boolean; reasons?: string[] }>;
}

export interface BudgetProvider {
  check(
    context: CommerceContext,
    customerOrganizationId: Id,
    budgetKey: string,
    amount: Money,
  ): Promise<BudgetDecision>;
  reserve(
    context: CommerceContext,
    customerOrganizationId: Id,
    budgetKey: string,
    amount: Money,
  ): Promise<BudgetReservation>;
  release(context: CommerceContext, reservationId: Id): Promise<void>;
  commit(context: CommerceContext, reservationId: Id, orderId: Id): Promise<void>;
}

export interface QuoteProvider {
  create(context: CommerceContext, input: CheckoutInput, pricing: PriceQuote): Promise<CommercialQuote>;
  revise(context: CommerceContext, quoteId: Id, pricing: PriceQuote): Promise<CommercialQuote>;
  send(context: CommerceContext, quoteId: Id): Promise<CommercialQuote>;
  accept(context: CommerceContext, quoteId: Id): Promise<Order>;
  reject(context: CommerceContext, quoteId: Id, reason?: string): Promise<CommercialQuote>;
}

export interface InvoiceProvider {
  issue(context: CommerceContext, order: Order, format: Invoice["format"]): Promise<Invoice>;
  get(context: CommerceContext, invoiceId: Id): Promise<Invoice | null>;
  cancel(context: CommerceContext, invoiceId: Id, reason: string): Promise<Invoice>;
}

export interface ReturnProvider {
  request(
    context: CommerceContext,
    orderId: Id,
    lines: ReturnRequest["lines"],
  ): Promise<ReturnRequest>;
  decide(
    context: CommerceContext,
    returnId: Id,
    decision: "approve" | "reject",
    reason?: string,
  ): Promise<ReturnRequest>;
  receive(context: CommerceContext, returnId: Id): Promise<ReturnRequest>;
  refund(context: CommerceContext, returnId: Id): Promise<ReturnRequest>;
}

export interface ErpProvider {
  pushOrder(context: CommerceContext, order: Order): Promise<{ externalId: string }>;
  pullInventory(context: CommerceContext, refs: ProductRef[]): Promise<InventoryStatus[]>;
  pullPrices(context: CommerceContext, lines: PriceRequestLine[], customer?: Customer): Promise<PriceQuote>;
  syncCustomer(context: CommerceContext, customer: Customer): Promise<{ externalId: string }>;
}

export interface EventPublisher {
  publish<T>(event: CommerceEvent<T>): Promise<void>;
}
