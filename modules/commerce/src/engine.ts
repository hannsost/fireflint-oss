import type { Audience } from "./contracts.js";
import type {
  CommerceCapability,
  CommerceModule,
  CommerceModuleContext,
  CommerceProfile,
  ProviderKind,
} from "./module.js";
import { CommerceRegistry } from "./registry.js";

export interface CommerceEngineOptions {
  profile: CommerceProfile;
  modules?: CommerceModule[];
}

export interface CommerceValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export class CommerceEngine {
  readonly profile: CommerceProfile;
  readonly registry = new CommerceRegistry();
  readonly #modules = new Map<string, CommerceModule>();

  private constructor(options: CommerceEngineOptions) {
    this.profile = options.profile;
  }

  static async create(options: CommerceEngineOptions): Promise<CommerceEngine> {
    const engine = new CommerceEngine(options);
    for (const module of options.modules ?? []) {
      await engine.install(module);
    }
    return engine;
  }

  async install(module: CommerceModule): Promise<void> {
    if (this.#modules.has(module.manifest.key)) {
      throw new Error(`Commerce module '${module.manifest.key}' is already installed`);
    }

    this.assertAudience(module.manifest.audiences);
    this.assertModuleDependencies(module);

    const context: CommerceModuleContext = {
      registerProvider: (kind, provider, options) =>
        this.registry.register(kind, provider, options),
      hasProvider: (kind) => this.registry.has(kind),
    };

    await module.setup(context);
    this.#modules.set(module.manifest.key, module);
  }

  validate(): CommerceValidation {
    const errors: string[] = [];
    const warnings: string[] = [];
    const installedCapabilities = this.installedCapabilities();

    for (const kind of this.profile.requiredProviders) {
      if (!this.registry.has(kind)) {
        errors.push(`Profile '${this.profile.key}' requires provider '${kind}'`);
      }
    }

    for (const capability of this.profile.capabilities) {
      if (!installedCapabilities.has(capability)) {
        warnings.push(`No installed module declares capability '${capability}'`);
      }
    }

    for (const module of this.#modules.values()) {
      for (const provider of module.manifest.requires?.providers ?? []) {
        if (!this.registry.has(provider)) {
          errors.push(`Module '${module.manifest.key}' requires provider '${provider}'`);
        }
      }
      for (const capability of module.manifest.requires?.capabilities ?? []) {
        if (!installedCapabilities.has(capability)) {
          errors.push(`Module '${module.manifest.key}' requires capability '${capability}'`);
        }
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  installedModules(): string[] {
    return [...this.#modules.keys()];
  }

  installedCapabilities(): Set<CommerceCapability> {
    const capabilities = new Set<CommerceCapability>();
    for (const module of this.#modules.values()) {
      for (const capability of module.manifest.capabilities) {
        capabilities.add(capability);
      }
    }
    return capabilities;
  }

  private assertAudience(audiences: Audience[]): void {
    if (!audiences.includes(this.profile.audience)) {
      throw new Error(
        `Module does not support profile audience '${this.profile.audience}'`,
      );
    }
  }

  private assertModuleDependencies(module: CommerceModule): void {
    for (const dependency of module.manifest.requires?.modules ?? []) {
      if (!this.#modules.has(dependency)) {
        throw new Error(
          `Module '${module.manifest.key}' requires module '${dependency}' to be installed first`,
        );
      }
    }
  }
}

export function requiredProvidersFor(profile: CommerceProfile): ProviderKind[] {
  return [...profile.requiredProviders];
}
