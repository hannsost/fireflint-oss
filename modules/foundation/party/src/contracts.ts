export type Id = string;
export type IsoDateTime = string;
export type PartyKind = "person" | "organization" | "organizational_unit" | "location";

export interface PartyContext {
  organizationId: Id;
  correlationId: string;
  actorId?: Id;
}

export interface PartyIdentifier {
  scheme: string;
  value: string;
  issuer?: string;
  validFrom?: IsoDateTime;
  validUntil?: IsoDateTime;
  verified?: boolean;
}

export interface ContactPoint {
  id: Id;
  type: "email" | "phone" | "mobile" | "fax" | "url" | "messaging";
  value: string;
  label?: string;
  primary?: boolean;
  verified?: boolean;
}

export interface Address {
  id: Id;
  type: "postal" | "billing" | "shipping" | "visiting" | "legal";
  street?: string;
  street2?: string;
  postalCode?: string;
  city?: string;
  region?: string;
  countryCode: string;
  validFrom?: IsoDateTime;
  validUntil?: IsoDateTime;
}

export interface AlternativeName {
  value: string;
  type: "alias" | "former" | "trade" | "localized";
  locale?: string;
  validFrom?: IsoDateTime;
  validUntil?: IsoDateTime;
}

export interface SourceReference {
  system: string;
  externalId: string;
  importedAt: IsoDateTime;
  authoritative: boolean;
}

export interface Party {
  id: Id;
  tenantId: Id;
  kind: PartyKind;
  displayName: string;
  legalName?: string;
  givenName?: string;
  familyName?: string;
  alternativeNames?: AlternativeName[];
  status: "active" | "inactive" | "merged" | "archived";
  identifiers: PartyIdentifier[];
  contacts: ContactPoint[];
  addresses: Address[];
  sources?: SourceReference[];
  mergedIntoId?: Id;
  metadata?: Record<string, unknown>;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface PartyRole {
  id: Id;
  partyId: Id;
  role: string;
  contextType?: string;
  contextId?: Id;
  validFrom?: IsoDateTime;
  validUntil?: IsoDateTime;
}

export interface PartyRelationship {
  id: Id;
  fromPartyId: Id;
  toPartyId: Id;
  type: string;
  validFrom?: IsoDateTime;
  validUntil?: IsoDateTime;
  metadata?: Record<string, unknown>;
}

export interface DuplicateCandidate {
  partyId: Id;
  score: number;
  reasons: string[];
}

export interface MergeResult {
  survivingParty: Party;
  mergedPartyIds: Id[];
  conflicts: Array<{ field: string; values: unknown[] }>;
}

export interface MergePreview extends MergeResult {
  identifierConflicts: Array<{
    scheme: string;
    values: string[];
  }>;
}

export interface PartyProvider {
  create(context: PartyContext, input: Omit<Party, "id" | "tenantId" | "status" | "createdAt" | "updatedAt">): Promise<Party>;
  get(context: PartyContext, partyId: Id): Promise<Party | null>;
  findByIdentifier(context: PartyContext, identifier: PartyIdentifier): Promise<Party | null>;
  search(context: PartyContext, query: string): Promise<Party[]>;
  update(context: PartyContext, partyId: Id, patch: Partial<Pick<Party, "displayName" | "legalName" | "givenName" | "familyName" | "contacts" | "addresses" | "metadata">>): Promise<Party>;
  archive(context: PartyContext, partyId: Id): Promise<Party>;
  preferredContact(
    context: PartyContext,
    partyId: Id,
    type: ContactPoint["type"],
  ): Promise<ContactPoint | null>;
}

export interface RelationshipProvider {
  addRole(context: PartyContext, role: Omit<PartyRole, "id">): Promise<PartyRole>;
  endRole(context: PartyContext, roleId: Id, validUntil?: IsoDateTime): Promise<PartyRole>;
  roles(context: PartyContext, partyId: Id): Promise<PartyRole[]>;
  activeRoles(
    context: PartyContext,
    partyId: Id,
    at?: IsoDateTime,
  ): Promise<PartyRole[]>;
  relate(context: PartyContext, relationship: Omit<PartyRelationship, "id">): Promise<PartyRelationship>;
  relationships(context: PartyContext, partyId: Id): Promise<PartyRelationship[]>;
  activeRelationships(
    context: PartyContext,
    partyId: Id,
    at?: IsoDateTime,
  ): Promise<PartyRelationship[]>;
  ancestors(
    context: PartyContext,
    partyId: Id,
    relationshipType: string,
  ): Promise<Party[]>;
  descendants(
    context: PartyContext,
    partyId: Id,
    relationshipType: string,
  ): Promise<Party[]>;
}

export interface DeduplicationProvider {
  candidates(context: PartyContext, party: Party): Promise<DuplicateCandidate[]>;
  previewMerge(
    context: PartyContext,
    survivingPartyId: Id,
    mergedPartyIds: Id[],
  ): Promise<MergePreview>;
  merge(context: PartyContext, survivingPartyId: Id, mergedPartyIds: Id[]): Promise<MergeResult>;
}
