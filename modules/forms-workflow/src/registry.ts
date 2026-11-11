import type {
  FormsProviderKind,
  FormsProviders,
} from "./module.js";

export class FormsRegistry {
  readonly #providers = new Map<
    FormsProviderKind,
    FormsProviders[FormsProviderKind]
  >();

  register<K extends FormsProviderKind>(
    kind: K,
    provider: FormsProviders[K],
    options: { replace?: boolean } = {},
  ): void {
    if (this.#providers.has(kind) && !options.replace) {
      throw new Error(`Forms provider '${kind}' is already registered`);
    }
    this.#providers.set(kind, provider);
  }

  has(kind: FormsProviderKind): boolean {
    return this.#providers.has(kind);
  }

  get<K extends FormsProviderKind>(kind: K): FormsProviders[K] {
    const provider = this.#providers.get(kind);
    if (!provider) {
      throw new Error(`Forms provider '${kind}' is not registered`);
    }
    return provider as FormsProviders[K];
  }

  kinds(): FormsProviderKind[] {
    return [...this.#providers.keys()];
  }
}
