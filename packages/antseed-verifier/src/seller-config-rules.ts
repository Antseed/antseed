import teeProviderPlugins from './tee-provider-plugins.json' with { type: 'json' }

/**
 * The rules every approved TEE seller deployment follows, whatever runs it (dstack, Google
 * Confidential Space): the seller config is readable by the buyer and only sends prompts to the
 * upstreams it names, and the only hidden inputs are secrets that cannot redirect prompts.
 *
 * Seller config: each provider uses a plugin listed in tee-provider-plugins.json, every upstream
 * is https, and every path rewrite is a path on that upstream (the relay appends it to the base
 * URL, so a value like "@other.example/v1" would move the request to another host). The approved
 * images' relay refuses upstream redirects, so requests stay on these origins.
 */

/** One place a seller node forwards prompts to, read from its measured config. */
export interface SellerUpstream {
  /** The provider's name in the seller config. */
  provider: string
  plugin: string
  /** https origin, e.g. "https://api.openai.com". */
  origin: string
}

/**
 * The provider plugins a TEE seller may use (tee-provider-plugins.json, which also decides the
 * image's plugins): each one's default upstream, and whether the config's baseUrl (and
 * fallbackUpstreams) changes it. Each sends buyer content only to that upstream. fal-video is
 * left out: it uploads buyer media to a storage host the storage service names at runtime, which
 * the config cannot show.
 */
const PLUGINS: Readonly<Record<string, { defaultUrl: string; baseUrl: boolean; fallbacks?: boolean }>> = teeProviderPlugins

/**
 * Settings an operator may set in the open (the buyer reads them): the peer id, provider
 * attestation settings and the request-body fields the openai plugin adds (OPENAI_BODY_INJECT_JSON,
 * which cannot change where a request goes).
 */
export const LITERAL_ENV = /^(?:ANTSEED_TEE_PEER_ID|OPENAI_BODY_INJECT_JSON|ANTSEED_VERIFIER_PROVIDER_[A-Z0-9_]+)$/
/** Names a hidden secret may have (checkHiddenSecrets narrows API keys to the ones the config names). */
export const SECRET_ENV = /^(?:ANTSEED_IDENTITY_HEX|ANTSEED_BASE_RPC_URL|[A-Z][A-Z0-9_]*_API_KEY)$/
/** Secrets the CLI reads itself; any other hidden variable must be a provider API key the config names. */
const NODE_SECRETS = new Set(['ANTSEED_IDENTITY_HEX', 'ANTSEED_BASE_RPC_URL'])
/** Prefixes of variables the CLI reads for its own settings (telemetry, payments, tunnels), never API keys. */
const RESERVED_ENV = /^(?:ANTSEED_|POSTHOG_|CDP_)/

export type Obj = Record<string, unknown>
export const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

/** A deployment that breaks a rule; its message says which. */
export class RuleError extends Error {}
export function check(ok: unknown, why: string): asserts ok {
  if (!ok) throw new RuleError(why)
}

export function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new RuleError(`${what} is not JSON`)
  }
}

function origin(url: unknown, where: string): string {
  check(typeof url === 'string', `${where} must be a URL`)
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new RuleError(`${where} is not a URL`)
  }
  check(u.protocol === 'https:' && !u.username && !u.password, `${where} must be an https URL without credentials`)
  return u.origin
}

/** A path rewrite must keep requests on the upstream it belongs to. */
function checkPathRewrite(rewrite: unknown, baseUrl: string, where: string): void {
  if (rewrite === undefined) return
  check(isObj(rewrite), `${where} pathRewrite must be a map`)
  const base = baseUrl.replace(/\/+$/, '')
  const baseOrigin = origin(baseUrl, `${where} baseUrl`)
  for (const [from, to] of Object.entries(rewrite)) {
    check(typeof to === 'string' && to.startsWith('/') && !to.startsWith('//'), `${where} pathRewrite for ${from} must be a path starting with one "/"`)
    check(origin(base + to, `${where} pathRewrite for ${from}`) === baseOrigin, `${where} pathRewrite for ${from} leaves the upstream`)
  }
}

/** Check a seller config; returns its upstreams and the API key variables it reads (apiKeyEnv). */
export function checkSellerConfig(config: unknown): { upstreams: SellerUpstream[]; apiKeyEnvs: Set<string> } {
  check(isObj(config), 'seller config must be an object')
  const providers = isObj(config['seller']) ? config['seller']['providers'] : undefined
  check(isObj(providers) && Object.keys(providers).length > 0, 'seller config has no providers')
  const upstreams: SellerUpstream[] = []
  const apiKeyEnvs = new Set<string>()
  const keyEnv = (v: unknown): void => {
    if (typeof v === 'string') apiKeyEnvs.add(v)
  }
  for (const [provider, cfg] of Object.entries(providers)) {
    check(isObj(cfg) && typeof cfg['plugin'] === 'string', `provider ${provider} has no plugin`)
    keyEnv(cfg['apiKeyEnv'])
    const plugin = cfg['plugin'].replace(/^@antseed\/provider-/, '')
    const spec = PLUGINS[plugin]
    check(spec, `provider ${provider} uses plugin "${cfg['plugin']}", which a TEE seller cannot use`)
    check(spec.baseUrl || cfg['baseUrl'] === undefined, `provider ${provider} sets a baseUrl its plugin ignores`)
    const baseUrl = cfg['baseUrl'] ?? spec.defaultUrl
    upstreams.push({ provider, plugin, origin: origin(baseUrl, `provider ${provider} baseUrl`) })
    checkPathRewrite(cfg['pathRewrite'], baseUrl as string, `provider ${provider}`)
    const fallbacks = cfg['fallbackUpstreams']
    if (fallbacks === undefined) continue
    check(spec.fallbacks && Array.isArray(fallbacks), `provider ${provider} fallbackUpstreams are not supported`)
    fallbacks.forEach((f, i) => {
      check(isObj(f), `provider ${provider} fallbackUpstreams[${i}] must be an object`)
      keyEnv(f['apiKeyEnv'])
      const where = `provider ${provider} fallbackUpstreams[${i}]`
      upstreams.push({ provider, plugin, origin: origin(f['baseUrl'], `${where}.baseUrl`) })
      // A fallback without its own rewrites uses the provider's, so check those against it too.
      checkPathRewrite(f['pathRewrite'] ?? cfg['pathRewrite'], f['baseUrl'] as string, where)
    })
  }
  return { upstreams, apiKeyEnvs }
}

/** Hidden secrets may only be the node's own secrets and the API keys the seller config names. */
export function checkHiddenSecrets(secrets: Iterable<string>, apiKeyEnvs: ReadonlySet<string>): void {
  for (const name of secrets) {
    check(SECRET_ENV.test(name) && (NODE_SECRETS.has(name) || (apiKeyEnvs.has(name) && !RESERVED_ENV.test(name))), `environment ${name} is hidden but is not an API key the seller config names`)
  }
}
