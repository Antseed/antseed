import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const SUPPORTED_CHAIN_IDS = new Set(['base-mainnet']);
/** Plugins whose upstream speaks the OpenAI chat API and can be pointed at the sandbox mock. */
export const MOCKABLE_PLUGINS = new Set(['openai', '@antseed/provider-openai']);
export const WORKSPACE_PLUGINS = {
  openai: 'provider-openai',
  '@antseed/provider-openai': 'provider-openai',
  anthropic: 'provider-anthropic',
  '@antseed/provider-anthropic': 'provider-anthropic',
  'local-llm': 'provider-local-llm',
  '@antseed/provider-local-llm': 'provider-local-llm',
};

const PROVIDER_KEYS = new Set(['plugin', 'baseUrl', 'apiKeyEnv', 'pathRewrite', 'defaults', 'services']);
const SERVICE_KEYS = new Set(['upstreamModel', 'categories', 'pricing', 'capabilities', 'unitBillingModels']);
const SECRET_KEY = /(^|[-_])?(api[-_]?key|secret|token|password|passphrase|private[-_]?key|mnemonic|seed[-_]?phrase|credential|authorization)$/i;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export const DEFAULT_SOURCE_CONFIG = {
  seller: {
    providers: {
      chat: {
        plugin: 'openai',
        defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
        services: { 'sandbox-chat': { categories: ['chat'] } },
      },
    },
  },
};

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function configHash(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

/** Fails if any key that looks like a credential carries an inline value anywhere in the config. */
export function assertNoInlineSecrets(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoInlineSecrets(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (key !== 'apiKeyEnv' && SECRET_KEY.test(key) && child !== null && child !== undefined && child !== '' && typeof child !== 'object') {
      throw new Error(`Refusing inline secret at ${childPath}; reference an environment variable with apiKeyEnv instead`);
    }
    assertNoInlineSecrets(child, childPath);
  }
}

function plainObject(value, label) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function pick(source, keys, label, dropped) {
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (keys.has(key)) out[key] = structuredClone(value);
    else dropped.push(`${label}.${key}`);
  }
  return out;
}

/**
 * Copies only the settings a sandbox may inherit from a real AntSeed config.
 * Identity, ports, bootstrap, RPC, contracts, relay, system proxy and verifier settings are dropped
 * and later overridden by the sandbox.
 */
export function sanitizeConfig(source) {
  plainObject(source, 'config');
  assertNoInlineSecrets(source);
  const dropped = [];
  for (const key of Object.keys(source)) if (!['seller', 'buyer', 'payments'].includes(key)) dropped.push(key);
  const seller = plainObject(source.seller, 'seller') ?? {};
  for (const key of Object.keys(seller)) if (key !== 'providers') dropped.push(`seller.${key}`);
  const providersIn = plainObject(seller.providers, 'seller.providers');
  if (!providersIn || Object.keys(providersIn).length === 0) throw new Error('Config must contain at least one seller.providers entry');
  const providers = {};
  for (const [name, raw] of Object.entries(providersIn)) {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/i.test(name)) throw new Error(`Invalid provider name "${name}"`);
    const provider = pick(plainObject(raw, `seller.providers.${name}`), PROVIDER_KEYS, `seller.providers.${name}`, dropped);
    if (typeof provider.plugin !== 'string' || !provider.plugin) throw new Error(`seller.providers.${name}.plugin is required`);
    if (provider.apiKeyEnv !== undefined && !ENV_NAME.test(provider.apiKeyEnv)) {
      throw new Error(`seller.providers.${name}.apiKeyEnv must be an environment variable name`);
    }
    const services = plainObject(provider.services, `seller.providers.${name}.services`);
    if (!services || Object.keys(services).length === 0) throw new Error(`seller.providers.${name}.services must list at least one model`);
    provider.services = {};
    for (const [serviceId, service] of Object.entries(services)) {
      if (!ID.test(serviceId)) throw new Error(`Invalid service id "${serviceId}"`);
      provider.services[serviceId] = pick(plainObject(service ?? {}, `service ${serviceId}`), SERVICE_KEYS, `seller.providers.${name}.services.${serviceId}`, dropped);
    }
    providers[name] = provider;
  }
  const buyerIn = plainObject(source.buyer, 'buyer') ?? {};
  const buyer = {};
  for (const [key, value] of Object.entries(buyerIn)) {
    if (key === 'routingPreferences' || key === 'maxPricing') buyer[key] = structuredClone(plainObject(value, `buyer.${key}`));
    else dropped.push(`buyer.${key}`);
  }
  const paymentsIn = plainObject(source.payments, 'payments') ?? {};
  for (const key of Object.keys(paymentsIn)) if (key !== 'crypto') dropped.push(`payments.${key}`);
  const cryptoIn = plainObject(paymentsIn.crypto, 'payments.crypto') ?? {};
  for (const key of Object.keys(cryptoIn)) if (key !== 'chainId') dropped.push(`payments.crypto.${key}`);
  const chainId = cryptoIn.chainId ?? 'base-mainnet';
  if (!SUPPORTED_CHAIN_IDS.has(chainId)) throw new Error(`payments.crypto.chainId "${chainId}" is not supported yet; the sandbox forks base-mainnet`);
  const cleaned = { seller: { providers }, buyer, payments: { crypto: { chainId } } };
  return { cleaned, hash: configHash(cleaned), dropped };
}

/** Lists every announced model per provider, used for the mock catalog. */
export function listModels(cleaned) {
  return [...new Set(Object.values(cleaned.seller.providers).flatMap((provider) => Object.keys(provider.services)))];
}

/**
 * Rewrites providers for the chosen upstream. Mock mode points every provider at the mock and
 * uses a throwaway key; live mode requires every apiKeyEnv to be set and an HTTPS baseUrl.
 * Returns the seller providers plus the env vars the seller process needs.
 */
export function bindUpstream(cleaned, { mode, mockUrl, env = process.env }) {
  const providers = structuredClone(cleaned.seller.providers);
  const sellerEnv = {};
  for (const [name, provider] of Object.entries(providers)) {
    if (!WORKSPACE_PLUGINS[provider.plugin]) throw new Error(`Provider "${name}" uses plugin "${provider.plugin}", which the sandbox cannot load from this workspace`);
    if (mode === 'mock') {
      if (!MOCKABLE_PLUGINS.has(provider.plugin)) {
        throw new Error(`Provider "${name}" (${provider.plugin}) has no sandbox mock yet; only OpenAI-compatible providers work in mock mode (use --live)`);
      }
      if (!mockUrl) throw new Error('mockUrl is required in mock mode');
      provider.baseUrl = mockUrl;
      provider.apiKeyEnv = `SANDBOX_KEY_${name.toUpperCase().replace(/-/g, '_')}`;
      sellerEnv[provider.apiKeyEnv] = 'mock-only';
      delete provider.pathRewrite;
    } else if (mode === 'live') {
      const keyName = provider.apiKeyEnv;
      if (!keyName) throw new Error(`Provider "${name}" needs apiKeyEnv for --live`);
      if (!env[keyName]?.trim()) throw new Error(`--live requires ${keyName} to be set for provider "${name}"`);
      if (provider.baseUrl !== undefined && !String(provider.baseUrl).startsWith('https://')) {
        throw new Error(`Provider "${name}" baseUrl must be HTTPS in live mode`);
      }
      sellerEnv[keyName] = env[keyName];
    } else {
      throw new Error(`Unknown upstream mode ${mode}`);
    }
  }
  return { providers, sellerEnv };
}

export function resolveConfigSource({ explicit, env = process.env, worktree }) {
  if (explicit) return { path: resolve(explicit), origin: '--config' };
  if (env.ANTSEED_SANDBOX_CONFIG?.trim()) return { path: resolve(env.ANTSEED_SANDBOX_CONFIG.trim()), origin: 'ANTSEED_SANDBOX_CONFIG' };
  const local = join(worktree, '.antseed-sandbox.json');
  if (existsSync(local)) return { path: local, origin: '.antseed-sandbox.json' };
  return { path: null, origin: 'built-in default' };
}

export async function loadSourceConfig(source) {
  if (!source.path) return { ...sanitizeConfig(DEFAULT_SOURCE_CONFIG), origin: source.origin, path: null };
  const raw = JSON.parse(await readFile(source.path, 'utf8'));
  return { ...sanitizeConfig(raw), origin: source.origin, path: source.path };
}
