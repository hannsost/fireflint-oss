import type { EdiProviderKind, EdiProviders } from "./module.js";

export class EdiRegistry {
  readonly #providers = new Map<EdiProviderKind, EdiProviders[EdiProviderKind]>();

  register<K extends EdiProviderKind>(
    kind: K,
    provider: EdiProviders[K],
    options: { replace?: boolean } = {},
  ): void {
    if (this.#providers.has(kind) && !options.replace) {
      throw new Error(`EDI provider '${kind}' is already registered`);
    }
    this.#providers.set(kind, provider);
  }

  has(kind: EdiProviderKind): boolean {
    return this.#providers.has(kind);
  }

  get<K extends EdiProviderKind>(kind: K): EdiProviders[K] {
    const provider = this.#providers.get(kind);
    if (!provider) throw new Error(`EDI provider '${kind}' is not registered`);
    return provider as EdiProviders[K];
  }
}
