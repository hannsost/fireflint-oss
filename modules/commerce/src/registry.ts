import type { CommerceProviders, ProviderKind } from "./module.js";

export class CommerceRegistry {
  readonly #providers = new Map<ProviderKind, CommerceProviders[ProviderKind]>();

  register<K extends ProviderKind>(
    kind: K,
    provider: CommerceProviders[K],
    options: { replace?: boolean } = {},
  ): void {
    if (this.#providers.has(kind) && !options.replace) {
      throw new Error(`Commerce provider '${kind}' is already registered`);
    }
    this.#providers.set(kind, provider);
  }

  has(kind: ProviderKind): boolean {
    return this.#providers.has(kind);
  }

  get<K extends ProviderKind>(kind: K): CommerceProviders[K] {
    const provider = this.#providers.get(kind);
    if (!provider) {
      throw new Error(`Commerce provider '${kind}' is not registered`);
    }
    return provider as CommerceProviders[K];
  }

  kinds(): ProviderKind[] {
    return [...this.#providers.keys()];
  }
}
