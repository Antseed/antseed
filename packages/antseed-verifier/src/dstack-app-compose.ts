import { createHash } from 'node:crypto'
import type { ApprovedSellerImage } from './approved-seller-images.js'
import { LITERAL_ENV, SECRET_ENV, check, checkHiddenSecrets, checkSellerConfig, isObj, parseJson, RuleError, type SellerUpstream } from './seller-config-rules.js'

export type { SellerUpstream } from './seller-config-rules.js'

/**
 * A dstack app is measured as the SHA-256 of its app-compose.json, which embeds the docker
 * compose file. The seller sends that document with its quote. The buyer hashes it against the
 * compose hash replayed from the quote's RTMR3, then checks it with the rules below. A
 * conforming compose runs one approved Antseed TEE seller image, and every setting that decides
 * where prompts go is written in it literally, so the buyer reads it directly. Only secrets come
 * in hidden, as encrypted environment variables, and no secret can redirect prompts.
 *
 * The rules (anything not listed is rejected):
 *   - app-compose: runner docker-compose; no pre-launch or bash script; the allowed encrypted
 *     variables are only the secrets the compose file uses. Logs may be public: the image runs
 *     the seller in content-free mode, so they hold no prompts or answers, nor upstream error text about a request.
 *     A launch token hash (launch_token_hash) is allowed: it only stops the CVM from booting
 *     without the matching token.
 *   - compose file: written as JSON; one service; image pinned by an approved digest; no command,
 *     entrypoint, user or other service options; the only volumes are the seller data volume and
 *     the dstack socket; the seller config is one inline config at /etc/antseed/config.json.
 *   - environment: the literal settings LITERAL_ENV allows; secrets only as `NAME: ${NAME}` for
 *     the names checkHiddenSecrets allows, plus `ANTSEED_VERIFIER_SIGNING_KEY: ${ANTSEED_IDENTITY_HEX}`.
 *     No `$` anywhere else, because compose substitutes variables in every value, the inline
 *     config included.
 *   - seller config: the rules in seller-config-rules.ts.
 */

export interface CheckedAppCompose {
  image: ApprovedSellerImage
  upstreams: SellerUpstream[]
}

const APP_COMPOSE_KEYS = new Set([
  'manifest_version', 'name', 'features', 'runner', 'docker_compose_file', 'docker_config',
  'public_logs', 'public_sysinfo', 'public_tcbinfo', 'kms_enabled', 'gateway_enabled', 'tproxy_enabled',
  'local_key_provider_enabled', 'key_provider', 'key_provider_id', 'allowed_envs', 'no_instance_id',
  'secure_time', 'pre_launch_script', 'storage_fs', 'swap_size', 'launch_token_hash',
])
const SERVICE_KEYS = new Set(['image', 'restart', 'ports', 'environment', 'volumes', 'configs', 'container_name'])
const CONFIG_PATH = '/etc/antseed/config.json'
const DATA_DIR = '/var/lib/antseed'
const DSTACK_SOCKET = '/var/run/dstack.sock'
const IMAGE = /^[a-z0-9][a-z0-9._/:-]*@(sha256:[0-9a-f]{64})$/

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
  const { upstreams, apiKeyEnvs } = checkSellerConfig(parseJson(content['content'], 'seller config'))
  checkHiddenSecrets(secrets, apiKeyEnvs)
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
    const { image, upstreams, secrets } = checkComposeFile(parseJson(app['docker_compose_file'], 'compose file (write it as JSON)'), images)
    const allowed = app['allowed_envs'] ?? []
    check(Array.isArray(allowed) && allowed.every((n) => typeof n === 'string' && secrets.has(n)), 'app may only accept the encrypted variables its compose file uses as secrets')
    return { image, upstreams }
  } catch (err) {
    if (err instanceof RuleError) return { error: err.message }
    throw err
  }
}
