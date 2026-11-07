// Entry point of the TEE seller image. It starts `antseed seller` for the TEE it runs in:
//
//   - dstack (Phala): the app compose mounts the seller config at /etc/antseed/config.json and
//     passes secrets as encrypted environment variables;
//   - Google Confidential Space: the operator sets the seller config (ANTSEED_SELLER_CONFIG_JSON)
//     and where the secrets live (ANTSEED_GCP_SECRETS) as env overrides, which Google's
//     attestation token shows to buyers. Secret values must not appear there, so this fetches
//     them from Secret Manager with the workload's own attestation (workload identity
//     federation), which Google releases only to the attested image. Its VM keeps no data
//     across a restart, so if the operator names a Cloud Storage location (ANTSEED_GCP_STATE) the
//     seller's payment and metering state is restored from it on boot and saved to it, encrypted,
//     while the seller runs and after it stops (see state.mjs).
//
// Either way the seller config and secret names must pass the same rules buyers check.
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createRequire } from 'node:module'
import { StateConflictError, stateSyncs } from './state.mjs'

const PLUGINS = '/home/nonroot/.antseed/plugins/node_modules'
const CLI = `${PLUGINS}/@antseed/cli/dist/cli/index.js`
const DATA_DIR = '/var/lib/antseed'
const CS_SOCKET = '/run/container_launcher/teeserver.sock'
const VERIFIER = `${PLUGINS}/@antseed/antseed-verifier/dist`
const { checkHiddenSecrets, checkSellerConfig } = await import(`${VERIFIER}/seller-config-rules.js`)
const { parseStateLocation } = await import(`${VERIFIER}/confidential-space.js`)

function fail(message) {
  console.error(`[tee-seller] ${message}`)
  process.exit(1)
}

/** A Confidential Space attestation token for `audience`, from the container launcher. */
function launcherToken(audience) {
  const body = JSON.stringify({ audience, token_type: 'OIDC' })
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: CS_SOCKET, path: '/v1/token', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => (res.statusCode === 200 ? resolve(Buffer.concat(chunks).toString('utf8').trim()) : reject(new Error(`launcher token HTTP ${res.statusCode}`))))
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function json(url, init) {
  const res = await fetch(url, { ...init, redirect: 'error' })
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

let configPath = '/etc/antseed/config.json'
let state = []
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
    if (process.env.ANTSEED_GCP_STATE) {
      const location = parseStateLocation(process.env.ANTSEED_GCP_STATE)
      if (!location) fail('ANTSEED_GCP_STATE must be a gs://<bucket>/<prefix> URL')
      if (!accessToken) fail('ANTSEED_GCP_STATE needs the workload identity provider in ANTSEED_GCP_SECRETS "audience"')
      if (!process.env.ANTSEED_IDENTITY_HEX) fail('ANTSEED_GCP_STATE needs the seller identity (ANTSEED_IDENTITY_HEX) from Secret Manager')
      const Database = createRequire(`${PLUGINS}/@antseed/node/package.json`)('better-sqlite3')
      state = stateSyncs(location, accessToken, process.env.ANTSEED_IDENTITY_HEX, DATA_DIR, Database)
      for (const sync of state) {
        console.log(`[tee-seller] ${(await sync.restore()) ? 'restored' : 'keeping'} ${sync.file.name} in ${sync.location}`)
      }
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

// The seller runs as a child so its state can be saved once more after it has shut down cleanly.
const seller = spawn(process.execPath, [CLI, '--config', configPath, '--data-dir', DATA_DIR, ...process.argv.slice(2)], { stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => seller.kill(signal))

async function saveState(sync) {
  try {
    await sync.save()
  } catch (err) {
    if (err instanceof StateConflictError) {
      // Another instance with this identity owns the state: stop rather than overwrite its payments.
      console.error(`[tee-seller] ${err.message}; stopping this seller`)
      seller.kill('SIGTERM')
      process.exitCode = 1
    } else {
      console.error(`[tee-seller] saving ${sync.file.name} failed, retrying: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
const timers = state.map((sync) => setInterval(() => void saveState(sync), sync.file.everyMs))

seller.on('exit', async (code, signal) => {
  for (const timer of timers) clearInterval(timer)
  if (process.exitCode !== 1) {
    // The seller has closed its databases: save each once more, after any save still running.
    await Promise.all(state.map(async (sync) => {
      await sync.saving
      await saveState(sync)
    }))
  }
  process.exit(process.exitCode ?? code ?? (signal ? 1 : 0))
})
