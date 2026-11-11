import type { Audience } from "./contracts.js";
import type {
  FormsCapability,
  FormsModule,
  FormsModuleContext,
  FormsProfile,
  FormsProviderKind,
} from "./module.js";
import { FormsRegistry } from "./registry.js";

export interface FormsEngineOptions {
  profile: FormsProfile;
  modules?: FormsModule[];
}

export interface FormsValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export class FormsEngine {
  readonly profile: FormsProfile;
  readonly registry = new FormsRegistry();
  readonly #modules = new Map<string, FormsModule>();

  private constructor(options: FormsEngineOptions) {
    this.profile = options.profile;
  }

  static async create(options: FormsEngineOptions): Promise<FormsEngine> {
    const engine = new FormsEngine(options);
    for (const module of options.modules ?? []) await engine.install(module);
    return engine;
  }

  async install(module: FormsModule): Promise<void> {
    if (this.#modules.has(module.manifest.key)) {
      throw new Error(`Forms module '${module.manifest.key}' is already installed`);
    }
    this.assertAudience(module.manifest.audiences);
    for (const dependency of module.manifest.requires?.modules ?? []) {
      if (!this.#modules.has(dependency)) {
        throw new Error(
          `Module '${module.manifest.key}' requires module '${dependency}' to be installed first`,
        );
      }
    }
    const context: FormsModuleContext = {
      registerProvider: (kind, provider, options) =>
        this.registry.register(kind, provider, options),
      hasProvider: (kind) => this.registry.has(kind),
    };
    await module.setup(context);
    this.#modules.set(module.manifest.key, module);
  }

  validate(): FormsValidation {
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
        warnings.push(`No installed module declares capability '${capability}'`);
      }
    }
    for (const module of this.#modules.values()) {
      for (const provider of module.manifest.requires?.providers ?? []) {
        if (!this.registry.has(provider)) {
          errors.push(`Module '${module.manifest.key}' requires provider '${provider}'`);
        }
      }
    }
    return { valid: errors.length === 0, errors, warnings };
  }

  installedModules(): string[] {
    return [...this.#modules.keys()];
  }

  installedCapabilities(): Set<FormsCapability> {
    const result = new Set<FormsCapability>();
    for (const module of this.#modules.values()) {
      for (const capability of module.manifest.capabilities) result.add(capability);
    }
    return result;
  }

  private assertAudience(audiences: Audience[]): void {
    if (!audiences.includes(this.profile.audience)) {
      throw new Error(
        `Module does not support profile audience '${this.profile.audience}'`,
      );
    }
  }
}

export function requiredProvidersFor(profile: FormsProfile): FormsProviderKind[] {
  return [...profile.requiredProviders];
}
