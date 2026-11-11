import type { PrivacyCapability, PrivacyModule, PrivacyModuleContext, PrivacyProfile } from "./module.js";
import { PrivacyRegistry } from "./registry.js";

export class PrivacyEngine {
  readonly registry = new PrivacyRegistry();
  readonly #modules = new Map<string, PrivacyModule>();
  private constructor(readonly profile: PrivacyProfile) {}

  static async create(options: { profile: PrivacyProfile; modules?: PrivacyModule[] }): Promise<PrivacyEngine> {
    const engine = new PrivacyEngine(options.profile);
    for (const module of options.modules ?? []) await engine.install(module);
    return engine;
  }

  async install(module: PrivacyModule): Promise<void> {
    if (this.#modules.has(module.manifest.key)) throw new Error(`Privacy module '${module.manifest.key}' is already installed`);
    if (!module.manifest.audiences.includes(this.profile.audience)) {
      throw new Error(`Module does not support audience '${this.profile.audience}'`);
    }
    const context: PrivacyModuleContext = {
      registerProvider: (kind, provider, options) => this.registry.register(kind, provider, options),
      hasProvider: (kind) => this.registry.has(kind),
    };
    await module.setup(context);
    this.#modules.set(module.manifest.key, module);
  }

  validate(): { valid: boolean; errors: string[]; warnings: string[] } {
    const errors = this.profile.requiredProviders
      .filter((provider) => !this.registry.has(provider))
      .map((provider) => `Profile '${this.profile.key}' requires provider '${provider}'`);
    const installed = this.installedCapabilities();
    const warnings = this.profile.capabilities
      .filter((capability) => !installed.has(capability))
      .map((capability) => `No module declares capability '${capability}'`);
    return { valid: errors.length === 0, errors, warnings };
  }

  installedCapabilities(): Set<PrivacyCapability> {
    const result = new Set<PrivacyCapability>();
    for (const module of this.#modules.values()) {
      for (const capability of module.manifest.capabilities) result.add(capability);
    }
    return result;
  }
}
