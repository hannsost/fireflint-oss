import type {
  Address,
  ApprovalRequest,
  BudgetDecision,
  BudgetReservation,
  Cart,
  CartLine,
  CartPatch,
  CheckoutInput,
  CheckoutSession,
  CommercialQuote,
  CommerceContext,
  CommerceEvent,
  Customer,
  CustomerOrganization,
  Fulfillment,
  InventoryReservation,
  InventoryStatus,
  Invoice,
  Money,
  Order,
  OrderState,
  PaymentIntent,
  PriceLine,
  PriceQuote,
  PriceRequestLine,
  ProcurementContract,
  Product,
  ProductPage,
  ProductQuery,
  ReturnRequest,
} from "../contracts.js";
import { CommerceEngine } from "../engine.js";
import { CommerceError } from "../errors.js";
import { commerceEventTypes } from "../events.js";
import type {
  CommerceCapability,
  CommerceModule,
  CommerceProfile,
  CommerceProviders,
} from "../module.js";
import { b2cProfile } from "../profiles.js";
import {
  defaultReferenceFixtures,
  type ReferenceFixtures,
} from "./fixtures.js";

interface StoredCheckout {
  session: CheckoutSession;
  input: CheckoutInput;
}

interface BudgetState {
  customerOrganizationId: string;
  budgetKey: string;
  remaining: Money;
}

export interface ReferenceCommerce {
  engine: CommerceEngine;
  sandbox: ReferenceCommerceSandbox;
}

export interface DirectCheckoutResult {
  order: Order;
  payment: PaymentIntent;
  reservation: InventoryReservation;
  fulfillment: Fulfillment;
}

export interface QuoteCheckoutResult {
  quote: CommercialQuote;
  order: Order;
  invoice: Invoice;
}

export interface ApprovalCheckoutResult {
  order: Order;
  approval: ApprovalRequest;
  budgetReservation: BudgetReservation;
  invoice: Invoice;
}

const referenceCapabilities: CommerceCapability[] = [
  "catalog",
  "pricing",
  "contract-pricing",
  "inventory",
  "cart",
  "checkout",
  "guest-checkout",
  "payments",
  "shipping",
  "pickup",
  "tax",
  "discounts",
  "customer-accounts",
  "organization-accounts",
  "contracts",
  "quotes",
  "approvals",
  "budgets",
  "cost-centers",
  "purchase-orders",
  "invoicing",
  "xrechnung",
  "zugferd",
  "returns",
  "erp",
];

export class ReferenceCommerceSandbox {
  readonly events: CommerceEvent[] = [];
  readonly providers: CommerceProviders;

  readonly #products = new Map<string, Product>();
  readonly #prices = new Map<string, Money>();
  readonly #customerPrices = new Map<string, Map<string, Money>>();
  readonly #inventory = new Map<string, number>();
  readonly #customers = new Map<string, Customer>();
  readonly #customerOrganizations = new Map<string, CustomerOrganization>();
  readonly #contracts = new Map<string, ProcurementContract>();
  readonly #budgets = new Map<string, BudgetState>();
  readonly #carts = new Map<string, Cart>();
  readonly #reservations = new Map<string, InventoryReservation>();
  readonly #budgetReservations = new Map<string, BudgetReservation>();
  readonly #checkouts = new Map<string, StoredCheckout>();
  readonly #orders = new Map<string, Order>();
  readonly #payments = new Map<string, PaymentIntent>();
  readonly #approvals = new Map<string, ApprovalRequest>();
  readonly #quotes = new Map<string, CommercialQuote>();
  readonly #invoices = new Map<string, Invoice>();
  readonly #fulfillments = new Map<string, Fulfillment>();
  readonly #returns = new Map<string, ReturnRequest>();
  readonly #idempotentOrders = new Map<string, Order>();
  #sequence = 0;

  constructor(
    readonly profile: CommerceProfile,
    fixtures: ReferenceFixtures = defaultReferenceFixtures,
  ) {
    this.loadFixtures(fixtures);
    this.providers = this.createProviders();
  }

  async directCheckout(
    context: CommerceContext,
    input: CheckoutInput,
  ): Promise<DirectCheckoutResult> {
    this.requireIdempotency(context);
    const existing = this.#idempotentOrders.get(context.idempotencyKey!);
    if (existing) {
      const payment = [...this.#payments.values()].find(
        (item) => item.orderId === existing.id,
      );
      const fulfillment = [...this.#fulfillments.values()].find(
        (item) => item.orderId === existing.id,
      );
      const reservationId = existing.metadata?.inventoryReservationId;
      const reservation =
        typeof reservationId === "string"
          ? this.#reservations.get(reservationId)
          : undefined;
      if (payment && fulfillment && reservation) {
        return { order: existing, payment, reservation, fulfillment };
      }
      throw new CommerceError(
        "IDEMPOTENCY_CONFLICT",
        "Stored idempotent result is incomplete",
      );
    }

    const cart = this.requireCart(input.cartId);
    const lines = this.toPriceRequests(cart);
    const quote = await this.providers.pricing.quote(context, lines, input.customer);
    const reservation = await this.providers.inventory.reserve(context, lines);
    let order = this.createOrder(context, cart, quote, input, "payment_pending", {
      inventoryReservationId: reservation.id,
    });
    const intent = await this.providers.payments.createIntent(
      context,
      order,
      input.paymentMethodId ?? "reference-payment",
    );
    await this.providers.payments.authorize(context, intent.id);
    const payment = await this.providers.payments.capture(context, intent.id);
    order = await this.providers.orders.transition(context, order.id, "confirmed");
    await this.providers.inventory.commit(context, reservation.id, order.id);
    const fulfillment = await this.providers.fulfillment.create(
      context,
      order,
      input.shippingMethodId,
    );
    this.convertCart(cart.id);
    this.#idempotentOrders.set(context.idempotencyKey!, order);
    return { order, payment, reservation, fulfillment };
  }

  async quoteCheckout(
    context: CommerceContext,
    input: CheckoutInput,
  ): Promise<QuoteCheckoutResult> {
    this.requireIdempotency(context);
    const cart = this.requireCart(input.cartId);
    this.requireCustomerOrganization(context, input.customer);
    const pricing = await this.providers.pricing.quote(
      context,
      this.toPriceRequests(cart),
      input.customer,
    );
    let quote = await this.providers.quotes.create(context, input, pricing);
    quote = await this.providers.quotes.send(context, quote.id);
    const order = await this.providers.quotes.accept(context, quote.id);
    quote = structuredClone(this.requireQuote(quote.id));
    const invoice = await this.providers.invoicing.issue(
      context,
      order,
      "structured",
    );
    this.convertCart(cart.id);
    return { quote, order, invoice };
  }

  async approvalCheckout(
    context: CommerceContext,
    input: CheckoutInput & { contractId: string; budgetKey: string },
  ): Promise<ApprovalCheckoutResult> {
    this.requireIdempotency(context);
    const cart = this.requireCart(input.cartId);
    const customerOrganizationId = this.requireCustomerOrganization(
      context,
      input.customer,
    );
    const contractResult = await this.providers.contracts.validateCart(
      context,
      input.contractId,
      cart,
    );
    if (!contractResult.valid) {
      throw new CommerceError(
        "CONTRACT_VIOLATION",
        "Cart violates procurement contract",
        { reasons: contractResult.reasons },
      );
    }
    const quote = await this.providers.pricing.quote(
      context,
      this.toPriceRequests(cart),
      input.customer,
    );
    const budgetReservation = await this.providers.budgets.reserve(
      context,
      customerOrganizationId,
      input.budgetKey,
      quote.grandTotal,
    );
    let order = this.createOrder(
      context,
      cart,
      quote,
      input,
      "awaiting_approval",
      {
        contractId: input.contractId,
        budgetReservationId: budgetReservation.id,
      },
    );
    const approval = await this.providers.approvals.request(context, order);
    await this.providers.approvals.decide(context, approval.id, "approve");
    order = await this.providers.orders.transition(context, order.id, "approved");
    order = await this.providers.orders.transition(context, order.id, "confirmed");
    await this.providers.budgets.commit(context, budgetReservation.id, order.id);
    const invoice = await this.providers.invoicing.issue(
      context,
      order,
      "xrechnung",
    );
    this.convertCart(cart.id);
    return { order, approval: this.#approvals.get(approval.id)!, budgetReservation, invoice };
  }

  private loadFixtures(fixtures: ReferenceFixtures): void {
    for (const product of fixtures.products) {
      this.#products.set(product.id, structuredClone(product));
    }
    for (const [sku, price] of Object.entries(fixtures.prices)) {
      this.#prices.set(sku, { ...price });
    }
    for (const [customerOrganizationId, prices] of Object.entries(
      fixtures.customerPrices ?? {},
    )) {
      this.#customerPrices.set(
        customerOrganizationId,
        new Map(
          Object.entries(prices).map(([sku, price]) => [sku, { ...price }]),
        ),
      );
    }
    for (const [sku, available] of Object.entries(fixtures.inventory)) {
      this.#inventory.set(sku, available);
    }
    for (const customer of fixtures.customers ?? []) {
      this.#customers.set(customer.id, structuredClone(customer));
    }
    for (const organization of fixtures.customerOrganizations ?? []) {
      this.#customerOrganizations.set(
        organization.id,
        structuredClone(organization),
      );
      for (const budget of organization.budgets ?? []) {
        this.#budgets.set(`${organization.id}:${budget.key}`, {
          customerOrganizationId: organization.id,
          budgetKey: budget.key,
          remaining: { ...budget.remaining },
        });
      }
    }
    for (const contract of fixtures.contracts ?? []) {
      this.#contracts.set(contract.id, structuredClone(contract));
    }
  }

  private createProviders(): CommerceProviders {
    return {
      catalog: {
        getProduct: async (context, ref) => {
          const product = [...this.#products.values()].find(
            (item) =>
              item.organizationId === context.organizationId &&
              (item.id === ref.productId ||
                item.sku === ref.sku ||
                item.variants.some((variant) => variant.sku === ref.sku)),
          );
          return product ? structuredClone(product) : null;
        },
        listProducts: async (context, query) =>
          this.listProducts(context, query),
      },
      pricing: {
        quote: async (context, lines, customer) =>
          this.price(context, lines, customer),
      },
      inventory: {
        check: async (_context, lines) => this.checkInventory(lines),
        reserve: async (context, lines) => this.reserveInventory(context, lines),
        release: async (context, reservationId) =>
          this.releaseInventory(context, reservationId),
        commit: async (_context, reservationId, _orderId) => {
          if (!this.#reservations.has(reservationId)) {
            throw new CommerceError(
              "INSUFFICIENT_STOCK",
              `Inventory reservation '${reservationId}' does not exist`,
            );
          }
        },
      },
      customers: {
        getCustomer: async (_context, customerId) => {
          const customer = this.#customers.get(customerId);
          return customer ? structuredClone(customer) : null;
        },
        getOrganization: async (_context, organizationId) => {
          const organization = this.#customerOrganizations.get(organizationId);
          return organization ? structuredClone(organization) : null;
        },
        saveCustomer: async (_context, customer) => {
          this.#customers.set(customer.id, structuredClone(customer));
          return structuredClone(customer);
        },
      },
      carts: {
        create: async (context, customer) => this.createCart(context, customer),
        get: async (_context, cartId) => {
          const cart = this.#carts.get(cartId);
          return cart ? structuredClone(cart) : null;
        },
        addLine: async (context, cartId, line) =>
          this.addCartLine(context, cartId, line),
        updateLine: async (context, cartId, lineId, quantity) =>
          this.updateCartLine(context, cartId, lineId, quantity),
        removeLine: async (context, cartId, lineId) =>
          this.removeCartLine(context, cartId, lineId),
        patch: async (context, cartId, patch) =>
          this.patchCart(context, cartId, patch),
      },
      checkout: {
        start: async (context, input) => this.startCheckout(context, input),
        update: async (_context, sessionId, input) =>
          this.updateCheckout(sessionId, input),
        complete: async (context, sessionId) =>
          this.completeCheckout(context, sessionId),
      },
      orders: {
        get: async (_context, orderId) => {
          const order = this.#orders.get(orderId);
          return order ? structuredClone(order) : null;
        },
        list: async (context, query) =>
          [...this.#orders.values()]
            .filter((order) => order.organizationId === context.organizationId)
            .filter((order) => !query?.customerId || order.customerId === query.customerId)
            .filter((order) => !query?.state || order.state === query.state)
            .map((order) => structuredClone(order)),
        transition: async (context, orderId, target) =>
          this.transitionOrder(context, orderId, target),
        cancel: async (context, orderId, reason) =>
          this.transitionOrder(context, orderId, "cancelled", reason),
      },
      payments: {
        createIntent: async (_context, order, _methodId) =>
          this.createPayment(order),
        authorize: async (context, intentId) =>
          this.transitionPayment(context, intentId, "authorized"),
        capture: async (context, intentId, amount) =>
          this.capturePayment(context, intentId, amount),
        refund: async (_context, intentId, amount) => {
          const payment = this.requirePayment(intentId);
          payment.amount = { ...amount };
          return structuredClone(payment);
        },
        cancel: async (_context, intentId) => {
          const payment = this.requirePayment(intentId);
          payment.state = "cancelled";
          return structuredClone(payment);
        },
      },
      tax: {
        calculate: async (context, lines) => {
          const total = this.money(
            lines.reduce((sum, line) => sum + Math.round(line.subtotal.amount * 0.19), 0),
            context.currency,
          );
          return {
            lines: lines.map((line) => ({
              lineId: line.lineId,
              amount: this.money(
                Math.round(line.subtotal.amount * 0.19),
                context.currency,
              ),
              rate: 0.19,
            })),
            total,
          };
        },
      },
      discounts: {
        apply: async (_context, quote, couponCodes) => {
          if (!couponCodes.includes("REFERENCE10")) {
            return structuredClone(quote);
          }
          const amount = -Math.round(quote.subtotal.amount * 0.1);
          return {
            ...structuredClone(quote),
            adjustments: [
              ...quote.adjustments,
              {
                code: "REFERENCE10",
                label: "Reference discount",
                amount: this.money(amount, quote.grandTotal.currency),
                source: "discount",
              },
            ],
            grandTotal: this.money(
              quote.grandTotal.amount + amount,
              quote.grandTotal.currency,
            ),
          };
        },
      },
      fulfillment: {
        quoteShipping: async (context, _lines, _destination) => [
          {
            id: "reference-standard",
            label: "Standard",
            price: this.money(590, context.currency),
          },
        ],
        create: async (context, order, _shippingMethodId) =>
          this.createFulfillment(context, order),
        get: async (_context, fulfillmentId) => {
          const fulfillment = this.#fulfillments.get(fulfillmentId);
          return fulfillment ? structuredClone(fulfillment) : null;
        },
        cancel: async (_context, fulfillmentId) => {
          const fulfillment = this.#fulfillments.get(fulfillmentId);
          if (!fulfillment) {
            throw new CommerceError(
              "VALIDATION_FAILED",
              `Fulfillment '${fulfillmentId}' not found`,
            );
          }
          fulfillment.state = "cancelled";
          return structuredClone(fulfillment);
        },
      },
      approvals: {
        evaluate: async (_context, _input, quote) => ({
          required: this.profile.settings.checkoutMode === "approval",
          reasons:
            this.profile.settings.checkoutMode === "approval"
              ? [`Approval profile active for ${quote.grandTotal.amount}`]
              : [],
        }),
        request: async (context, order) => this.createApproval(context, order),
        decide: async (context, approvalId, decision) =>
          this.decideApproval(context, approvalId, decision),
      },
      contracts: {
        get: async (_context, contractId) => {
          const contract = this.#contracts.get(contractId);
          return contract ? structuredClone(contract) : null;
        },
        listForCustomerOrganization: async (_context, customerOrganizationId) =>
          [...this.#contracts.values()]
            .filter(
              (contract) =>
                contract.customerOrganizationId === customerOrganizationId,
            )
            .map((contract) => structuredClone(contract)),
        validateCart: async (_context, contractId, cart) =>
          this.validateContract(contractId, cart),
      },
      budgets: {
        check: async (_context, customerOrganizationId, budgetKey, amount) =>
          this.checkBudget(customerOrganizationId, budgetKey, amount),
        reserve: async (context, customerOrganizationId, budgetKey, amount) =>
          this.reserveBudget(
            context,
            customerOrganizationId,
            budgetKey,
            amount,
          ),
        release: async (_context, reservationId) =>
          this.releaseBudget(reservationId),
        commit: async (_context, reservationId, _orderId) => {
          if (!this.#budgetReservations.has(reservationId)) {
            throw new CommerceError(
              "BUDGET_EXCEEDED",
              `Budget reservation '${reservationId}' does not exist`,
            );
          }
        },
      },
      quotes: {
        create: async (context, input, pricing) =>
          this.createQuote(context, input, pricing),
        revise: async (_context, quoteId, pricing) => {
          const quote = this.requireQuote(quoteId);
          quote.pricing = structuredClone(pricing);
          quote.version += 1;
          quote.state = "draft";
          return structuredClone(quote);
        },
        send: async (_context, quoteId) => {
          const quote = this.requireQuote(quoteId);
          quote.state = "sent";
          return structuredClone(quote);
        },
        accept: async (context, quoteId) => this.acceptQuote(context, quoteId),
        reject: async (_context, quoteId, _reason) => {
          const quote = this.requireQuote(quoteId);
          quote.state = "rejected";
          return structuredClone(quote);
        },
      },
      invoicing: {
        issue: async (context, order, format) =>
          this.issueInvoice(context, order, format),
        get: async (_context, invoiceId) => {
          const invoice = this.#invoices.get(invoiceId);
          return invoice ? structuredClone(invoice) : null;
        },
        cancel: async (_context, invoiceId, _reason) => {
          const invoice = this.#invoices.get(invoiceId);
          if (!invoice) {
            throw new CommerceError(
              "VALIDATION_FAILED",
              `Invoice '${invoiceId}' not found`,
            );
          }
          invoice.state = "cancelled";
          return structuredClone(invoice);
        },
      },
      returns: {
        request: async (_context, orderId, lines) => {
          this.requireOrder(orderId);
          const value: ReturnRequest = {
            id: this.nextId("return"),
            orderId,
            state: "requested",
            lines: structuredClone(lines),
          };
          this.#returns.set(value.id, value);
          return structuredClone(value);
        },
        decide: async (_context, returnId, decision) => {
          const value = this.requireReturn(returnId);
          value.state = decision === "approve" ? "approved" : "rejected";
          return structuredClone(value);
        },
        receive: async (_context, returnId) => {
          const value = this.requireReturn(returnId);
          value.state = "received";
          return structuredClone(value);
        },
        refund: async (_context, returnId) => {
          const value = this.requireReturn(returnId);
          value.state = "refunded";
          return structuredClone(value);
        },
      },
      erp: {
        pushOrder: async (_context, order) => ({
          externalId: `ERP-${order.orderNumber}`,
        }),
        pullInventory: async (_context, refs) =>
          this.checkInventory(
            refs.map((ref) => ({ ...ref, quantity: 1 })),
          ),
        pullPrices: async (context, lines, customer) =>
          this.price(context, lines, customer),
        syncCustomer: async (_context, customer) => ({
          externalId: `ERP-CUSTOMER-${customer.id}`,
        }),
      },
      events: {
        publish: async (event) => {
          this.events.push(structuredClone(event));
        },
      },
    };
  }

  private async listProducts(
    context: CommerceContext,
    query: ProductQuery,
  ): Promise<ProductPage> {
    const search = query.search?.toLowerCase();
    const items = [...this.#products.values()]
      .filter((product) => product.organizationId === context.organizationId)
      .filter((product) => !query.skus || query.skus.includes(product.sku))
      .filter(
        (product) => !query.productIds || query.productIds.includes(product.id),
      )
      .filter(
        (product) =>
          !search ||
          product.sku.toLowerCase().includes(search) ||
          product.id.toLowerCase().includes(search),
      )
      .slice(0, query.limit ?? 50)
      .map((product) => structuredClone(product));
    return { items };
  }

  private async price(
    context: CommerceContext,
    lines: PriceRequestLine[],
    customer?: Customer,
  ): Promise<PriceQuote> {
    const customerOrganizationId =
      customer?.organizationId ?? context.actor?.customerOrganizationId;
    const customerPriceMap = customerOrganizationId
      ? this.#customerPrices.get(customerOrganizationId)
      : undefined;
    const priceLines: PriceLine[] = lines.map((line) => {
      const unitPrice = customerPriceMap?.get(line.sku) ?? this.#prices.get(line.sku);
      if (!unitPrice || unitPrice.currency !== context.currency) {
        throw new CommerceError(
          "PRICE_UNAVAILABLE",
          `No ${context.currency} price for '${line.sku}'`,
        );
      }
      const subtotal = this.money(
        unitPrice.amount * line.quantity,
        unitPrice.currency,
      );
      return {
        product: {
          productId: line.productId,
          variantId: line.variantId,
          sku: line.sku,
        },
        quantity: line.quantity,
        unitPrice: { ...unitPrice },
        subtotal,
        total: { ...subtotal },
        priceSource: customerPriceMap?.has(line.sku)
          ? `customer:${customerOrganizationId}`
          : "public",
      };
    });
    const total = priceLines.reduce((sum, line) => sum + line.total.amount, 0);
    return {
      lines: priceLines,
      subtotal: this.money(total, context.currency),
      adjustments: [],
      grandTotal: this.money(total, context.currency),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
  }

  private checkInventory(lines: PriceRequestLine[]): InventoryStatus[] {
    return lines.map((line) => {
      const available = this.#inventory.get(line.sku);
      return {
        product: {
          productId: line.productId,
          variantId: line.variantId,
          sku: line.sku,
        },
        state:
          available === undefined
            ? "unknown"
            : available <= 0
              ? "out_of_stock"
              : available < line.quantity
                ? "low_stock"
                : "in_stock",
        available,
      };
    });
  }

  private async reserveInventory(
    context: CommerceContext,
    lines: PriceRequestLine[],
  ): Promise<InventoryReservation> {
    for (const line of lines) {
      const available = this.#inventory.get(line.sku) ?? 0;
      if (available < line.quantity) {
        throw new CommerceError(
          "INSUFFICIENT_STOCK",
          `Insufficient stock for '${line.sku}'`,
          { available, requested: line.quantity },
        );
      }
    }
    for (const line of lines) {
      this.#inventory.set(
        line.sku,
        (this.#inventory.get(line.sku) ?? 0) - line.quantity,
      );
    }
    const reservation: InventoryReservation = {
      id: this.nextId("inventory-reservation"),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      lines: structuredClone(lines),
    };
    this.#reservations.set(reservation.id, reservation);
    await this.emit(context, commerceEventTypes.inventoryReserved, reservation);
    return structuredClone(reservation);
  }

  private async releaseInventory(
    context: CommerceContext,
    reservationId: string,
  ): Promise<void> {
    const reservation = this.#reservations.get(reservationId);
    if (!reservation) return;
    for (const line of reservation.lines) {
      this.#inventory.set(
        line.sku,
        (this.#inventory.get(line.sku) ?? 0) + line.quantity,
      );
    }
    this.#reservations.delete(reservationId);
    await this.emit(context, commerceEventTypes.inventoryReleased, {
      reservationId,
    });
  }

  private async createCart(
    context: CommerceContext,
    customer?: Customer,
  ): Promise<Cart> {
    const now = new Date().toISOString();
    const cart: Cart = {
      id: this.nextId("cart"),
      organizationId: context.organizationId,
      channelId: context.channelId,
      customerId: customer?.id ?? context.actor?.customerId,
      customerOrganizationId:
        customer?.organizationId ?? context.actor?.customerOrganizationId,
      status: "open",
      lines: [],
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.#carts.set(cart.id, cart);
    await this.emit(context, commerceEventTypes.cartCreated, cart);
    return structuredClone(cart);
  }

  private async addCartLine(
    context: CommerceContext,
    cartId: string,
    line: Omit<CartLine, "id">,
  ): Promise<Cart> {
    const cart = this.requireOpenCart(cartId);
    cart.lines.push({ ...structuredClone(line), id: this.nextId("cart-line") });
    return this.touchCart(context, cart);
  }

  private async updateCartLine(
    context: CommerceContext,
    cartId: string,
    lineId: string,
    quantity: number,
  ): Promise<Cart> {
    const cart = this.requireOpenCart(cartId);
    const line = cart.lines.find((item) => item.id === lineId);
    if (!line || quantity < 1) {
      throw new CommerceError(
        "VALIDATION_FAILED",
        `Invalid cart line '${lineId}' or quantity`,
      );
    }
    line.quantity = quantity;
    return this.touchCart(context, cart);
  }

  private async removeCartLine(
    context: CommerceContext,
    cartId: string,
    lineId: string,
  ): Promise<Cart> {
    const cart = this.requireOpenCart(cartId);
    cart.lines = cart.lines.filter((line) => line.id !== lineId);
    return this.touchCart(context, cart);
  }

  private async patchCart(
    context: CommerceContext,
    cartId: string,
    patch: CartPatch,
  ): Promise<Cart> {
    const cart = this.requireOpenCart(cartId);
    if (patch.couponCodes) cart.couponCodes = [...patch.couponCodes];
    if (patch.purchaseOrderNumber !== undefined) {
      cart.purchaseOrderNumber = patch.purchaseOrderNumber;
    }
    if (patch.costCenter !== undefined) cart.costCenter = patch.costCenter;
    return this.touchCart(context, cart);
  }

  private async touchCart(
    context: CommerceContext,
    cart: Cart,
  ): Promise<Cart> {
    cart.version += 1;
    cart.updatedAt = new Date().toISOString();
    await this.emit(context, commerceEventTypes.cartUpdated, cart);
    return structuredClone(cart);
  }

  private async startCheckout(
    context: CommerceContext,
    input: CheckoutInput,
  ): Promise<CheckoutSession> {
    const cart = this.requireCart(input.cartId);
    const quote = await this.providers.pricing.quote(
      context,
      this.toPriceRequests(cart),
      input.customer,
    );
    const state =
      this.profile.settings.checkoutMode === "approval"
        ? "approval_required"
        : this.profile.settings.paymentRequired
          ? "payment_required"
          : "ready";
    const session: CheckoutSession = {
      id: this.nextId("checkout"),
      cartId: cart.id,
      state,
      quote,
    };
    this.#checkouts.set(session.id, {
      session,
      input: structuredClone(input),
    });
    return structuredClone(session);
  }

  private async updateCheckout(
    sessionId: string,
    input: Partial<CheckoutInput>,
  ): Promise<CheckoutSession> {
    const stored = this.#checkouts.get(sessionId);
    if (!stored) {
      throw new CommerceError(
        "VALIDATION_FAILED",
        `Checkout '${sessionId}' not found`,
      );
    }
    stored.input = { ...stored.input, ...structuredClone(input) };
    return structuredClone(stored.session);
  }

  private async completeCheckout(
    context: CommerceContext,
    sessionId: string,
  ): Promise<Order> {
    const stored = this.#checkouts.get(sessionId);
    if (!stored) {
      throw new CommerceError(
        "VALIDATION_FAILED",
        `Checkout '${sessionId}' not found`,
      );
    }
    if (this.profile.settings.checkoutMode !== "direct") {
      throw new CommerceError(
        "APPROVAL_REQUIRED",
        "Reference generic completion is only available for direct checkout",
      );
    }
    const result = await this.directCheckout(context, stored.input);
    stored.session.state = "completed";
    return result.order;
  }

  private createOrder(
    context: CommerceContext,
    cart: Cart,
    quote: PriceQuote,
    input: CheckoutInput,
    state: OrderState,
    metadata?: Record<string, unknown>,
  ): Order {
    const now = new Date().toISOString();
    const order: Order = {
      id: this.nextId("order"),
      organizationId: context.organizationId,
      channelId: context.channelId,
      orderNumber: `REF-${String(this.#sequence).padStart(6, "0")}`,
      customerId: input.customer?.id ?? cart.customerId,
      customerOrganizationId:
        input.customer?.organizationId ?? cart.customerOrganizationId,
      state,
      lines: quote.lines.map((line) => ({
        id: this.nextId("order-line"),
        ...line.product,
        quantity: line.quantity,
        unitPrice: { ...line.unitPrice },
        total: { ...line.total },
      })),
      total: { ...quote.grandTotal },
      billingAddress: input.billingAddress,
      shippingAddress: input.shippingAddress,
      purchaseOrderNumber:
        input.purchaseOrderNumber ?? cart.purchaseOrderNumber,
      costCenter: input.costCenter ?? cart.costCenter,
      createdAt: now,
      updatedAt: now,
      metadata,
    };
    this.#orders.set(order.id, order);
    void this.emit(context, commerceEventTypes.orderCreated, order);
    return structuredClone(order);
  }

  private async transitionOrder(
    context: CommerceContext,
    orderId: string,
    target: OrderState,
    reason?: string,
  ): Promise<Order> {
    const order = this.requireOrder(orderId);
    const allowed: Record<OrderState, OrderState[]> = {
      pending: ["awaiting_approval", "payment_pending", "confirmed", "cancelled"],
      awaiting_approval: ["approved", "rejected", "cancelled"],
      approved: ["payment_pending", "confirmed", "cancelled"],
      payment_pending: ["confirmed", "cancelled"],
      confirmed: ["in_fulfillment", "cancelled"],
      in_fulfillment: ["fulfilled", "cancelled"],
      fulfilled: [],
      cancelled: [],
      rejected: [],
    };
    if (!allowed[order.state].includes(target)) {
      throw new CommerceError(
        "INVALID_STATE_TRANSITION",
        `Cannot transition order from '${order.state}' to '${target}'`,
        { reason },
      );
    }
    order.state = target;
    order.updatedAt = new Date().toISOString();
    if (target === "approved") {
      await this.emit(context, commerceEventTypes.orderApproved, order);
    }
    if (target === "confirmed") {
      await this.emit(context, commerceEventTypes.orderConfirmed, order);
    }
    return structuredClone(order);
  }

  private createPayment(order: Order): PaymentIntent {
    const payment: PaymentIntent = {
      id: this.nextId("payment"),
      orderId: order.id,
      amount: { ...order.total },
      state: "created",
    };
    this.#payments.set(payment.id, payment);
    return structuredClone(payment);
  }

  private async transitionPayment(
    context: CommerceContext,
    intentId: string,
    state: PaymentIntent["state"],
  ): Promise<PaymentIntent> {
    const payment = this.requirePayment(intentId);
    payment.state = state;
    if (state === "authorized") {
      await this.emit(context, commerceEventTypes.paymentAuthorized, payment);
    }
    return structuredClone(payment);
  }

  private async capturePayment(
    context: CommerceContext,
    intentId: string,
    amount?: Money,
  ): Promise<PaymentIntent> {
    const payment = this.requirePayment(intentId);
    if (!["authorized", "created"].includes(payment.state)) {
      throw new CommerceError(
        "PAYMENT_FAILED",
        `Payment '${intentId}' cannot be captured from '${payment.state}'`,
      );
    }
    if (amount) payment.amount = { ...amount };
    payment.state = "captured";
    await this.emit(context, commerceEventTypes.paymentCaptured, payment);
    return structuredClone(payment);
  }

  private async createFulfillment(
    context: CommerceContext,
    order: Order,
  ): Promise<Fulfillment> {
    const fulfillment: Fulfillment = {
      id: this.nextId("fulfillment"),
      orderId: order.id,
      state: "processing",
      lines: order.lines.map((line) => ({
        orderLineId: line.id,
        quantity: line.quantity,
      })),
    };
    this.#fulfillments.set(fulfillment.id, fulfillment);
    await this.emit(
      context,
      commerceEventTypes.fulfillmentCreated,
      fulfillment,
    );
    return structuredClone(fulfillment);
  }

  private async createApproval(
    context: CommerceContext,
    order: Order,
  ): Promise<ApprovalRequest> {
    const approval: ApprovalRequest = {
      id: this.nextId("approval"),
      orderId: order.id,
      requestedBy: context.actor?.userId ?? "reference-user",
      state: "pending",
      steps: [
        {
          key: "procurement",
          approverRole: "approver",
          state: "pending",
        },
      ],
    };
    this.#approvals.set(approval.id, approval);
    await this.emit(context, commerceEventTypes.approvalRequested, approval);
    return structuredClone(approval);
  }

  private async decideApproval(
    context: CommerceContext,
    approvalId: string,
    decision: "approve" | "reject",
  ): Promise<ApprovalRequest> {
    const approval = this.#approvals.get(approvalId);
    if (!approval) {
      throw new CommerceError(
        "APPROVAL_NOT_FOUND",
        `Approval '${approvalId}' not found`,
      );
    }
    approval.state = decision === "approve" ? "approved" : "rejected";
    const step = approval.steps[0];
    if (step) step.state = approval.state;
    await this.emit(context, commerceEventTypes.approvalDecided, approval);
    return structuredClone(approval);
  }

  private validateContract(
    contractId: string,
    cart: Cart,
  ): { valid: boolean; reasons?: string[] } {
    const contract = this.#contracts.get(contractId);
    if (!contract) {
      throw new CommerceError(
        "CONTRACT_NOT_FOUND",
        `Contract '${contractId}' not found`,
      );
    }
    const reasons: string[] = [];
    if (contract.state !== "active") reasons.push("Contract is not active");
    if (
      contract.customerOrganizationId !== cart.customerOrganizationId
    ) {
      reasons.push("Contract belongs to another customer organization");
    }
    const allowed = contract.allowedProductIds;
    if (allowed) {
      for (const line of cart.lines) {
        if (!allowed.includes(line.productId)) {
          reasons.push(`Product '${line.productId}' is not allowed`);
        }
      }
    }
    return { valid: reasons.length === 0, reasons };
  }

  private checkBudget(
    customerOrganizationId: string,
    budgetKey: string,
    amount: Money,
  ): BudgetDecision {
    const budget = this.#budgets.get(
      `${customerOrganizationId}:${budgetKey}`,
    );
    const allowed =
      !!budget &&
      budget.remaining.currency === amount.currency &&
      budget.remaining.amount >= amount.amount;
    return {
      allowed,
      budgetKey,
      requested: { ...amount },
      remainingBefore: budget ? { ...budget.remaining } : undefined,
      remainingAfter:
        budget && allowed
          ? this.money(
              budget.remaining.amount - amount.amount,
              amount.currency,
            )
          : undefined,
      reasons: allowed ? [] : ["Budget is missing, incompatible or exceeded"],
    };
  }

  private async reserveBudget(
    context: CommerceContext,
    customerOrganizationId: string,
    budgetKey: string,
    amount: Money,
  ): Promise<BudgetReservation> {
    const decision = this.checkBudget(
      customerOrganizationId,
      budgetKey,
      amount,
    );
    if (!decision.allowed || !decision.remainingAfter) {
      throw new CommerceError("BUDGET_EXCEEDED", "Budget check failed", {
        decision,
      });
    }
    const budget = this.#budgets.get(
      `${customerOrganizationId}:${budgetKey}`,
    )!;
    budget.remaining = { ...decision.remainingAfter };
    const reservation: BudgetReservation = {
      id: this.nextId("budget-reservation"),
      budgetKey,
      amount: { ...amount },
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
    this.#budgetReservations.set(reservation.id, reservation);
    await this.emit(context, commerceEventTypes.budgetReserved, reservation);
    return structuredClone(reservation);
  }

  private async releaseBudget(reservationId: string): Promise<void> {
    const reservation = this.#budgetReservations.get(reservationId);
    if (!reservation) return;
    const budget = [...this.#budgets.values()].find(
      (item) => item.budgetKey === reservation.budgetKey,
    );
    if (budget) {
      budget.remaining = this.money(
        budget.remaining.amount + reservation.amount.amount,
        reservation.amount.currency,
      );
    }
    this.#budgetReservations.delete(reservationId);
  }

  private async createQuote(
    context: CommerceContext,
    input: CheckoutInput,
    pricing: PriceQuote,
  ): Promise<CommercialQuote> {
    const quote: CommercialQuote = {
      id: this.nextId("quote"),
      customerId: input.customer?.id ?? context.actor?.customerId,
      customerOrganizationId:
        input.customer?.organizationId ??
        context.actor?.customerOrganizationId,
      state: "draft",
      pricing: structuredClone(pricing),
      validUntil: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
      version: 1,
    };
    this.#quotes.set(quote.id, quote);
    return structuredClone(quote);
  }

  private async acceptQuote(
    context: CommerceContext,
    quoteId: string,
  ): Promise<Order> {
    const quote = this.requireQuote(quoteId);
    if (quote.state !== "sent") {
      throw new CommerceError(
        "INVALID_STATE_TRANSITION",
        `Quote '${quoteId}' must be sent before acceptance`,
      );
    }
    quote.state = "converted";
    const cart = [...this.#carts.values()].find(
      (item) =>
        item.status === "open" &&
        item.customerOrganizationId === quote.customerOrganizationId,
    );
    if (!cart) {
      throw new CommerceError("CART_NOT_FOUND", "No cart for accepted quote");
    }
    return this.createOrder(
      context,
      cart,
      quote.pricing,
      {
        cartId: cart.id,
        purchaseOrderNumber: cart.purchaseOrderNumber,
        costCenter: cart.costCenter,
      },
      "confirmed",
      { quoteId },
    );
  }

  private async issueInvoice(
    context: CommerceContext,
    order: Order,
    format: Invoice["format"],
  ): Promise<Invoice> {
    const invoice: Invoice = {
      id: this.nextId("invoice"),
      orderId: order.id,
      number: `INV-${String(this.#sequence).padStart(6, "0")}`,
      format,
      state: "issued",
      total: { ...order.total },
      downloadUrl: `https://reference.invalid/invoices/${order.id}`,
    };
    this.#invoices.set(invoice.id, invoice);
    await this.emit(context, commerceEventTypes.invoiceIssued, invoice);
    return structuredClone(invoice);
  }

  private requireCustomerOrganization(
    context: CommerceContext,
    customer?: Customer,
  ): string {
    const value =
      customer?.organizationId ?? context.actor?.customerOrganizationId;
    if (!value) {
      throw new CommerceError(
        "CUSTOMER_ORGANIZATION_REQUIRED",
        "A customer organization is required for this flow",
      );
    }
    return value;
  }

  private requireIdempotency(context: CommerceContext): void {
    if (!context.idempotencyKey) {
      throw new CommerceError(
        "IDEMPOTENCY_KEY_REQUIRED",
        "A checkout requires an idempotency key",
      );
    }
  }

  private requireCart(cartId: string): Cart {
    const cart = this.#carts.get(cartId);
    if (!cart) {
      throw new CommerceError("CART_NOT_FOUND", `Cart '${cartId}' not found`);
    }
    return cart;
  }

  private requireOpenCart(cartId: string): Cart {
    const cart = this.requireCart(cartId);
    if (cart.status !== "open") {
      throw new CommerceError(
        "CART_NOT_OPEN",
        `Cart '${cartId}' is '${cart.status}'`,
      );
    }
    return cart;
  }

  private requireOrder(orderId: string): Order {
    const order = this.#orders.get(orderId);
    if (!order) {
      throw new CommerceError(
        "ORDER_NOT_FOUND",
        `Order '${orderId}' not found`,
      );
    }
    return order;
  }

  private requirePayment(intentId: string): PaymentIntent {
    const payment = this.#payments.get(intentId);
    if (!payment) {
      throw new CommerceError(
        "PAYMENT_FAILED",
        `Payment '${intentId}' not found`,
      );
    }
    return payment;
  }

  private requireQuote(quoteId: string): CommercialQuote {
    const quote = this.#quotes.get(quoteId);
    if (!quote) {
      throw new CommerceError(
        "VALIDATION_FAILED",
        `Quote '${quoteId}' not found`,
      );
    }
    return quote;
  }

  private requireReturn(returnId: string): ReturnRequest {
    const value = this.#returns.get(returnId);
    if (!value) {
      throw new CommerceError(
        "VALIDATION_FAILED",
        `Return '${returnId}' not found`,
      );
    }
    return value;
  }

  private convertCart(cartId: string): void {
    const cart = this.requireCart(cartId);
    cart.status = "converted";
    cart.updatedAt = new Date().toISOString();
  }

  private toPriceRequests(cart: Cart): PriceRequestLine[] {
    if (cart.lines.length === 0) {
      throw new CommerceError("VALIDATION_FAILED", "Cart is empty");
    }
    return cart.lines.map(({ id: _id, metadata: _metadata, ...line }) => line);
  }

  private money(amount: number, currency: string): Money {
    return { amount, currency };
  }

  private nextId(prefix: string): string {
    this.#sequence += 1;
    return `${prefix}-${this.#sequence}`;
  }

  private async emit(
    context: CommerceContext,
    type: string,
    payload: unknown,
  ): Promise<void> {
    await this.providers.events.publish({
      id: this.nextId("event"),
      type,
      organizationId: context.organizationId,
      channelId: context.channelId,
      occurredAt: new Date().toISOString(),
      correlationId: context.correlationId,
      payload,
    });
  }
}

export function createReferenceModule(
  sandbox: ReferenceCommerceSandbox,
): CommerceModule {
  return {
    manifest: {
      key: "sitegraph-reference-commerce",
      name: "SiteGraph Reference Commerce",
      version: "0.1.0",
      audiences: ["b2c", "b2b", "b2g"],
      capabilities: referenceCapabilities,
      description:
        "Non-production in-memory providers used for contract and scenario tests.",
    },
    setup(context) {
      for (const [kind, provider] of Object.entries(sandbox.providers)) {
        context.registerProvider(
          kind as keyof CommerceProviders,
          provider as CommerceProviders[keyof CommerceProviders],
        );
      }
    },
  };
}

export async function createReferenceCommerce(
  profile: CommerceProfile = b2cProfile,
  fixtures: ReferenceFixtures = defaultReferenceFixtures,
): Promise<ReferenceCommerce> {
  const sandbox = new ReferenceCommerceSandbox(profile, fixtures);
  const engine = await CommerceEngine.create({
    profile,
    modules: [createReferenceModule(sandbox)],
  });
  return { engine, sandbox };
}

export function referenceContext(
  overrides: Partial<CommerceContext> = {},
): CommerceContext {
  return {
    organizationId: "merchant-1",
    channelId: "channel-main",
    locale: "de-DE",
    currency: "EUR",
    correlationId: "reference-correlation",
    ...overrides,
  };
}

export const referenceShippingAddress: Address = {
  name: "Reference Buyer",
  street: "Teststraße 1",
  postalCode: "10115",
  city: "Berlin",
  countryCode: "DE",
};

export function referenceProductLine(
  quantity = 1,
): Omit<CartLine, "id"> {
  return {
    productId: "product-laptop",
    variantId: "variant-laptop",
    sku: "LAPTOP-14",
    quantity,
  };
}
