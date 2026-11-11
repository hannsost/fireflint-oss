import type {
  ApprovalProvider,
  Audience,
  BudgetProvider,
  CartProvider,
  CatalogProvider,
  CheckoutProvider,
  ContractProvider,
  CustomerProvider,
  DiscountProvider,
  ErpProvider,
  EventPublisher,
  FulfillmentProvider,
  InventoryProvider,
  InvoiceProvider,
  OrderProvider,
  PaymentProvider,
  PricingProvider,
  QuoteProvider,
  ReturnProvider,
  TaxProvider,
} from "./contracts.js";

export interface CommerceProviders {
  catalog: CatalogProvider;
  pricing: PricingProvider;
  inventory: InventoryProvider;
  customers: CustomerProvider;
  carts: CartProvider;
  checkout: CheckoutProvider;
  orders: OrderProvider;
  payments: PaymentProvider;
  tax: TaxProvider;
  discounts: DiscountProvider;
  fulfillment: FulfillmentProvider;
  approvals: ApprovalProvider;
  contracts: ContractProvider;
  budgets: BudgetProvider;
  quotes: QuoteProvider;
  invoicing: InvoiceProvider;
  returns: ReturnProvider;
  erp: ErpProvider;
  events: EventPublisher;
}

export type ProviderKind = keyof CommerceProviders;

export type CommerceCapability =
  | "catalog"
  | "pricing"
  | "contract-pricing"
  | "inventory"
  | "cart"
  | "checkout"
  | "guest-checkout"
  | "payments"
  | "shipping"
  | "pickup"
  | "tax"
  | "discounts"
  | "customer-accounts"
  | "organization-accounts"
  | "contracts"
  | "quotes"
  | "approvals"
  | "budgets"
  | "cost-centers"
  | "purchase-orders"
  | "invoicing"
  | "xrechnung"
  | "zugferd"
  | "returns"
  | "erp";

export interface CommerceModuleManifest {
  key: string;
  name: string;
  version: string;
  audiences: Audience[];
  capabilities: CommerceCapability[];
  description?: string;
  requires?: {
    modules?: string[];
    providers?: ProviderKind[];
    capabilities?: CommerceCapability[];
  };
}

export interface CommerceModuleContext {
  registerProvider<K extends ProviderKind>(
    kind: K,
    provider: CommerceProviders[K],
    options?: { replace?: boolean },
  ): void;
  hasProvider(kind: ProviderKind): boolean;
}

export interface CommerceModule {
  manifest: CommerceModuleManifest;
  setup(context: CommerceModuleContext): void | Promise<void>;
}

export interface CommerceProfile {
  key: string;
  audience: Audience;
  description: string;
  capabilities: CommerceCapability[];
  requiredProviders: ProviderKind[];
  settings: {
    checkoutMode: "direct" | "quote" | "approval";
    customerMode: "guest_or_account" | "account" | "organization";
    pricingMode: "public" | "customer" | "contract";
    taxDisplay: "gross" | "net" | "mixed";
    paymentRequired: boolean;
  };
}
