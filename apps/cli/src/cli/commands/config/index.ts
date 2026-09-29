import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getGlobalOptions } from '../types.js';
import { loadConfig, saveConfig } from '../../../config/loader.js';
import type { AntseedConfig, SellerProviderConfig } from '../../../config/types.js';
import { assertValidConfig } from '../../../config/validation.js';
import {
  parseServiceCapabilitiesInput,
  parseServiceUnitBillingModelsInput,
} from '../../../config/service-metadata.js';
import { installPlugin } from '../../../plugins/manager.js';
import { resolvePluginPackage } from '../../../plugins/registry.js';

/**
 * Register the `antseed config` command and its subcommands.
 */
export function registerConfigCommand(program: Command): void {
  const configCmd = program
    .command('config')
    .description('Manage Antseed configuration');

  // antseed config show
  configCmd
    .command('show')
    .description('Display current configuration (credentials redacted)')
    .action(async () => {
      const globalOpts = getGlobalOptions(program);
      const config = await loadConfig(globalOpts.config);
      const redacted = redactConfig(config);
      console.log(JSON.stringify(redacted, null, 2));
    });

  // antseed config set <key> <value>
  configCmd
    .command('set <key> <value>')
    .description('Set a configuration value (e.g., seller.reserveFloor 20)')
    .action(async (key: string, value: string) => {
      try {
        const globalOpts = getGlobalOptions(program);
        const config = await loadConfig(globalOpts.config);
        if (!isDynamicKey(key)) {
          const validKeys = getValidConfigKeys(config);
          if (!validKeys.includes(key)) {
            console.error(chalk.red(`Invalid config key: ${key}`));
            console.error(chalk.dim(`Available keys: ${validKeys.join(', ')}`));
            process.exitCode = 1;
            return;
          }
        }
        setConfigValue(config as unknown as Record<string, unknown>, key, value);
        assertValidConfig(config);
        await saveConfig(globalOpts.config, config);
        console.log(chalk.green(`Set ${key} = ${value}`));
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });

  const sellerCmd = configCmd
    .command('seller')
    .description('Role-scoped seller configuration commands');

  sellerCmd
    .command('show')
    .description('Display seller configuration')
    .action(async () => {
      const globalOpts = getGlobalOptions(program);
      const config = await loadConfig(globalOpts.config);
      console.log(JSON.stringify(config.seller, null, 2));
    });

  sellerCmd
    .command('set <key> <value>')
    .description('Set seller configuration value (e.g., providers.openai.services.gpt-4.pricing.inputUsdPerMillion 3)')
    .action(async (key: string, value: string) => {
      await setRoleScopedValue(program, 'seller', key, value);
    });

  sellerCmd
    .command('add-service <provider> <serviceId>')
    .description('Add a service offering under a provider (e.g., add-service openai gpt-4 --input 5 --output 15 --categories chat,coding)')
    .option('--upstream <model>', 'upstream model identifier (defaults to serviceId)')
    .option('--input <usd>', 'input price in USD per 1M tokens', parseFloat)
    .option('--output <usd>', 'output price in USD per 1M tokens', parseFloat)
    .option('--cached <usd>', 'cached-input price in USD per 1M tokens', parseFloat)
    .option('--categories <list>', 'comma-separated normie tags (e.g., chat,coding,fast)')
    .option('--capabilities <json>', 'capabilities JSON (contextWindow, inputs, outputs, toolUse, supportedParameters, etc.)')
    .option('--unit-billing-models <json>', 'protocol-to-unit-billing-model JSON')
    .option('--base-url <url>', 'set the provider baseUrl (one-shot; applies to the whole provider)')
    .action(async (providerName: string, serviceId: string, options) => {
      try {
        const globalOpts = getGlobalOptions(program);
        const config = await loadConfig(globalOpts.config);
        const providers = config.seller.providers;
        const providerCfg = providers[providerName];
        if (!providerCfg) {
          console.error(chalk.red(`Provider "${providerName}" not found. Add it first with antseed config seller add-provider ${providerName} --plugin <plugin>.`));
          process.exitCode = 1;
          return;
        }
        if (options.baseUrl) {
          providerCfg.baseUrl = options.baseUrl as string;
        }
        const service = providerCfg.services[serviceId] ?? {};
        if (options.upstream) {
          service.upstreamModel = options.upstream as string;
        } else if (!service.upstreamModel) {
          service.upstreamModel = serviceId;
        }
        const hasInput = typeof options.input === 'number';
        const hasOutput = typeof options.output === 'number';
        const hasCached = typeof options.cached === 'number';
        if (hasInput || hasOutput || hasCached) {
          const existing = service.pricing ?? { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
          service.pricing = {
            inputUsdPerMillion: hasInput ? (options.input as number) : existing.inputUsdPerMillion,
            outputUsdPerMillion: hasOutput ? (options.output as number) : existing.outputUsdPerMillion,
            ...(hasCached ? { cachedInputUsdPerMillion: options.cached as number } : (existing.cachedInputUsdPerMillion != null ? { cachedInputUsdPerMillion: existing.cachedInputUsdPerMillion } : {})),
          };
        }
        if (typeof options.categories === 'string' && options.categories.trim().length > 0) {
          service.categories = options.categories
            .split(',')
            .map((t: string) => t.trim().toLowerCase())
            .filter((t: string) => t.length > 0);
        }
        if (typeof options.capabilities === 'string') {
          service.capabilities = parseServiceCapabilitiesInput(options.capabilities, '--capabilities');
        }
        if (typeof options.unitBillingModels === 'string') {
          service.unitBillingModels = parseServiceUnitBillingModelsInput(options.unitBillingModels, '--unit-billing-models');
        }
        providerCfg.services[serviceId] = service;
        providers[providerName] = providerCfg;
        assertValidConfig(config);
        await saveConfig(globalOpts.config, config);
        console.log(chalk.green(`Added service ${providerName}/${serviceId}`));
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });

  sellerCmd
    .command('remove-service <provider> <serviceId>')
    .description('Remove a service offering from a provider')
    .action(async (providerName: string, serviceId: string) => {
      try {
        const globalOpts = getGlobalOptions(program);
        const config = await loadConfig(globalOpts.config);
        const providerCfg = config.seller.providers[providerName];
        if (!providerCfg || !providerCfg.services[serviceId]) {
          console.log(chalk.yellow(`No service ${providerName}/${serviceId} found`));
          return;
        }
        delete providerCfg.services[serviceId];
        assertValidConfig(config);
        await saveConfig(globalOpts.config, config);
        console.log(chalk.green(`Removed service ${providerName}/${serviceId}`));
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });

  sellerCmd
    .command('add-provider <name>')
    .description('Add a provider (installs plugin, creates seller.providers[name] entry)')
    .requiredOption('--plugin <plugin>', 'plugin name or npm package (e.g., openai, anthropic, @antseed/provider-openai)')
    .option('--base-url <url>', 'upstream API base URL (e.g., https://api.together.ai)')
    .option('--input <usd>', 'default input price in USD per 1M tokens', parseFloat)
    .option('--output <usd>', 'default output price in USD per 1M tokens', parseFloat)
    .option('--cached <usd>', 'default cached-input price in USD per 1M tokens', parseFloat)
    .action(async (name: string, options) => {
      try {
        const globalOpts = getGlobalOptions(program);
        const config = await loadConfig(globalOpts.config);

        if (config.seller.providers[name]) {
          console.error(chalk.red(`Provider "${name}" already exists. Remove it first or choose a different name.`));
          process.exitCode = 1;
          return;
        }

        const pluginName = options.plugin as string;
        const packageName = resolvePluginPackage(pluginName);

        const spinner = ora(`Installing ${packageName}...`).start();
        try {
          await installPlugin(packageName);
          spinner.succeed(chalk.green(`Installed ${packageName}`));
        } catch (err) {
          spinner.fail(chalk.red(`Failed to install ${packageName}: ${(err as Error).message}`));
          process.exitCode = 1;
          return;
        }

        const providerEntry: SellerProviderConfig = {
          plugin: pluginName,
          services: {},
        };
        if (options.baseUrl) {
          providerEntry.baseUrl = options.baseUrl as string;
        }
        const hasInput = typeof options.input === 'number';
        const hasOutput = typeof options.output === 'number';
        const hasCached = typeof options.cached === 'number';
        if (hasInput || hasOutput) {
          providerEntry.defaults = {
            inputUsdPerMillion: hasInput ? (options.input as number) : 0,
            outputUsdPerMillion: hasOutput ? (options.output as number) : 0,
            ...(hasCached ? { cachedInputUsdPerMillion: options.cached as number } : {}),
          };
        }

        config.seller.providers[name] = providerEntry;
        assertValidConfig(config);
        await saveConfig(globalOpts.config, config);
        console.log(chalk.green(`Added provider "${name}" (plugin: ${pluginName})`));
        console.log(chalk.dim(`Next: antseed config seller add-service ${name} <serviceId> --input <usd> --output <usd>`));
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });

  sellerCmd
    .command('remove-provider <name>')
    .description('Remove a provider entry from seller config')
    .action(async (name: string) => {
      try {
        const globalOpts = getGlobalOptions(program);
        const config = await loadConfig(globalOpts.config);
        if (!config.seller.providers[name]) {
          console.log(chalk.yellow(`No provider "${name}" found`));
          return;
        }
        const serviceCount = Object.keys(config.seller.providers[name].services).length;
        delete config.seller.providers[name];
        await saveConfig(globalOpts.config, config);
        console.log(chalk.green(`Removed provider "${name}" (had ${serviceCount} service(s))`));
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });

  const buyerCmd = configCmd
    .command('buyer')
    .description('Role-scoped buyer configuration commands');

  buyerCmd
    .command('show')
    .description('Display buyer configuration')
    .action(async () => {
      const globalOpts = getGlobalOptions(program);
      const config = await loadConfig(globalOpts.config);
      console.log(JSON.stringify(config.buyer, null, 2));
    });

  buyerCmd
    .command('set <key> <value>')
    .description('Set buyer configuration value (e.g., maxPricing.defaults.inputUsdPerMillion 25)')
    .action(async (key: string, value: string) => {
      await setRoleScopedValue(program, 'buyer', key, value);
    });

  // antseed config init
  configCmd
    .command('init')
    .description('Initialize a new config file with defaults')
    .action(async () => {
      const globalOpts = getGlobalOptions(program);
      const { createDefaultConfig } = await import('../../../config/defaults.js');
      const config = createDefaultConfig();
      await saveConfig(globalOpts.config, config);
      console.log(chalk.green(`Config initialized at ${globalOpts.config}`));
    });
}

/**
 * Redact sensitive fields (auth values) from config for display.
 */
export function redactConfig(config: AntseedConfig): Record<string, unknown> {
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}

/**
 * Set a nested config value by dot-separated key path. Auto-creates missing
 * intermediate objects so dynamic paths under `seller.providers.<name>.services.<id>`
 * can be set before the provider or service entry exists in the file.
 *
 * @example setConfigValue(config, 'seller.reserveFloor', '20')
 * @example setConfigValue(config, 'seller.providers.openai.services.gpt-4.pricing.inputUsdPerMillion', '3')
 */
export function setConfigValue(config: Record<string, unknown>, key: string, value: string): void {
  const parts = key.split('.');
  let current: Record<string, unknown> = config;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const existing = current[part];
    if (existing === undefined || existing === null) {
      current[part] = {};
      current = current[part] as Record<string, unknown>;
      continue;
    }
    if (typeof existing !== 'object' || Array.isArray(existing)) {
      throw new Error(`Cannot set ${key}: ${parts.slice(0, i + 1).join('.')} is not an object`);
    }
    current = existing as Record<string, unknown>;
  }
  const lastKey = parts[parts.length - 1]!;
  const trimmed = value.trim();

  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      current[lastKey] = JSON.parse(trimmed) as unknown;
      return;
    } catch {
      throw new Error(`Invalid JSON value for ${key}`);
    }
  }

  // Auto-parse numeric scalars. Non-numeric strings use `trimmed` to match
  // loader normalization (e.g. normalizeSellerProvider strips whitespace), so
  // on-disk state matches what `loadConfig` would produce.
  const numVal = Number(trimmed);
  current[lastKey] = Number.isNaN(numVal) ? trimmed : numVal;
}

/**
 * Key paths accepted even when optional intermediate objects do not exist.
 * Provider paths are dynamic because their names and service IDs are user-defined;
 * optional fixed-shape blocks enumerate their supported leaf keys explicitly.
 */
const DYNAMIC_KEY_PREFIXES = [
  'seller.providers.',
];

const DYNAMIC_KEYS = new Set([
  'seller.freeTier.maxRequestsPerAddress',
  'seller.freeTier.maxRequestsPerIp',
  'seller.freeTier.windowMs',
]);

export function isDynamicKey(key: string): boolean {
  return DYNAMIC_KEYS.has(key)
    || DYNAMIC_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function getValidConfigKeys(config: AntseedConfig, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(config)) {
    if (k === 'plugins') continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...getValidConfigKeys(v as unknown as AntseedConfig, path));
    } else {
      keys.push(path);
    }
  }
  return keys;
}

async function setRoleScopedValue(
  program: Command,
  role: 'seller' | 'buyer',
  key: string,
  value: string,
): Promise<void> {
  try {
    const globalOpts = getGlobalOptions(program);
    const config = await loadConfig(globalOpts.config);
    const fullKey = `${role}.${key}`;
    if (!isDynamicKey(fullKey)) {
      const validKeys = getValidConfigKeys(config);
      if (!validKeys.includes(fullKey)) {
        console.error(chalk.red(`Invalid ${role} config key: ${key}`));
        const scopedKeys = validKeys
          .filter((path) => path.startsWith(`${role}.`))
          .map((path) => path.slice(role.length + 1));
        console.error(chalk.dim(`Available ${role} keys: ${scopedKeys.join(', ')}`));
        process.exitCode = 1;
        return;
      }
    }
    setConfigValue(config as unknown as Record<string, unknown>, fullKey, value);
    assertValidConfig(config);
    await saveConfig(globalOpts.config, config);
    console.log(chalk.green(`Set ${fullKey} = ${value}`));
  } catch (err) {
    console.error(chalk.red(`Error: ${(err as Error).message}`));
    process.exitCode = 1;
  }
}
