import type {
  Customer,
  CustomerOrganization,
  Money,
  ProcurementContract,
  Product,
} from "../contracts.js";

export interface ReferenceFixtures {
  products: Product[];
  prices: Record<string, Money>;
  customerPrices?: Record<string, Record<string, Money>>;
  inventory: Record<string, number>;
  customers?: Customer[];
  customerOrganizations?: CustomerOrganization[];
  contracts?: ProcurementContract[];
}

export const defaultReferenceFixtures: ReferenceFixtures = {
  products: [
    {
      id: "product-laptop",
      organizationId: "merchant-1",
      contentObjectId: "content-product-laptop",
      sku: "LAPTOP-14",
      status: "active",
      productType: "physical",
      taxClass: "standard",
      variants: [{ id: "variant-laptop", sku: "LAPTOP-14" }],
    },
    {
      id: "product-service",
      organizationId: "merchant-1",
      contentObjectId: "content-product-service",
      sku: "SERVICE-SETUP",
      status: "active",
      productType: "service",
      taxClass: "standard",
      variants: [{ id: "variant-service", sku: "SERVICE-SETUP" }],
    },
  ],
  prices: {
    "LAPTOP-14": { amount: 119_900, currency: "EUR" },
    "SERVICE-SETUP": { amount: 25_000, currency: "EUR" },
  },
  customerPrices: {
    "customer-org-business": {
      "LAPTOP-14": { amount: 99_900, currency: "EUR" },
    },
    "customer-org-government": {
      "LAPTOP-14": { amount: 89_900, currency: "EUR" },
    },
  },
  inventory: {
    "LAPTOP-14": 20,
    "SERVICE-SETUP": 1_000,
  },
  customers: [
    {
      id: "customer-consumer",
      email: "consumer@example.test",
    },
    {
      id: "customer-buyer",
      email: "buyer@business.example",
      organizationId: "customer-org-business",
    },
    {
      id: "customer-procurement",
      email: "procurement@gov.example",
      organizationId: "customer-org-government",
    },
  ],
  customerOrganizations: [
    {
      id: "customer-org-business",
      name: "Business Buyer GmbH",
      customerNumber: "B2B-1000",
      groups: ["business"],
      costCenters: ["IT"],
    },
    {
      id: "customer-org-government",
      name: "Beispielbehörde",
      customerNumber: "B2G-1000",
      groups: ["government"],
      costCenters: ["DIGITAL"],
      budgets: [
        {
          key: "DIGITAL-2026",
          remaining: { amount: 500_000, currency: "EUR" },
          period: "2026",
        },
      ],
      contractIds: ["contract-government-it"],
    },
  ],
  contracts: [
    {
      id: "contract-government-it",
      customerOrganizationId: "customer-org-government",
      contractNumber: "RV-IT-2026",
      state: "active",
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: "2026-12-31T23:59:59.000Z",
      allowedProductIds: ["product-laptop", "product-service"],
      priceListId: "government-2026",
      maximumOrderValue: { amount: 300_000, currency: "EUR" },
    },
  ],
};
