import type { PrivacyProviderKind, PrivacyProviders } from "./module.js";

export class PrivacyRegistry {
  readonly #providers = new Map<PrivacyProviderKind, PrivacyProviders[PrivacyProviderKind]>();
  register<K extends PrivacyProviderKind>(
    kind: K,
    provider: PrivacyProviders[K],
    options: { replace?: boolean } = {},
  ): void {
    if (this.#providers.has(kind) && !options.replace) {
      throw new Error(`Privacy provider '${kind}' is already registered`);
    }
    this.#providers.set(kind, provider);
  }
  has(kind: PrivacyProviderKind): boolean {
    return this.#providers.has(kind);
  }
  get<K extends PrivacyProviderKind>(kind: K): PrivacyProviders[K] {
    const provider = this.#providers.get(kind);
    if (!provider) throw new Error(`Privacy provider '${kind}' is not registered`);
    return provider as PrivacyProviders[K];
  }
}
