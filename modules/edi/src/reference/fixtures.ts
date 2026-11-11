import type {
  PartnerAgreement,
  TradingPartner,
  TransportEndpoint,
} from "../contracts.js";

export interface ReferenceEdiFixtures {
  partners: TradingPartner[];
  agreements: PartnerAgreement[];
  endpoints: TransportEndpoint[];
}

const validFrom = "2026-01-01T00:00:00.000Z";

export const defaultReferenceEdiFixtures: ReferenceEdiFixtures = {
  partners: [
    {
      id: "partner-edifact",
      organizationId: "tenant-1",
      name: "EDIFACT Buyer",
      status: "active",
      identifiers: [{ scheme: "gln", value: "4000001000001" }],
    },
    {
      id: "partner-x12",
      organizationId: "tenant-1",
      name: "X12 Buyer",
      status: "active",
      identifiers: [{ scheme: "duns", value: "123456789" }],
    },
    {
      id: "partner-peppol",
      organizationId: "tenant-1",
      name: "Public Authority",
      status: "active",
      identifiers: [{ scheme: "iso6523-actorid-upis", value: "0204:991-12345-67" }],
    },
  ],
  endpoints: [
    {
      id: "endpoint-as2",
      partnerId: "partner-edifact",
      kind: "as2",
      direction: "bidirectional",
      address: "https://edi.example.test/as2",
      certificateRef: "secret://certs/edifact",
    },
    {
      id: "endpoint-sftp",
      partnerId: "partner-x12",
      kind: "sftp",
      direction: "bidirectional",
      address: "sftp://x12.example.test/inbox",
      credentialRef: "secret://sftp/x12",
    },
    {
      id: "endpoint-peppol",
      partnerId: "partner-peppol",
      kind: "peppol",
      direction: "bidirectional",
      address: "0204:991-12345-67",
      credentialRef: "secret://peppol/access-point",
    },
  ],
  agreements: [
    {
      id: "agreement-edifact",
      organizationId: "tenant-1",
      partnerId: "partner-edifact",
      name: "EDIFACT D.01B Orders",
      status: "active",
      validFrom,
      inboundProfiles: [{
        id: "profile-edifact-orders",
        syntax: "edifact",
        standard: "UN/EDIFACT",
        version: "D.01B",
        messageType: "ORDERS",
        businessDocument: "purchase_order",
        implementationGuide: "partner-orders-1",
      }],
      outboundProfiles: [{
        id: "profile-edifact-ordrsp",
        syntax: "edifact",
        standard: "UN/EDIFACT",
        version: "D.01B",
        messageType: "ORDRSP",
        businessDocument: "order_response",
      }],
      endpointIds: ["endpoint-as2"],
      acknowledgement: {
        transportReceipt: true,
        functional: true,
        application: true,
      },
      duplicateWindowSeconds: 86_400,
    },
    {
      id: "agreement-x12",
      organizationId: "tenant-1",
      partnerId: "partner-x12",
      name: "X12 Purchase Order",
      status: "active",
      validFrom,
      inboundProfiles: [{
        id: "profile-x12-850",
        syntax: "x12",
        standard: "ASC X12",
        version: "005010",
        messageType: "850",
        businessDocument: "purchase_order",
        implementationGuide: "partner-850",
      }],
      outboundProfiles: [{
        id: "profile-x12-855",
        syntax: "x12",
        standard: "ASC X12",
        version: "005010",
        messageType: "855",
        businessDocument: "order_response",
      }],
      endpointIds: ["endpoint-sftp"],
      acknowledgement: {
        transportReceipt: false,
        functional: true,
        application: true,
      },
      duplicateWindowSeconds: 86_400,
    },
    {
      id: "agreement-peppol",
      organizationId: "tenant-1",
      partnerId: "partner-peppol",
      name: "Peppol Billing",
      status: "active",
      validFrom,
      inboundProfiles: [{
        id: "profile-peppol-invoice",
        syntax: "ubl",
        standard: "Peppol BIS Billing 3.0",
        version: "release-configured",
        messageType: "Invoice",
        businessDocument: "invoice",
        customizationId: "urn:cen.eu:en16931:2017",
        profileId: "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0",
      }],
      outboundProfiles: [],
      endpointIds: ["endpoint-peppol"],
      acknowledgement: {
        transportReceipt: true,
        functional: true,
        application: true,
      },
      duplicateWindowSeconds: 86_400,
    },
  ],
};
