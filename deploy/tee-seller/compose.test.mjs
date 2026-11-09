import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, before, after } from 'node:test'

const SCRIPT = new URL('./compose.mjs', import.meta.url).pathname
const IMAGE = `ghcr.io/antseed/tee-seller@sha256:${'a'.repeat(64)}`
const PEER = 'b'.repeat(40)

function seller(displayName) {
  return {
    identity: { displayName },
    seller: { providers: { inference: { plugin: 'openai', baseUrl: 'https://upstream.example', apiKeyEnv: 'OPENAI_API_KEY', services: { m: { upstreamModel: 'm' } } } } },
  }
}

describe('compose.mjs', () => {
  let dir
  before(() => { dir = mkdtempSync(join(tmpdir(), 'tee-compose-')) })
  after(() => rmSync(dir, { recursive: true, force: true }))

  function compose(config) {
    const file = join(dir, 'config.json')
    writeFileSync(file, JSON.stringify(config))
    return JSON.parse(execFileSync(process.execPath, [SCRIPT, '--image', IMAGE, '--peer', PEER, '--config', file], { stdio: ['ignore', 'pipe', 'ignore'] }).toString())
  }

  it('names the inline config after its content and mounts it', () => {
    const out = compose(seller('A'))
    const [name] = Object.keys(out.configs)
    const content = out.configs[name].content
    assert.equal(name, `seller-config-${createHash('sha256').update(content).digest('hex').slice(0, 12)}`)
    assert.deepEqual(out.services.seller.configs, [{ source: name, target: '/etc/antseed/config.json' }])
  })

  it('changes the service definition when only the config changes, so compose recreates the seller', () => {
    const a = compose(seller('A'))
    const b = compose(seller('B'))
    assert.notDeepEqual(a.services.seller, b.services.seller)
    assert.deepEqual(compose(seller('A')), a)
  })
})
