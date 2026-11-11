export type Id = string;
export type IsoDateTime = string;
export interface AccessContext {
  organizationId: Id;
  principalId: Id;
  correlationId: string;
  assuranceLevel?: "none" | "single_factor" | "mfa" | "hardware";
  attributes?: Record<string, string | number | boolean | string[]>;
}
export interface Principal {
  id: Id;
  organizationId: Id;
  type: "human" | "service" | "system";
  partyId?: Id;
  displayName: string;
  status: "active" | "disabled" | "locked" | "expired";
  authenticationMethods: string[];
  createdAt: IsoDateTime;
}
export interface Group {
  id: Id;
  organizationId: Id;
  name: string;
  principalIds: Id[];
}
export interface Role {
  id: Id;
  key: string;
  name: string;
  permissions: string[];
}
export interface RoleGrant {
  id: Id;
  principalId?: Id;
  groupId?: Id;
  roleId: Id;
  scope: { type: "organization" | "channel" | "resource" | "domain"; id?: Id };
  validFrom?: IsoDateTime;
  validUntil?: IsoDateTime;
  revokedAt?: IsoDateTime;
  revokedByPrincipalId?: Id;
  conditions?: Record<string, unknown>;
}

export interface ExternalIdentity {
  id: Id;
  organizationId: Id;
  principalId: Id;
  provider: string;
  issuer: string;
  subject: string;
  email?: string;
  linkedAt: IsoDateTime;
  lastAuthenticatedAt?: IsoDateTime;
}
export interface Delegation {
  id: Id;
  fromPrincipalId: Id;
  toPrincipalId: Id;
  permissions: string[];
  scope: RoleGrant["scope"];
  validFrom: IsoDateTime;
  validUntil: IsoDateTime;
  reason?: string;
  revokedAt?: IsoDateTime;
}
export interface AccessRequest {
  permission: string;
  resource: { type: string; id?: Id; organizationId: Id; attributes?: Record<string, unknown> };
  requiredAssurance?: AccessContext["assuranceLevel"];
}
export interface AccessDecision {
  allowed: boolean;
  reason: string;
  matchedGrantIds: Id[];
  obligations?: Array<{ type: string; value?: unknown }>;
}

export interface PolicyRule {
  id: Id;
  organizationId: Id;
  effect: "allow" | "deny";
  permissions: string[];
  principalIds?: Id[];
  groupIds?: Id[];
  resourceTypes?: string[];
  conditions?: Record<string, string | number | boolean>;
  obligations?: Array<{ type: string; value?: unknown }>;
  priority: number;
  enabled: boolean;
}
export interface PrincipalProvider {
  create(context: Omit<AccessContext, "principalId">, input: Omit<Principal, "id" | "organizationId" | "status" | "createdAt">): Promise<Principal>;
  get(context: AccessContext, principalId: Id): Promise<Principal | null>;
  disable(context: AccessContext, principalId: Id): Promise<Principal>;
}

export interface GroupProvider {
  create(
    context: AccessContext,
    input: Omit<Group, "id" | "organizationId" | "principalIds">,
  ): Promise<Group>;
  addMember(context: AccessContext, groupId: Id, principalId: Id): Promise<Group>;
  removeMember(context: AccessContext, groupId: Id, principalId: Id): Promise<Group>;
  groupsFor(context: AccessContext, principalId: Id): Promise<Group[]>;
}
export interface GrantProvider {
  grant(context: AccessContext, input: Omit<RoleGrant, "id">): Promise<RoleGrant>;
  revokeGrant(context: AccessContext, grantId: Id): Promise<RoleGrant>;
  grantsFor(context: AccessContext, principalId: Id): Promise<RoleGrant[]>;
  delegate(context: AccessContext, input: Omit<Delegation, "id">): Promise<Delegation>;
  revokeDelegation(context: AccessContext, delegationId: Id): Promise<Delegation>;
}
export interface AuthorizationProvider {
  decide(context: AccessContext, request: AccessRequest): Promise<AccessDecision>;
  effectivePermissions(
    context: AccessContext,
    resource?: AccessRequest["resource"],
  ): Promise<string[]>;
}

export interface PolicyProvider {
  add(context: AccessContext, input: Omit<PolicyRule, "id" | "organizationId">): Promise<PolicyRule>;
  list(context: AccessContext): Promise<PolicyRule[]>;
  disable(context: AccessContext, policyId: Id): Promise<PolicyRule>;
}

export interface RoleProvider {
  register(
    context: AccessContext,
    input: Omit<Role, "id">,
  ): Promise<Role>;
  get(context: AccessContext, roleId: Id): Promise<Role | null>;
  list(context: AccessContext): Promise<Role[]>;
  updatePermissions(
    context: AccessContext,
    roleId: Id,
    permissions: string[],
  ): Promise<Role>;
}

export interface FederationProvider {
  link(
    context: AccessContext,
    input: Omit<ExternalIdentity, "id" | "organizationId" | "linkedAt">,
  ): Promise<ExternalIdentity>;
  resolve(
    context: Pick<AccessContext, "organizationId">,
    input: Pick<ExternalIdentity, "provider" | "issuer" | "subject">,
  ): Promise<Principal | null>;
  unlink(context: AccessContext, externalIdentityId: Id): Promise<void>;
}
