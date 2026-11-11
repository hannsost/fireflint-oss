import type { DeduplicationProvider, MergePreview, Party, PartyContext, PartyIdentifier, PartyProvider, PartyRelationship, PartyRole, RelationshipProvider } from "./contracts.js";
import { PartyError } from "./errors.js";

export class ReferencePartyStore {
  readonly parties = new Map<string, Party>();
  readonly roleItems: PartyRole[] = [];
  readonly relationItems: PartyRelationship[] = [];
  #sequence = 0;

  readonly party: PartyProvider = {
    create: async (context, input) => {
      for (const identifier of input.identifiers) {
        const existing = await this.party.findByIdentifier(context, identifier);
        if (existing) throw new PartyError("IDENTIFIER_CONFLICT", "Identifier already exists");
      }
      const now = new Date().toISOString();
      const value: Party = {
        ...structuredClone(input),
        id: this.next("party"),
        tenantId: context.organizationId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      this.parties.set(value.id, value);
      return structuredClone(value);
    },
    get: async (context, id) => {
      const value = this.parties.get(id);
      return value?.tenantId === context.organizationId ? structuredClone(value) : null;
    },
    findByIdentifier: async (context, identifier) => {
      const value = [...this.parties.values()].find(
        (party) =>
          party.tenantId === context.organizationId &&
          party.status !== "merged" &&
          party.identifiers.some((item) => item.scheme === identifier.scheme && item.value === identifier.value),
      );
      return value ? structuredClone(value) : null;
    },
    search: async (context, query) => {
      const needle = query.toLowerCase();
      return [...this.parties.values()]
        .filter((party) => party.tenantId === context.organizationId && party.status !== "merged")
        .filter((party) => party.displayName.toLowerCase().includes(needle))
        .map((party) => structuredClone(party));
    },
    update: async (context, id, patch) => {
      const value = await this.require(context, id);
      Object.assign(value, structuredClone(patch), { updatedAt: new Date().toISOString() });
      this.parties.set(id, value);
      return structuredClone(value);
    },
    archive: async (context, id) => {
      const value = await this.require(context, id);
      value.status = "archived";
      value.updatedAt = new Date().toISOString();
      return structuredClone(value);
    },
    preferredContact: async (context, id, type) => {
      const value = await this.require(context, id);
      const contacts = value.contacts.filter((item) => item.type === type);
      const contact = contacts.find((item) => item.primary) ?? contacts[0];
      return contact ? structuredClone(contact) : null;
    },
  };

  readonly relationships: RelationshipProvider = {
    addRole: async (context, input) => {
      await this.require(context, input.partyId);
      const role = { ...structuredClone(input), id: this.next("role") };
      this.roleItems.push(role);
      return structuredClone(role);
    },
    endRole: async (context, roleId, validUntil = new Date().toISOString()) => {
      const role = this.roleItems.find((item) => item.id === roleId);
      if (!role) throw new PartyError("PARTY_NOT_FOUND", `Role '${roleId}' not found`);
      await this.require(context, role.partyId);
      role.validUntil = validUntil;
      return structuredClone(role);
    },
    roles: async (_context, partyId) => this.roleItems.filter((item) => item.partyId === partyId).map((item) => structuredClone(item)),
    activeRoles: async (_context, partyId, at = new Date().toISOString()) =>
      this.roleItems
        .filter((item) => item.partyId === partyId)
        .filter((item) => this.activeAt(item, at))
        .map((item) => structuredClone(item)),
    relate: async (context, input) => {
      await this.require(context, input.fromPartyId);
      await this.require(context, input.toPartyId);
      if (input.fromPartyId === input.toPartyId) throw new PartyError("INVALID_RELATIONSHIP", "Self relationship is not allowed");
      const relation = { ...structuredClone(input), id: this.next("relationship") };
      this.relationItems.push(relation);
      return structuredClone(relation);
    },
    relationships: async (_context, partyId) => this.relationItems.filter((item) => item.fromPartyId === partyId || item.toPartyId === partyId).map((item) => structuredClone(item)),
    activeRelationships: async (
      _context,
      partyId,
      at = new Date().toISOString(),
    ) =>
      this.relationItems
        .filter(
          (item) =>
            item.fromPartyId === partyId || item.toPartyId === partyId,
        )
        .filter((item) => this.activeAt(item, at))
        .map((item) => structuredClone(item)),
    ancestors: async (context, partyId, relationshipType) =>
      this.traverse(context, partyId, relationshipType, "up"),
    descendants: async (context, partyId, relationshipType) =>
      this.traverse(context, partyId, relationshipType, "down"),
  };

  readonly deduplication: DeduplicationProvider = {
    candidates: async (context, party) =>
      [...this.parties.values()]
        .filter((candidate) => candidate.tenantId === context.organizationId && candidate.id !== party.id && candidate.status === "active")
        .map((candidate) => {
          const identifierMatch = candidate.identifiers.some((left) =>
            party.identifiers.some((right) => left.scheme === right.scheme && left.value === right.value),
          );
          const nameMatch = candidate.displayName.toLowerCase() === party.displayName.toLowerCase();
          return {
            partyId: candidate.id,
            score: identifierMatch ? 1 : nameMatch ? 0.7 : 0,
            reasons: identifierMatch ? ["identifier"] : nameMatch ? ["display_name"] : [],
          };
        })
        .filter((item) => item.score > 0),
    previewMerge: async (context, survivingId, mergedIds) =>
      this.buildMergePreview(context, survivingId, mergedIds),
    merge: async (context, survivingId, mergedIds) => {
      const preview = await this.buildMergePreview(context, survivingId, mergedIds);
      const survivor = await this.require(context, survivingId);
      for (const id of mergedIds) {
        const merged = await this.require(context, id);
        survivor.identifiers.push(...merged.identifiers.filter((candidate) =>
          !survivor.identifiers.some((item) => item.scheme === candidate.scheme && item.value === candidate.value),
        ));
        merged.status = "merged";
        merged.mergedIntoId = survivor.id;
        this.parties.set(merged.id, merged);
      }
      survivor.updatedAt = new Date().toISOString();
      this.parties.set(survivor.id, survivor);
      return {
        survivingParty: structuredClone(survivor),
        mergedPartyIds: [...mergedIds],
        conflicts: preview.conflicts,
      };
    },
  };

  private async buildMergePreview(
    context: PartyContext,
    survivingId: string,
    mergedIds: string[],
  ): Promise<MergePreview> {
    const parties = [
      await this.require(context, survivingId),
      ...await Promise.all(mergedIds.map((id) => this.require(context, id))),
    ];
    const names = [...new Set(parties.map((item) => item.displayName))];
    const conflicts = names.length > 1
      ? [{ field: "displayName", values: names }]
      : [];
    const byScheme = new Map<string, Set<string>>();
    for (const party of parties) {
      for (const identifier of party.identifiers) {
        const values = byScheme.get(identifier.scheme) ?? new Set<string>();
        values.add(identifier.value);
        byScheme.set(identifier.scheme, values);
      }
    }
    return {
      survivingParty: structuredClone(parties[0]),
      mergedPartyIds: [...mergedIds],
      conflicts,
      identifierConflicts: [...byScheme]
        .filter(([, values]) => values.size > 1)
        .map(([scheme, values]) => ({ scheme, values: [...values] })),
    };
  }

  private async traverse(
    context: PartyContext,
    partyId: string,
    relationshipType: string,
    direction: "up" | "down",
  ): Promise<Party[]> {
    await this.require(context, partyId);
    const found: Party[] = [];
    const visited = new Set<string>([partyId]);
    const queue = [partyId];
    while (queue.length) {
      const current = queue.shift()!;
      const related = this.relationItems
        .filter((item) =>
          item.type === relationshipType &&
          (direction === "up"
            ? item.fromPartyId === current
            : item.toPartyId === current),
        )
        .map((item) =>
          direction === "up" ? item.toPartyId : item.fromPartyId,
        );
      for (const id of related) {
        if (visited.has(id)) continue;
        visited.add(id);
        const party = await this.require(context, id);
        found.push(structuredClone(party));
        queue.push(id);
      }
    }
    return found;
  }
  private activeAt(
    item: { validFrom?: string; validUntil?: string },
    at: string,
  ): boolean {
    const point = new Date(at);
    return (
      (!item.validFrom || new Date(item.validFrom) <= point) &&
      (!item.validUntil || new Date(item.validUntil) > point)
    );
  }

  private async require(context: PartyContext, id: string): Promise<Party> {
    const value = this.parties.get(id);
    if (!value || value.tenantId !== context.organizationId) throw new PartyError("PARTY_NOT_FOUND", `Party '${id}' not found`);
    return value;
  }
  private next(prefix: string): string {
    this.#sequence += 1;
    return `${prefix}-${this.#sequence}`;
  }
}

export const referencePartyContext = (organizationId = "tenant-1"): PartyContext => ({
  organizationId,
  correlationId: "party-reference",
});

export const referenceIdentifier = (value: string): PartyIdentifier => ({ scheme: "email", value });
