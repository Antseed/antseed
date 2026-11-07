// Entry point of the TEE seller image. It starts `antseed seller` for the TEE it runs in:
//
//   - dstack (Phala): the app compose mounts the seller config at /etc/antseed/config.json and
//     passes secrets as encrypted environment variables;
//   - Google Confidential Space: the operator sets the seller config (ANTSEED_SELLER_CONFIG_JSON)
//     and where the secrets live (ANTSEED_GCP_SECRETS) as env overrides, which Google's
//     attestation token shows to buyers. Secret values must not appear there, so this fetches
//     them from Secret Manager with the workload's own attestation (workload identity
//     federation), which Google releases only to the attested image. Its VM keeps no data
//     across a restart, so the operator must name a Cloud Storage location (ANTSEED_GCP_STATE):
//     the seller's payment and metering state is restored from it on boot and saved to it,
//     encrypted, while the seller runs and after it stops (see state.mjs).
//
// Either way the seller config and secret names must pass the same rules buyers check.
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { StateConflictError, keepLease, leaseHolder, stateLease, stateSyncs } from './state.mjs'

const PLUGINS = '/home/nonroot/.antseed/plugins/node_modules'
const CLI = `${PLUGINS}/@antseed/cli/dist/cli/index.js`
const DATA_DIR = '/var/lib/antseed'
const CS_SOCKET = '/run/container_launcher/teeserver.sock'
const VERIFIER = `${PLUGINS}/@antseed/antseed-verifier/dist`
const { checkHiddenSecrets, checkSellerConfig } = await import(`${VERIFIER}/seller-config-rules.js`)
const { parseStateLocation } = await import(`${VERIFIER}/confidential-space.js`)
const { postUnix } = await import(`${VERIFIER}/collect/unix-http.js`)

function fail(message) {
  console.error(`[tee-seller] ${message}`)
  process.exit(1)
}

/** A Confidential Space attestation token for `audience`, from the container launcher. */
async function launcherToken(audience) {
  const body = JSON.stringify({ audience, token_type: 'OIDC' })
  const { status, body: token } = await postUnix(CS_SOCKET, '/v1/token', body, { timeoutMs: REQUEST_TIMEOUT_MS, timeoutMessage: 'launcher token request timed out' })
  if (status !== 200) throw new Error(`launcher token HTTP ${status}`)
  return token.trim()
}

async function json(url, init) {
  const res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`${new URL(url).host} answered HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return res.json()
}

/** A federated access token for the workload identity provider `audience`, exchanged for the attestation token and reused until near expiry. */
function federatedToken(audience) {
  let cached = { token: '', expiresAt: 0 }
  return async () => {
    if (Date.now() < cached.expiresAt) return cached.token
    const subjectToken = await launcherToken('https://sts.googleapis.com')
    const { access_token: token, expires_in: expiresIn } = await json('https://sts.googleapis.com/v1/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      subjectToken,
      subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
      }),
    })
    cached = { token, expiresAt: Date.now() + (Number(expiresIn) || 3600) * 1000 - 300_000 }
    return token
  }
}

/** Read each secret version into the environment. */
async function loadSecrets(secrets, accessToken) {
  for (const [name, version] of Object.entries(secrets)) {
    const { payload } = await json(`https://secretmanager.googleapis.com/v1/${version}:access`, { headers: { authorization: `Bearer ${await accessToken()}` } })
    process.env[name] = Buffer.from(payload.data, 'base64').toString('utf8').trim()
  }
}

// Google requests give up after this long, so a stalled one can't hold up startup or saving.
const REQUEST_TIMEOUT_MS = 30_000
// A fenced seller that hasn't stopped after this long is killed: its lease may expire soon after.
const FENCE_KILL_MS = 30_000

let configPath = '/etc/antseed/config.json'
let state = []
let lease = null
let keeper = null
let seller = null
try {
  if (existsSync(CS_SOCKET)) {
    process.env.ANTSEED_VERIFIER_NODE_TEE = 'confidential-space'
    const configText = process.env.ANTSEED_SELLER_CONFIG_JSON
    if (!configText) fail('set the seller config in ANTSEED_SELLER_CONFIG_JSON')
    const { apiKeyEnvs } = checkSellerConfig(JSON.parse(configText))
    const spec = process.env.ANTSEED_GCP_SECRETS ? JSON.parse(process.env.ANTSEED_GCP_SECRETS) : { secrets: {} }
    const secrets = spec.secrets ?? {}
    checkHiddenSecrets(Object.keys(secrets), apiKeyEnvs)
    const accessToken = spec.audience ? federatedToken(spec.audience) : null
    if (Object.keys(secrets).length > 0) await loadSecrets(secrets, accessToken)
    // The VM keeps nothing across a restart: without saved state, a restart would lose the buyer
    // signatures the seller settles its payment channels with.
    const location = parseStateLocation(process.env.ANTSEED_GCP_STATE ?? '')
    if (!location) fail('set ANTSEED_GCP_STATE to the gs://<bucket>/<prefix> that keeps the seller\'s state across restarts')
    if (!accessToken) fail('ANTSEED_GCP_STATE needs the workload identity provider in ANTSEED_GCP_SECRETS "audience"')
    if (!process.env.ANTSEED_IDENTITY_HEX) fail('ANTSEED_GCP_STATE needs the seller identity (ANTSEED_IDENTITY_HEX) from Secret Manager')
    // Only one instance with this identity restores and serves at a time.
    lease = stateLease(location, accessToken, leaseHolder(DATA_DIR))
    await lease.acquire({
      onWait: (held) => console.log(`[tee-seller] another seller instance holds ${process.env.ANTSEED_GCP_STATE}/lease until ${new Date(held.expiresAt).toISOString()}; waiting`),
    })
    // Kept from now on, so a slow restore can't outlast it; losing it stops this seller.
    keeper = keepLease(lease, {
      onLost: (reason) => (seller ? fence(reason) : fail(reason)),
      onRetry: (err) => console.error(`[tee-seller] renewing the state lease failed, retrying: ${err instanceof Error ? err.message : String(err)}`),
    })
    const Database = createRequire(`${PLUGINS}/@antseed/node/package.json`)('better-sqlite3')
    state = stateSyncs(location, accessToken, process.env.ANTSEED_IDENTITY_HEX, DATA_DIR, Database, keeper.ownedUntil)
    for (const sync of state) {
      console.log(`[tee-seller] ${(await sync.restore()) ? 'restored' : 'keeping'} ${sync.file.name} in ${sync.location}`)
    }
    configPath = `${DATA_DIR}/tee-seller-config.json`
    writeFileSync(configPath, configText, { mode: 0o600 })
  } else {
    process.env.ANTSEED_VERIFIER_NODE_TEE = 'dstack'
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}
// Logs and databases keep no upstream text, so the operator may read them (see isContentFreeLogging).
process.env.ANTSEED_CONTENT_FREE_LOGS = '1'
if (process.env.ANTSEED_IDENTITY_HEX && !process.env.ANTSEED_VERIFIER_SIGNING_KEY) process.env.ANTSEED_VERIFIER_SIGNING_KEY = process.env.ANTSEED_IDENTITY_HEX

if (keeper && !keeper.valid()) fail('the state lease lapsed before the seller started')
// The seller runs as a child so its state can be saved once more after it has shut down cleanly.
seller = spawn(process.execPath, [CLI, '--config', configPath, '--data-dir', DATA_DIR, ...process.argv.slice(2)], { stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => seller.kill(signal))

/** Stop serving without saving: another instance owns the state now. */
function fence(reason) {
  console.error(`[tee-seller] ${reason}; stopping this seller`)
  process.exitCode = 1
  seller.kill('SIGTERM')
  setTimeout(() => seller.kill('SIGKILL'), FENCE_KILL_MS).unref()
}

async function saveState(sync) {
  try {
    await sync.save()
  } catch (err) {
    if (err instanceof StateConflictError) {
      fence(err.message)
    } else {
      console.error(`[tee-seller] saving ${sync.file.name} failed, retrying: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
const timers = state.map((sync) => setInterval(() => void saveState(sync), sync.file.everyMs))

seller.on('exit', async (code, signal) => {
  for (const timer of timers) clearInterval(timer)
  // Still renewed through the last save, then released.
  if (process.exitCode !== 1) {
    // The seller has closed its databases: save each once more, retrying, as nothing saves them later.
    const results = await Promise.allSettled(state.map((sync) => sync.saveFinal()))
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        console.error(`[tee-seller] the last save of ${state[i].file.name} failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)
        process.exitCode = 1
      }
    })
    // Saved: the next instance may start at once. Unsaved, the lease stays until it expires, so a
    // restart on this VM (same holder) takes it back with its newer local databases first.
    keeper?.stop()
    if (process.exitCode !== 1) {
      await lease?.release().catch((err) => console.error(`[tee-seller] releasing the state lease failed: ${err instanceof Error ? err.message : String(err)}`))
    }
  }
  process.exit(process.exitCode ?? code ?? (signal ? 1 : 0))
})
