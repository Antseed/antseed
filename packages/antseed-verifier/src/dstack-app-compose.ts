import { createHash } from 'node:crypto'
import type { ApprovedSellerImage } from './approved-seller-images.js'
import teeProviderPlugins from './tee-provider-plugins.json' with { type: 'json' }

/**
 * A dstack app is measured as the SHA-256 of its app-compose.json, which embeds the docker
 * compose file. The seller sends that document with its quote. The buyer hashes it against the
 * compose hash replayed from the quote's RTMR3, then checks it with the rules below. A
 * conforming compose runs one approved Antseed TEE seller image, and every setting that decides
 * where prompts go is written in it literally, so the buyer reads it directly. Only secrets come
 * in hidden, as encrypted environment variables, and no secret can redirect prompts.
 *
 * The rules (anything not listed is rejected):
 *   - app-compose: runner docker-compose; no pre-launch or bash script; public logs off; the
 *     allowed encrypted variables are only the secrets the compose file uses.
 *   - compose file: written as JSON; one service; image pinned by an approved digest; no command,
 *     entrypoint, user or other service options; the only volumes are the seller data volume and
 *     the dstack socket; the seller config is one inline config at /etc/antseed/config.json.
 *   - environment: ANTSEED_TEE_PEER_ID and ANTSEED_VERIFIER_PROVIDER_* as literals; secrets
 *     only as `NAME: ${NAME}` for ANTSEED_IDENTITY_HEX, ANTSEED_BASE_RPC_URL and the *_API_KEY
 *     names the seller config gives as apiKeyEnv (never one the CLI reads for itself), plus
 *     `ANTSEED_VERIFIER_SIGNING_KEY: ${ANTSEED_IDENTITY_HEX}`. No `$` anywhere else, because
 *     compose substitutes variables in every value, the inline config included.
 *   - seller config: only the settings listed in CONFIG_KEYS (anything that loads code, such as
 *     seller.agentDir, which imports tool modules from the data volume, is rejected); each
 *     provider uses a plugin listed below, every upstream is https, and
 *     every path rewrite is a path on that upstream (the relay appends it to the base URL, so a
 *     value like "@other.example/v1" would move the request to another host). The approved
 *     images' relay refuses upstream redirects, so requests stay on these origins.
 */

/** One place a seller node forwards prompts to, read from its measured config. */
export interface SellerUpstream {
  /** The provider's name in the seller config. */
  provider: string
  plugin: string
  /** https origin, e.g. "https://api.openai.com". */
  origin: string
}

export interface CheckedAppCompose {
  image: ApprovedSellerImage
  upstreams: SellerUpstream[]
}

/**
 * The provider plugins a TEE seller may use (tee-provider-plugins.json, which also decides the
 * image's plugins): each one's default upstream, and whether the config's baseUrl (and
 * fallbackUpstreams) changes it. Each sends buyer content only to that upstream. fal-video is
 * left out: it uploads buyer media to a storage host the storage service names at runtime, which
 * the config cannot show.
 */
const PLUGINS: Readonly<Record<string, { defaultUrl: string; baseUrl: boolean; fallbacks?: boolean }>> = teeProviderPlugins

const APP_COMPOSE_KEYS = new Set([
  'manifest_version', 'name', 'features', 'runner', 'docker_compose_file', 'docker_config',
  'public_logs', 'public_sysinfo', 'public_tcbinfo', 'kms_enabled', 'gateway_enabled', 'tproxy_enabled',
  'local_key_provider_enabled', 'key_provider', 'key_provider_id', 'allowed_envs', 'no_instance_id',
  'secure_time', 'pre_launch_script', 'storage_fs', 'swap_size',
])
const SERVICE_KEYS = new Set(['image', 'restart', 'ports', 'environment', 'volumes', 'configs', 'container_name'])
const CONFIG_PATH = '/etc/antseed/config.json'
const DATA_DIR = '/var/lib/antseed'
const DSTACK_SOCKET = '/var/run/dstack.sock'
const LITERAL_ENV = /^(?:ANTSEED_TEE_PEER_ID|ANTSEED_VERIFIER_PROVIDER_[A-Z0-9_]+)$/
const SECRET_ENV = /^(?:ANTSEED_IDENTITY_HEX|ANTSEED_BASE_RPC_URL|[A-Z][A-Z0-9_]*_API_KEY)$/
/** Secrets the CLI reads itself; any other hidden variable must be a provider API key the config names. */
const NODE_SECRETS = new Set(['ANTSEED_IDENTITY_HEX', 'ANTSEED_BASE_RPC_URL'])
/** Prefixes of variables the CLI reads for its own settings (telemetry, payments, tunnels), never API keys. */
const RESERVED_ENV = /^(?:ANTSEED_|POSTHOG_|CDP_)/
/**
 * The seller config settings a TEE seller may use, by section. Each one only tunes the seller;
 * none loads code (seller.agentDir imports agent tool modules from disk, which no measurement
 * covers) or configures the buyer, verifier or relayer roles.
 */
const CONFIG_KEYS = {
  config: new Set(['identity', 'seller', 'payments', 'network', 'telemetry']),
  seller: new Set([
    'reserveFloor', 'maxConcurrentBuyers', 'providers', 'publicAddress', 'verifications', 'maxUploadBodyBytes',
    'maxInboundConnections', 'inboundIdleTimeoutMs', 'verifiers', 'healthCheck', 'gasCheck', 'gasRefuel', 'freeTier',
    'alerts', 'restrictedCountries', 'freeUsage', 'buyerLimits',
  ]),
  provider: new Set(['plugin', 'baseUrl', 'apiKeyEnv', 'pathRewrite', 'fallbackUpstreams', 'defaults', 'services']),
  fallback: new Set(['baseUrl', 'apiKeyEnv', 'pathRewrite', 'services']),
} satisfies Readonly<Record<string, ReadonlySet<string>>>

function checkKeys(value: Obj, section: keyof typeof CONFIG_KEYS, where: string): void {
  const extra = Object.keys(value).filter((k) => !CONFIG_KEYS[section].has(k))
  check(extra.length === 0, `${where}${extra[0]} is not allowed in a TEE seller config`)
}

const IMAGE = /^[a-z0-9][a-z0-9._/:-]*@(sha256:[0-9a-f]{64})$/

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

class Reject extends Error {}
function check(ok: unknown, why: string): asserts ok {
  if (!ok) throw new Reject(why)
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new Reject(`${what} is not JSON`)
  }
}

/** Whether any key or string anywhere in a value contains "$". */
function hasVariableReference(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('$')
  if (Array.isArray(value)) return value.some(hasVariableReference)
  if (isObj(value)) return Object.entries(value).some(([key, entry]) => key.includes('$') || hasVariableReference(entry))
  return false
}

/** The secrets the environment hides, after checking every entry. */
function checkEnvironment(env: unknown): Set<string> {
  check(env === undefined || isObj(env), 'environment must be a map')
  const secrets = new Set<string>()
  for (const [key, value] of Object.entries(env ?? {})) {
    check(typeof value === 'string', `environment ${key} must be a string`)
    const ref = /^\$\{([A-Z][A-Z0-9_]*)\}$/.exec(value)?.[1]
    if (ref) {
      const signingKey = key === 'ANTSEED_VERIFIER_SIGNING_KEY' && ref === 'ANTSEED_IDENTITY_HEX'
      check(SECRET_ENV.test(ref) && (ref === key || signingKey), `environment ${key} may not come from a hidden variable`)
      secrets.add(ref)
    } else {
      check(LITERAL_ENV.test(key), `environment ${key} is not allowed`)
      check(!value.includes('$'), `environment ${key} may not reference variables`)
    }
  }
  return secrets
}

/** A configured upstream URL, which must be https without credentials. */
function upstreamUrl(url: unknown, where: string): URL {
  check(typeof url === 'string', `${where} must be a URL`)
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Reject(`${where} is not a URL`)
  }
  check(u.protocol === 'https:' && !u.username && !u.password, `${where} must be an https URL without credentials`)
  return u
}

/** A path rewrite must keep requests on the upstream it belongs to. */
function checkPathRewrite(rewrite: unknown, baseUrl: URL, where: string): void {
  if (rewrite === undefined) return
  check(isObj(rewrite), `${where} pathRewrite must be a map`)
  const base = baseUrl.href.replace(/\/+$/, '')
  for (const [from, to] of Object.entries(rewrite)) {
    check(typeof to === 'string' && to.startsWith('/') && !to.startsWith('//'), `${where} pathRewrite for ${from} must be a path starting with one "/"`)
    check(upstreamUrl(base + to, `${where} pathRewrite for ${from}`).origin === baseUrl.origin, `${where} pathRewrite for ${from} leaves the upstream`)
  }
}

/** The seller config's upstreams and the API key variables it reads (apiKeyEnv). */
function sellerUpstreams(config: unknown): { upstreams: SellerUpstream[]; apiKeyEnvs: Set<string> } {
  check(isObj(config), 'seller config must be an object')
  checkKeys(config, 'config', '')
  check(isObj(config['seller']), 'seller config has no seller section')
  checkKeys(config['seller'], 'seller', 'seller.')
  const providers = config['seller']['providers']
  check(isObj(providers) && Object.keys(providers).length > 0, 'seller config has no providers')
  const upstreams: SellerUpstream[] = []
  const apiKeyEnvs = new Set<string>()
  const keyEnv = (v: unknown): void => {
    if (typeof v === 'string') apiKeyEnvs.add(v)
  }
  for (const [provider, cfg] of Object.entries(providers)) {
    check(isObj(cfg) && typeof cfg['plugin'] === 'string', `provider ${provider} has no plugin`)
    checkKeys(cfg, 'provider', `provider ${provider} `)
    keyEnv(cfg['apiKeyEnv'])
    const plugin = cfg['plugin'].replace(/^@antseed\/provider-/, '')
    const spec = PLUGINS[plugin]
    check(spec, `provider ${provider} uses plugin "${cfg['plugin']}", which a TEE seller cannot use`)
    check(spec.baseUrl || cfg['baseUrl'] === undefined, `provider ${provider} sets a baseUrl its plugin ignores`)
    const baseUrl = upstreamUrl(cfg['baseUrl'] ?? spec.defaultUrl, `provider ${provider} baseUrl`)
    upstreams.push({ provider, plugin, origin: baseUrl.origin })
    checkPathRewrite(cfg['pathRewrite'], baseUrl, `provider ${provider}`)
    const fallbacks = cfg['fallbackUpstreams']
    if (fallbacks === undefined) continue
    check(spec.fallbacks && Array.isArray(fallbacks), `provider ${provider} fallbackUpstreams are not supported`)
    fallbacks.forEach((f, i) => {
      check(isObj(f), `provider ${provider} fallbackUpstreams[${i}] must be an object`)
      checkKeys(f, 'fallback', `provider ${provider} fallbackUpstreams[${i}] `)
      keyEnv(f['apiKeyEnv'])
      const where = `provider ${provider} fallbackUpstreams[${i}]`
      const fallbackUrl = upstreamUrl(f['baseUrl'], `${where}.baseUrl`)
      upstreams.push({ provider, plugin, origin: fallbackUrl.origin })
      // A fallback without its own rewrites uses the provider's, so check those against it too.
      checkPathRewrite(f['pathRewrite'] ?? cfg['pathRewrite'], fallbackUrl, where)
    })
  }
  return { upstreams, apiKeyEnvs }
}

function checkComposeFile(compose: unknown, images: readonly ApprovedSellerImage[]): CheckedAppCompose & { secrets: Set<string> } {
  check(isObj(compose), 'compose file must be an object')
  check(Object.keys(compose).every((k) => ['name', 'services', 'volumes', 'configs'].includes(k)), 'compose file has unsupported top-level keys')
  const services = compose['services']
  check(isObj(services) && Object.keys(services).length === 1, 'compose file must have exactly one service')
  const service = Object.values(services)[0]
  check(isObj(service), 'service must be an object')
  const extra = Object.keys(service).filter((k) => !SERVICE_KEYS.has(k))
  check(extra.length === 0, `service option ${extra[0]} is not allowed`)

  const digest = typeof service['image'] === 'string' ? IMAGE.exec(service['image'])?.[1] : undefined
  check(digest, 'service image must be pinned by digest')
  const image = images.find((i) => i.digest === digest)
  check(image, `image ${digest.slice(0, 19)}… is not an approved Antseed TEE seller image`)

  const secrets = checkEnvironment(service['environment'])
  // Compose substitutes ${...} in every value; only the environment entries checked above may use it.
  const { environment: _env, ...rest } = service
  check(!hasVariableReference({ ...compose, services: { s: rest } }), 'compose file may not reference variables outside the environment')

  check(service['ports'] === undefined || (Array.isArray(service['ports']) && service['ports'].every((p) => typeof p === 'string' && /^[0-9.:]+(?:\/(?:tcp|udp))?$/.test(p))), 'ports must be plain port mappings')
  const volumes = service['volumes'] ?? []
  check(Array.isArray(volumes), 'volumes must be a list')
  const named = new Set<string>()
  for (const v of volumes) {
    check(typeof v === 'string', 'volumes must use the short syntax')
    const [source, target, ...more] = v.split(':')
    check(more.length === 0 && source && target, `volume ${v} is not allowed`)
    if (target === DSTACK_SOCKET && source === DSTACK_SOCKET) continue
    check(target === DATA_DIR && /^[a-z0-9][a-z0-9_-]*$/.test(source), `volume ${v} is not allowed`)
    named.add(source)
  }
  const topVolumes = compose['volumes'] ?? {}
  check(isObj(topVolumes) && Object.entries(topVolumes).every(([k, v]) => named.has(k) && (v === null || (isObj(v) && Object.keys(v).length === 0))), 'volumes must be plain named volumes')

  const configs = service['configs']
  check(Array.isArray(configs) && configs.length === 1 && isObj(configs[0]), 'the seller config must be one inline config')
  const ref = configs[0]
  check(Object.keys(ref).every((k) => k === 'source' || k === 'target') && ref['target'] === CONFIG_PATH, `the seller config must be mounted at ${CONFIG_PATH}`)
  const top = compose['configs']
  check(isObj(top) && Object.keys(top).length === 1 && typeof ref['source'] === 'string', 'the seller config must be one inline config')
  const content = top[ref['source']]
  check(isObj(content) && Object.keys(content).length === 1 && typeof content['content'] === 'string', 'the seller config must be inline content')
  const { upstreams, apiKeyEnvs } = sellerUpstreams(parseJson(content['content'], 'seller config'))
  for (const name of secrets) {
    check(NODE_SECRETS.has(name) || (apiKeyEnvs.has(name) && !RESERVED_ENV.test(name)), `environment ${name} is hidden but is not an API key the seller config names`)
  }
  return { image, upstreams, secrets }
}

/**
 * Check a seller's app-compose.json against the compose hash its quote measured, then against
 * the rules above. Returns the approved image and the seller's upstreams, or why it fails.
 */
export function checkAppCompose(
  appCompose: string,
  composeHash: string,
  images: readonly ApprovedSellerImage[],
): CheckedAppCompose | { error: string } {
  if (createHash('sha256').update(appCompose, 'utf8').digest('hex') !== composeHash.toLowerCase()) {
    return { error: 'app compose does not match the measured compose hash' }
  }
  try {
    const app = parseJson(appCompose, 'app compose')
    check(isObj(app), 'app compose must be an object')
    const extra = Object.keys(app).filter((k) => !APP_COMPOSE_KEYS.has(k))
    check(extra.length === 0, `app compose option ${extra[0]} is not allowed`)
    check(app['runner'] === 'docker-compose' && typeof app['docker_compose_file'] === 'string', 'app must run a docker compose file')
    check(!app['pre_launch_script'], 'app may not run a pre-launch script')
    check(app['public_logs'] !== true, 'app logs must not be public')
    const { image, upstreams, secrets } = checkComposeFile(parseJson(app['docker_compose_file'], 'compose file (write it as JSON)'), images)
    const allowed = app['allowed_envs'] ?? []
    check(Array.isArray(allowed) && allowed.every((n) => typeof n === 'string' && secrets.has(n)), 'app may only accept the encrypted variables its compose file uses as secrets')
    return { image, upstreams }
  } catch (err) {
    if (err instanceof Reject) return { error: err.message }
    throw err
  }
}
