import type { AccessContext, AccessDecision, AccessRequest, AuthorizationProvider, Delegation, ExternalIdentity, FederationProvider, GrantProvider, Group, GroupProvider, PolicyProvider, PolicyRule, Principal, PrincipalProvider, Role, RoleGrant, RoleProvider } from "./contracts.js";
import { AccessError } from "./errors.js";

export class ReferenceAccessStore {
  readonly principals = new Map<string, Principal>();
  readonly groups = new Map<string, Group>();
  readonly roles = new Map<string, Role>();
  readonly grants: RoleGrant[] = [];
  readonly delegations: Delegation[] = [];
  readonly policies: PolicyRule[] = [];
  readonly externalIdentities = new Map<string, ExternalIdentity>();
  #sequence = 0;
  constructor() {
    for (const role of [
      { id: "role-viewer", key: "viewer", name: "Viewer", permissions: ["*.read"] },
      { id: "role-editor", key: "editor", name: "Editor", permissions: ["*.read", "content.write", "work.manage"] },
      { id: "role-owner", key: "owner", name: "Owner", permissions: ["*"] },
    ]) this.roles.set(role.id, role);
  }
  readonly principal: PrincipalProvider = {
    create: async (context, input) => {
      const value: Principal = { ...structuredClone(input), id: this.next("principal"), organizationId: context.organizationId, status: "active", createdAt: new Date().toISOString() };
      this.principals.set(value.id, value);
      return structuredClone(value);
    },
    get: async (context, id) => {
      const value = this.principals.get(id);
      return value?.organizationId === context.organizationId ? structuredClone(value) : null;
    },
    disable: async (context, id) => {
      const value = this.requirePrincipal(context, id);
      value.status = "disabled";
      return structuredClone(value);
    },
  };
  readonly group: GroupProvider = {
    create: async (context, input) => {
      const value: Group = {
        ...structuredClone(input),
        id: this.next("group"),
        organizationId: context.organizationId,
        principalIds: [],
      };
      this.groups.set(value.id, value);
      return structuredClone(value);
    },
    addMember: async (context, groupId, principalId) => {
      const group = this.requireGroup(context, groupId);
      this.requirePrincipal(context, principalId);
      if (!group.principalIds.includes(principalId)) group.principalIds.push(principalId);
      return structuredClone(group);
    },
    removeMember: async (context, groupId, principalId) => {
      const group = this.requireGroup(context, groupId);
      group.principalIds = group.principalIds.filter((id) => id !== principalId);
      return structuredClone(group);
    },
    groupsFor: async (context, principalId) => {
      this.requirePrincipal(context, principalId);
      return [...this.groups.values()]
        .filter((group) =>
          group.organizationId === context.organizationId &&
          group.principalIds.includes(principalId),
        )
        .map((group) => structuredClone(group));
    },
  };
  readonly role: RoleProvider = {
    register: async (_context, input) => {
      if ([...this.roles.values()].some((item) => item.key === input.key)) {
        throw new AccessError("ROLE_NOT_FOUND", `Role key '${input.key}' already exists`);
      }
      const value = { ...structuredClone(input), id: this.next("role") };
      this.roles.set(value.id, value);
      return structuredClone(value);
    },
    get: async (_context, roleId) => {
      const value = this.roles.get(roleId);
      return value ? structuredClone(value) : null;
    },
    list: async () =>
      [...this.roles.values()].map((item) => structuredClone(item)),
    updatePermissions: async (_context, roleId, permissions) => {
      const value = this.roles.get(roleId);
      if (!value) throw new AccessError("ROLE_NOT_FOUND", "Role not found");
      value.permissions = [...new Set(permissions)];
      return structuredClone(value);
    },
  };
  readonly grant: GrantProvider = {
    grant: async (context, input) => {
      this.requirePrincipal(context, input.principalId ?? context.principalId);
      if (!this.roles.has(input.roleId)) throw new AccessError("ROLE_NOT_FOUND", "Role not found");
      const value = { ...structuredClone(input), id: this.next("grant") };
      this.grants.push(value);
      return structuredClone(value);
    },
    revokeGrant: async (context, grantId) => {
      const value = this.grants.find((item) => item.id === grantId);
      if (!value) throw new AccessError("GRANT_NOT_FOUND", "Grant not found");
      value.revokedAt = new Date().toISOString();
      value.revokedByPrincipalId = context.principalId;
      return structuredClone(value);
    },
    grantsFor: async (_context, principalId) => this.grants.filter((item) => item.principalId === principalId && !item.revokedAt).map((item) => structuredClone(item)),
    delegate: async (context, input) => {
      this.requirePrincipal(context, input.fromPrincipalId);
      this.requirePrincipal(context, input.toPrincipalId);
      if (new Date(input.validUntil) <= new Date(input.validFrom)) throw new AccessError("INVALID_DELEGATION", "Delegation end must be after start");
      const value = { ...structuredClone(input), id: this.next("delegation") };
      this.delegations.push(value);
      return structuredClone(value);
    },
    revokeDelegation: async (_context, id) => {
      const value = this.delegations.find((item) => item.id === id);
      if (!value) throw new AccessError("INVALID_DELEGATION", "Delegation not found");
      value.revokedAt = new Date().toISOString();
      return structuredClone(value);
    },
  };
  readonly federation: FederationProvider = {
    link: async (context, input) => {
      this.requirePrincipal(context, input.principalId);
      const conflict = [...this.externalIdentities.values()].find(
        (item) =>
          item.organizationId === context.organizationId &&
          item.provider === input.provider &&
          item.issuer === input.issuer &&
          item.subject === input.subject,
      );
      if (conflict) {
        throw new AccessError(
          "EXTERNAL_IDENTITY_CONFLICT",
          "External identity is already linked",
        );
      }
      const value: ExternalIdentity = {
        ...structuredClone(input),
        id: this.next("external-identity"),
        organizationId: context.organizationId,
        linkedAt: new Date().toISOString(),
      };
      this.externalIdentities.set(value.id, value);
      return structuredClone(value);
    },
    resolve: async (context, input) => {
      const identity = [...this.externalIdentities.values()].find(
        (item) =>
          item.organizationId === context.organizationId &&
          item.provider === input.provider &&
          item.issuer === input.issuer &&
          item.subject === input.subject,
      );
      if (!identity) return null;
      const principal = this.principals.get(identity.principalId);
      return principal ? structuredClone(principal) : null;
    },
    unlink: async (context, externalIdentityId) => {
      const identity = this.externalIdentities.get(externalIdentityId);
      if (!identity || identity.organizationId !== context.organizationId) {
        throw new AccessError(
          "EXTERNAL_IDENTITY_NOT_FOUND",
          "External identity not found",
        );
      }
      this.externalIdentities.delete(externalIdentityId);
    },
  };
  readonly policy: PolicyProvider = {
    add: async (context, input) => {
      const value: PolicyRule = {
        ...structuredClone(input),
        id: this.next("policy"),
        organizationId: context.organizationId,
      };
      this.policies.push(value);
      return structuredClone(value);
    },
    list: async (context) =>
      this.policies
        .filter((item) => item.organizationId === context.organizationId)
        .map((item) => structuredClone(item)),
    disable: async (context, policyId) => {
      const value = this.policies.find(
        (item) =>
          item.id === policyId &&
          item.organizationId === context.organizationId,
      );
      if (!value) throw new AccessError("POLICY_NOT_FOUND", "Policy not found");
      value.enabled = false;
      return structuredClone(value);
    },
  };
  readonly authorization: AuthorizationProvider = {
    decide: async (context, request) => this.decide(context, request),
    effectivePermissions: async (context, resource) =>
      this.effectivePermissions(context, resource),
  };
  private decide(context: AccessContext, request: AccessRequest): AccessDecision {
    const principal = this.requirePrincipal(context, context.principalId);
    if (principal.status !== "active") return { allowed: false, reason: `Principal is ${principal.status}`, matchedGrantIds: [] };
    if (request.resource.organizationId !== context.organizationId) return { allowed: false, reason: "Cross-organization access denied", matchedGrantIds: [] };
    if (
      request.requiredAssurance &&
      this.assuranceRank(context.assuranceLevel ?? "none") <
        this.assuranceRank(request.requiredAssurance)
    ) {
      return {
        allowed: false,
        reason: "Authentication assurance is insufficient",
        matchedGrantIds: [],
        obligations: [{ type: "step_up_authentication", value: request.requiredAssurance }],
      };
    }
    const now = new Date();
    const groupIds = [...this.groups.values()]
      .filter((group) =>
        group.organizationId === context.organizationId &&
        group.principalIds.includes(principal.id),
      )
      .map((group) => group.id);
    const direct = this.grants.filter((grant) =>
      (grant.principalId === principal.id ||
        (!!grant.groupId && groupIds.includes(grant.groupId))) &&
      !grant.revokedAt &&
      (!grant.validFrom || new Date(grant.validFrom) <= now) &&
      (!grant.validUntil || new Date(grant.validUntil) > now) &&
      this.scopeMatches(grant, request),
    ).filter((grant) => this.roles.get(grant.roleId)?.permissions.some((permission) => this.permissionMatches(permission, request.permission)));
    const delegated = this.delegations.filter((item) =>
      item.toPrincipalId === principal.id && !item.revokedAt &&
      new Date(item.validFrom) <= now && new Date(item.validUntil) > now &&
      this.scopeMatches({ scope: item.scope } as RoleGrant, request) &&
      item.permissions.some((permission) => this.permissionMatches(permission, request.permission)),
    );
    const matchingPolicies = this.policies
      .filter((policy) => policy.organizationId === context.organizationId && policy.enabled)
      .filter((policy) =>
        policy.permissions.some((permission) =>
          this.permissionMatches(permission, request.permission),
        ),
      )
      .filter((policy) => !policy.principalIds || policy.principalIds.includes(principal.id))
      .filter((policy) => !policy.groupIds || policy.groupIds.some((id) => groupIds.includes(id)))
      .filter((policy) => !policy.resourceTypes || policy.resourceTypes.includes(request.resource.type))
      .filter((policy) => this.conditionsMatch(policy.conditions, context, request))
      .sort((left, right) => right.priority - left.priority);
    const deny = matchingPolicies.find((policy) => policy.effect === "deny");
    if (deny) {
      return {
        allowed: false,
        reason: `Denied by policy '${deny.id}'`,
        matchedGrantIds: [deny.id],
        obligations: deny.obligations,
      };
    }
    const allowPolicies = matchingPolicies.filter((policy) => policy.effect === "allow");
    const allowed =
      direct.length > 0 || delegated.length > 0 || allowPolicies.length > 0;
    return {
      allowed,
      reason: allowed
        ? "Matching grant, delegation or allow policy"
        : "No matching grant",
      matchedGrantIds: [
        ...direct.map((item) => item.id),
        ...delegated.map((item) => item.id),
        ...allowPolicies.map((item) => item.id),
      ],
      obligations: allowPolicies.flatMap((item) => item.obligations ?? []),
    };
  }
  private conditionsMatch(
    conditions: PolicyRule["conditions"],
    context: AccessContext,
    request: AccessRequest,
  ): boolean {
    if (!conditions) return true;
    for (const [key, expected] of Object.entries(conditions)) {
      const actual =
        context.attributes?.[key] ??
        request.resource.attributes?.[key];
      if (actual !== expected) return false;
    }
    return true;
  }
  private assuranceRank(level: NonNullable<AccessContext["assuranceLevel"]>): number {
    return { none: 0, single_factor: 1, mfa: 2, hardware: 3 }[level];
  }
  private effectivePermissions(
    context: AccessContext,
    resource?: AccessRequest["resource"],
  ): string[] {
    const principal = this.requirePrincipal(context, context.principalId);
    const now = new Date();
    const groupIds = [...this.groups.values()]
      .filter((group) => group.principalIds.includes(principal.id))
      .map((group) => group.id);
    const permissions = new Set<string>();
    for (const grant of this.grants) {
      if (grant.revokedAt) continue;
      if (
        grant.principalId !== principal.id &&
        (!grant.groupId || !groupIds.includes(grant.groupId))
      ) continue;
      if (grant.validFrom && new Date(grant.validFrom) > now) continue;
      if (grant.validUntil && new Date(grant.validUntil) <= now) continue;
      if (
        resource &&
        !this.scopeMatches(
          grant,
          { permission: "", resource },
        )
      ) continue;
      for (const permission of this.roles.get(grant.roleId)?.permissions ?? []) {
        permissions.add(permission);
      }
    }
    for (const delegation of this.delegations) {
      if (
        delegation.toPrincipalId === principal.id &&
        !delegation.revokedAt &&
        new Date(delegation.validFrom) <= now &&
        new Date(delegation.validUntil) > now
      ) {
        for (const permission of delegation.permissions) permissions.add(permission);
      }
    }
    return [...permissions].sort();
  }
  private permissionMatches(pattern: string, requested: string): boolean {
    return pattern === "*" || pattern === requested || (pattern.endsWith(".*") && requested.startsWith(pattern.slice(0, -1)));
  }
  private scopeMatches(grant: RoleGrant, request: AccessRequest): boolean {
    return grant.scope.type === "organization" || !grant.scope.id || grant.scope.id === request.resource.id;
  }
  private requirePrincipal(context: Pick<AccessContext, "organizationId">, id: string): Principal {
    const value = this.principals.get(id);
    if (!value || value.organizationId !== context.organizationId) throw new AccessError("PRINCIPAL_NOT_FOUND", `Principal '${id}' not found`);
    return value;
  }
  private requireGroup(context: Pick<AccessContext, "organizationId">, id: string): Group {
    const value = this.groups.get(id);
    if (!value || value.organizationId !== context.organizationId) {
      throw new AccessError("GROUP_NOT_FOUND", `Group '${id}' not found`);
    }
    return value;
  }
  private next(prefix: string): string {
    this.#sequence += 1;
    return `${prefix}-${this.#sequence}`;
  }
}
