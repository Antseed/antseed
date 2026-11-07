// Entry point of the TEE seller image. It starts `antseed seller` for the TEE it runs in:
//
//   - dstack (Phala): the app compose mounts the seller config at /etc/antseed/config.json and
//     passes secrets as encrypted environment variables;
//   - Google Confidential Space: the operator sets the seller config (ANTSEED_SELLER_CONFIG_JSON)
//     and where the secrets live (ANTSEED_GCP_SECRETS) as env overrides, which Google's
//     attestation token shows to buyers. Secret values must not appear there, so this fetches
//     them from Secret Manager with the workload's own attestation (workload identity
//     federation), which Google releases only to the attested image.
//
// Either way the seller config and secret names must pass the same rules buyers check.
import { existsSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'

const PLUGINS = '/home/nonroot/.antseed/plugins/node_modules'
const CLI = `${PLUGINS}/@antseed/cli/dist/cli/index.js`
const DATA_DIR = '/var/lib/antseed'
const CS_SOCKET = '/run/container_launcher/teeserver.sock'
const { checkHiddenSecrets, checkSellerConfig } = await import(`${PLUGINS}/@antseed/antseed-verifier/dist/seller-config-rules.js`)

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

/** Exchange the attestation token for a federated access token and read each secret version. */
async function loadSecrets({ audience, secrets }) {
  const subjectToken = await launcherToken('https://sts.googleapis.com')
  const { access_token: accessToken } = await json('https://sts.googleapis.com/v1/token', {
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
  for (const [name, version] of Object.entries(secrets)) {
    const { payload } = await json(`https://secretmanager.googleapis.com/v1/${version}:access`, { headers: { authorization: `Bearer ${accessToken}` } })
    process.env[name] = Buffer.from(payload.data, 'base64').toString('utf8').trim()
  }
}

let configPath = '/etc/antseed/config.json'
try {
  if (existsSync(CS_SOCKET)) {
    process.env.ANTSEED_VERIFIER_NODE_TEE = 'confidential-space'
    const configText = process.env.ANTSEED_SELLER_CONFIG_JSON
    if (!configText) fail('set the seller config in ANTSEED_SELLER_CONFIG_JSON')
    const { apiKeyEnvs } = checkSellerConfig(JSON.parse(configText))
    const spec = process.env.ANTSEED_GCP_SECRETS ? JSON.parse(process.env.ANTSEED_GCP_SECRETS) : { secrets: {} }
    checkHiddenSecrets(Object.keys(spec.secrets ?? {}), apiKeyEnvs)
    if (Object.keys(spec.secrets ?? {}).length > 0) await loadSecrets(spec)
    configPath = `${DATA_DIR}/tee-seller-config.json`
    writeFileSync(configPath, configText, { mode: 0o600 })
  } else {
    process.env.ANTSEED_VERIFIER_NODE_TEE = 'dstack'
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}
if (process.env.ANTSEED_IDENTITY_HEX && !process.env.ANTSEED_VERIFIER_SIGNING_KEY) process.env.ANTSEED_VERIFIER_SIGNING_KEY = process.env.ANTSEED_IDENTITY_HEX

process.argv = [process.argv[0], CLI, '--config', configPath, '--data-dir', DATA_DIR, ...process.argv.slice(2)]
await import(CLI)
