import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getGlobalOptions } from '../types.js';
import { configFromObject, loadConfig, saveConfig } from '../../../config/loader.js';
import { patchValidatedConfig } from '../../../config/patch.js';
import type {
  AntseedConfig,
  SellerFreeTierCLIConfig,
  SellerProviderConfig,
  SellerServiceConfig,
  TokenPricingUsdPerMillion,
} from '../../../config/types.js';
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
        // Only this key changes in the file (validated, atomic, previous file kept as config.json.bak).
        await patchValidatedConfig(globalOpts.config, (raw) => setValidatedConfigValue(raw, key, value));
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
    .option('--venice-edit-model <model>', 'Venice-only native edit model; enables image editing for this service')
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
        if (options.veniceEditModel) {
          service.imageEditModel = options.veniceEditModel as string;
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
 * Split a dot-separated key into path segments. IDs such as `kimi-k2.6`
 * contain dots, so at each level the longest run of segments that already
 * names a key there is taken as one segment. Anything else splits on dots.
 *
 * @example resolveConfigKeyPath({ s: { 'kimi-k2.6': {} } }, 's.kimi-k2.6.pricing') // ['s', 'kimi-k2.6', 'pricing']
 */
export function resolveConfigKeyPath(config: Record<string, unknown>, key: string): string[] {
  const segments = key.split('.');
  const parts: string[] = [];
  let current: unknown = config;
  let i = 0;
  while (i < segments.length) {
    let end = i + 1;
    if (isPlainObject(current)) {
      for (let j = segments.length; j > i + 1; j--) {
        if (Object.prototype.hasOwnProperty.call(current, segments.slice(i, j).join('.'))) {
          end = j;
          break;
        }
      }
    }
    const part = segments.slice(i, end).join('.');
    parts.push(part);
    current = isPlainObject(current) ? current[part] : undefined;
    i = end;
  }
  return parts;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Settable fields under a provider or service. `true`: a leaf. `'any'`: free-form below. */
type KeyShape = true | 'any' | { [field: string]: KeyShape };

/**
 * One entry per field of `T`, optional ones included, and no others, so a
 * field added to or renamed in the config types fails to compile here.
 */
type FieldShapes<T> = { [K in keyof Required<T>]: KeyShape };

const PRICING_SHAPE = {
  inputUsdPerMillion: true,
  outputUsdPerMillion: true,
  cachedInputUsdPerMillion: true,
} satisfies FieldShapes<TokenPricingUsdPerMillion>;

const SERVICE_SHAPE = {
  upstreamModel: true,
  imageEditModel: true,
  categories: true,
  enabled: true,
  pricing: PRICING_SHAPE,
  capabilities: 'any',
  unitBillingModels: 'any',
  freeTier: {
    maxRequestsPerAddress: true,
    maxRequestsPerIp: true,
    windowMs: true,
    stakeTiers: true,
    stakersOnly: true,
  } satisfies FieldShapes<SellerFreeTierCLIConfig>,
} satisfies FieldShapes<SellerServiceConfig>;

const PROVIDER_SHAPE = {
  plugin: true,
  baseUrl: true,
  apiKeyEnv: true,
  pathRewrite: 'any',
  fallbackUpstreams: true,
  defaults: PRICING_SHAPE,
  services: true,
} satisfies FieldShapes<SellerProviderConfig>;

function checkShape(shape: KeyShape, fields: string[], fullKey: string, where: string): void {
  let current: KeyShape = shape;
  for (let i = 0; i < fields.length; i++) {
    if (current === 'any') return;
    const field = fields[i]!;
    const next: KeyShape | undefined = current === true ? undefined : current[field];
    if (next === undefined) {
      const parent = fields.slice(0, i).join('.');
      const allowed = current === true ? [] : Object.keys(current);
      throw new Error(
        `Unknown key ${fullKey}: "${field}" is not a field of ${where}${parent ? `.${parent}` : ''}`
        + (allowed.length > 0 ? `. Fields: ${allowed.join(', ')}` : ''),
      );
    }
    current = next;
  }
}

/**
 * Refuse a `seller.providers.*` path that would not land on a real field,
 * instead of writing an entry the loader ignores. A field of a provider or a
 * service needs that provider or service to exist already.
 */
export function assertSellerProviderKeyPath(config: Record<string, unknown>, parts: string[], key: string): void {
  if (parts[0] !== 'seller' || parts[1] !== 'providers' || parts.length <= 3) return;
  const seller = config['seller'] as Record<string, unknown> | undefined;
  const providers = (seller?.['providers'] ?? {}) as Record<string, unknown>;
  const providerName = parts[2]!;
  const provider = providers[providerName];
  if (!isPlainObject(provider)) {
    const names = Object.keys(providers);
    throw new Error(
      `No provider "${providerName}" in seller.providers`
      + (names.length > 0 ? ` (providers: ${names.join(', ')})` : '')
      + `. Add it with: antseed config seller add-provider ${providerName} --plugin <plugin>`,
    );
  }
  const providerFields = parts.slice(3);
  if (providerFields[0] !== 'services') {
    checkShape(PROVIDER_SHAPE, providerFields, key, `provider "${providerName}"`);
    return;
  }
  // `services` or `services.<id>` takes a whole JSON object, and may add a service.
  if (providerFields.length <= 2) return;
  const services = isPlainObject(provider['services']) ? provider['services'] : {};
  const serviceId = providerFields[1]!;
  const rest = key.slice(`seller.providers.${providerName}.services.`.length);
  const ids = Object.keys(services);
  if (!isPlainObject(services[serviceId])) {
    throw new Error(
      `No service of provider "${providerName}" matches "${rest}"`
      + (ids.length > 0 ? ` (services: ${ids.join(', ')})` : '')
      + `. Add it with: antseed config seller add-service ${providerName} <serviceId>`,
    );
  }
  // An unknown first field usually means a dotted id that isn't configured
  // (`kimi-k2.7` read as service `kimi-k2`, field `7`), so say both.
  const firstField = providerFields[2]!;
  if (!Object.prototype.hasOwnProperty.call(SERVICE_SHAPE, firstField)) {
    throw new Error(
      `No service of provider "${providerName}" matches "${rest}" (services: ${ids.join(', ')}),`
      + ` and "${firstField}" is not a field of service "${serviceId}" (fields: ${Object.keys(SERVICE_SHAPE).join(', ')})`,
    );
  }
  checkShape(SERVICE_SHAPE, providerFields.slice(2), key, `service "${serviceId}"`);
}

/**
 * Set a nested config value by dot-separated key path. Auto-creates missing
 * intermediate objects so dynamic paths under `seller.providers.<name>.services.<id>`
 * can be set before the provider or service entry exists in the file. A
 * segment that names an existing key may contain dots (see `resolveConfigKeyPath`).
 *
 * @example setConfigValue(config, 'seller.reserveFloor', '20')
 * @example setConfigValue(config, 'seller.providers.openai.services.gpt-4.pricing.inputUsdPerMillion', '3')
 * @example setConfigValue(config, 'seller.providers.openai.services.kimi-k2.6.pricing.inputUsdPerMillion', '3')
 */
export function setConfigValue(config: Record<string, unknown>, key: string, value: string): void {
  setConfigPath(config, resolveConfigKeyPath(config, key), key, value);
}

function setConfigPath(config: Record<string, unknown>, parts: string[], key: string, value: string): void {
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

  if (trimmed === 'true' || trimmed === 'false') {
    current[lastKey] = trimmed === 'true';
    return;
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
  'seller.freeUsage.recordBatchSize',
  'seller.freeUsage.recordFlushIntervalMs',
  'seller.restrictedCountries',
  'seller.gasCheck.enabled',
  'seller.gasCheck.intervalMs',
  'seller.gasCheck.minBalanceEth',
  'seller.gasRefuel.enabled',
  'seller.gasRefuel.triggerBalanceEth',
  'seller.gasRefuel.swapUsdc',
  'seller.gasRefuel.maxUsdcPerDay',
  'seller.gasRefuel.slippageBps',
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
    await patchValidatedConfig(globalOpts.config, (raw) => setValidatedConfigValue(raw, fullKey, value));
    console.log(chalk.green(`Set ${fullKey} = ${value}`));
  } catch (err) {
    console.error(chalk.red(`Error: ${(err as Error).message}`));
    process.exitCode = 1;
  }
}

/**
 * Sets one key in the raw file, after checking the edit against the effective
 * config: the loader swaps a malformed value (`maxConcurrentBuyers typo`) for
 * its default, so validating only the loaded file would let it through.
 */
export function setValidatedConfigValue(raw: Record<string, unknown>, key: string, value: string): void {
  const effective = configFromObject(structuredClone(raw)) as unknown as Record<string, unknown>;
  // Resolve once against the effective config so the file gets the same path.
  const parts = resolveConfigKeyPath(effective, key);
  assertSellerProviderKeyPath(effective, parts, key);
  setConfigPath(effective, parts, key, value);
  assertValidConfig(effective as unknown as AntseedConfig);
  setConfigPath(raw, parts, key, value);
}
