#!/usr/bin/env node
// Writes a TEE seller's dstack compose file (JSON, which buyers check) from its seller config:
// the image pinned by digest, the config inline, and each API key the config names as an
// encrypted secret. Prints the encrypted variables to allow on the app.
//
//   node deploy/tee-seller/compose.mjs --image ghcr.io/antseed/tee-seller@sha256:<digest> \
//     --peer <peer id> --config config.json [--env ANTSEED_VERIFIER_PROVIDER_...=value] > docker-compose.json
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    image: { type: 'string' },
    peer: { type: 'string' },
    config: { type: 'string' },
    env: { type: 'string', multiple: true },
    'rpc-url-secret': { type: 'boolean' },
  },
})
if (!/@sha256:[0-9a-f]{64}$/.test(values.image ?? '') || !/^[0-9a-f]{40}$/.test(values.peer ?? '') || !values.config) {
  console.error('usage: node deploy/tee-seller/compose.mjs --image <image@sha256:digest> --peer <40 hex peer id> --config <config.json> [--env KEY=VALUE] [--rpc-url-secret]')
  process.exit(1)
}

const configText = readFileSync(values.config, 'utf8')
const config = JSON.parse(configText)
if (configText.includes('$')) throw new Error('the seller config may not contain "$": compose would substitute it')

// API keys come in as secrets named by each provider's (and fallback's) apiKeyEnv, which must end in _API_KEY.
const secrets = new Set(['ANTSEED_IDENTITY_HEX'])
// Variables the CLI reads for its own settings (ANTSEED_*, POSTHOG_*, CDP_*) can't be API keys.
const API_KEY = /^(?!ANTSEED_|POSTHOG_|CDP_)[A-Z][A-Z0-9_]*_API_KEY$/
for (const [name, provider] of Object.entries(config.seller?.providers ?? {})) {
  // A fallback without its own apiKeyEnv reuses the provider's.
  const names = [provider.apiKeyEnv, ...(provider.fallbackUpstreams ?? []).flatMap((f) => (f.apiKeyEnv === undefined ? [] : [f.apiKeyEnv]))]
  if (!names.every((env) => API_KEY.test(env ?? ''))) throw new Error(`provider ${name}: set apiKeyEnv to a variable name ending in _API_KEY, not starting with ANTSEED_, POSTHOG_ or CDP_`)
  for (const env of names) secrets.add(env)
}
if (values['rpc-url-secret']) secrets.add('ANTSEED_BASE_RPC_URL')

const environment = { ANTSEED_TEE_PEER_ID: values.peer }
for (const name of secrets) environment[name] = `\${${name}}`
environment.ANTSEED_VERIFIER_SIGNING_KEY = '${ANTSEED_IDENTITY_HEX}'
for (const pair of values.env ?? []) {
  const at = pair.indexOf('=')
  environment[pair.slice(0, at)] = pair.slice(at + 1)
}

const compose = {
  services: {
    seller: {
      image: values.image,
      restart: 'always',
      // The announced address is the container port, so the public port must be the same.
      ports: ['6882:6882', '6881:6881/udp'],
      environment,
      volumes: ['/var/run/dstack.sock:/var/run/dstack.sock', 'seller-data:/var/lib/antseed'],
      configs: [{ source: 'seller-config', target: '/etc/antseed/config.json' }],
    },
  },
  configs: { 'seller-config': { content: JSON.stringify(config) } },
  volumes: { 'seller-data': {} },
}
process.stdout.write(`${JSON.stringify(compose, null, 2)}\n`)
console.error(`Allow exactly these encrypted variables on the app: ${[...secrets].join(', ')}`)
