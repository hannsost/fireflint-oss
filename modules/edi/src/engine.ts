import type {
  EdiCapability,
  EdiModule,
  EdiModuleContext,
  EdiProfile,
} from "./module.js";
import { EdiRegistry } from "./registry.js";

export class EdiEngine {
  readonly registry = new EdiRegistry();
  readonly #modules = new Map<string, EdiModule>();

  private constructor(readonly profile: EdiProfile) {}

  static async create(options: {
    profile: EdiProfile;
    modules?: EdiModule[];
  }): Promise<EdiEngine> {
    const engine = new EdiEngine(options.profile);
    for (const module of options.modules ?? []) await engine.install(module);
    return engine;
  }

  async install(module: EdiModule): Promise<void> {
    if (this.#modules.has(module.manifest.key)) {
      throw new Error(`EDI module '${module.manifest.key}' is already installed`);
    }
    for (const dependency of module.manifest.requires?.modules ?? []) {
      if (!this.#modules.has(dependency)) {
        throw new Error(`Module '${module.manifest.key}' requires '${dependency}'`);
      }
    }
    const context: EdiModuleContext = {
      registerProvider: (kind, provider, options) =>
        this.registry.register(kind, provider, options),
      hasProvider: (kind) => this.registry.has(kind),
    };
    await module.setup(context);
    this.#modules.set(module.manifest.key, module);
  }

  validate(): { valid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const capabilities = this.installedCapabilities();
    for (const provider of this.profile.requiredProviders) {
      if (!this.registry.has(provider)) {
        errors.push(`Profile '${this.profile.key}' requires provider '${provider}'`);
      }
    }
    for (const capability of this.profile.capabilities) {
      if (!capabilities.has(capability)) {
        warnings.push(`No module declares capability '${capability}'`);
      }
    }
    return { valid: errors.length === 0, errors, warnings };
  }

  installedCapabilities(): Set<EdiCapability> {
    const result = new Set<EdiCapability>();
    for (const module of this.#modules.values()) {
      for (const capability of module.manifest.capabilities) result.add(capability);
    }
    return result;
  }
}
