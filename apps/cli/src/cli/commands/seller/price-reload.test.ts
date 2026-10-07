import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ConfigField, Provider } from '@antseed/node'
import { startSellerPriceReload, type PriceReloadTarget } from './price-reload.js'

const FIELDS: ConfigField[] = [
  { key: 'ANTSEED_INPUT_USD_PER_MILLION', label: 'in', type: 'number', default: 10 },
  { key: 'ANTSEED_OUTPUT_USD_PER_MILLION', label: 'out', type: 'number', default: 10 },
  { key: 'ANTSEED_CACHED_INPUT_USD_PER_MILLION', label: 'cached', type: 'number' },
  { key: 'ANTSEED_SERVICE_PRICING_JSON', label: 'svc', type: 'string' },
]

function sellerConfig(providers: Record<string, unknown>): string {
  return JSON.stringify({ seller: { providers } }, null, 2)
}

function provider(input: number): Provider {
  return {
    name: 'openai', services: ['m'], maxConcurrency: 1,
    pricing: { defaults: { inputUsdPerMillion: input, outputUsdPerMillion: input } },
    handleRequest: async () => { throw new Error('unused') },
    getCapacity: () => ({ current: 0, max: 1 }),
  }
}

function setup(initial: Record<string, unknown>, opts: { input?: number; force?: boolean; targets?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-price-reload-'))
  const configPath = join(dir, 'config.json')
  writeFileSync(configPath, sellerConfig(initial))
  const targets: PriceReloadTarget[] = (opts.targets ?? ['a']).map((name) => ({
    name, provider: provider(1), configFields: FIELDS, basePluginConfig: {},
  }))
  const warnings: string[] = []
  let applied = 0
  const handle = startSellerPriceReload({
    configPath, targets,
    runtimeOverrides: opts.input !== undefined ? { inputUsdPerMillion: opts.input } : {},
    forcePricingOverride: opts.force ?? false,
    onApplied: async () => { applied += 1 },
    log: () => {}, warn: (m) => warnings.push(m),
    debounceMs: 20, pollMs: 60_000,
  })
  return {
    dir, configPath, targets, warnings, handle,
    applied: () => applied,
    cleanup: () => { handle.stop(); rmSync(dir, { recursive: true, force: true }) },
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for reload')
    await wait(10)
  }
}

test('atomic save (write temp + rename) is picked up by the directory watcher', async () => {
  const h = setup({ a: { plugin: 'openai', defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { m: {} } } })
  try {
    await wait(100)
    const pricing = h.targets[0]!.provider.pricing
    const tmp = join(h.dir, '.config.json.tmp')
    writeFileSync(tmp, sellerConfig({ a: { plugin: 'openai', defaults: { inputUsdPerMillion: 2, outputUsdPerMillion: 3, cachedInputUsdPerMillion: 4 }, services: { m: { pricing: { inputUsdPerMillion: 5, outputUsdPerMillion: 6 } } } } }))
    renameSync(tmp, h.configPath)
    await until(() => h.applied() === 1)
    assert.equal(h.targets[0]!.provider.pricing, pricing, 'shared pricing object is updated in place')
    // cached > input is allowed by config validation, so reload must accept it too.
    assert.deepEqual(pricing.defaults, { inputUsdPerMillion: 2, outputUsdPerMillion: 3, cachedInputUsdPerMillion: 4 })
    assert.deepEqual(pricing.services, { m: { inputUsdPerMillion: 5, outputUsdPerMillion: 6 } })
  } finally {
    h.cleanup()
  }
})

test('invalid or missing config keeps current prices and warns once', async () => {
  const h = setup({
    a: { plugin: 'openai', defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: {} },
    b: { plugin: 'openai', defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: {} },
  }, { targets: ['a', 'b'] })
  try {
    await h.handle.reload()
    // a is valid, b is invalid: nothing may be applied (atomic).
    writeFileSync(h.configPath, sellerConfig({
      a: { plugin: 'openai', defaults: { inputUsdPerMillion: 9, outputUsdPerMillion: 9 }, services: {} },
      b: { plugin: 'openai', defaults: { inputUsdPerMillion: -1, outputUsdPerMillion: 9 }, services: {} },
    }))
    await h.handle.reload()
    await h.handle.reload()
    assert.equal(h.applied(), 0)
    assert.equal(h.targets[0]!.provider.pricing.defaults.inputUsdPerMillion, 1)
    assert.equal(h.warnings.length, 1)
    writeFileSync(h.configPath, '{ not json')
    await h.handle.reload()
    rmSync(h.configPath)
    await h.handle.reload()
    await h.handle.reload()
    assert.equal(h.warnings.length, 3)
    assert.equal(h.targets[1]!.provider.pricing.defaults.inputUsdPerMillion, 1)
  } finally {
    h.cleanup()
  }
})

test('CLI pricing overrides keep winning over reloaded config', async () => {
  const h = setup({ a: { plugin: 'openai', defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: {} } }, { input: 42, force: true })
  try {
    writeFileSync(h.configPath, sellerConfig({ a: { plugin: 'openai', defaults: { inputUsdPerMillion: 7, outputUsdPerMillion: 8 }, services: {} } }))
    await h.handle.reload()
    assert.deepEqual(h.targets[0]!.provider.pricing.defaults, { inputUsdPerMillion: 42, outputUsdPerMillion: 8 })
  } finally {
    h.cleanup()
  }
})

test('plugin env pricing keeps winning without a CLI override (startup precedence)', async () => {
  const h = setup({ a: { plugin: 'openai', defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: {} } })
  try {
    h.targets[0]!.basePluginConfig = { ANTSEED_INPUT_USD_PER_MILLION: '3' }
    writeFileSync(h.configPath, sellerConfig({ a: { plugin: 'openai', defaults: { inputUsdPerMillion: 7, outputUsdPerMillion: 8 }, services: {} } }))
    await h.handle.reload()
    assert.deepEqual(h.targets[0]!.provider.pricing.defaults, { inputUsdPerMillion: 3, outputUsdPerMillion: 8 })
  } finally {
    h.cleanup()
  }
})

test('stop() closes the watcher and refuses further reloads', async () => {
  const h = setup({ a: { plugin: 'openai', defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: {} } })
  try {
    h.handle.stop()
    writeFileSync(h.configPath, sellerConfig({ a: { plugin: 'openai', defaults: { inputUsdPerMillion: 7, outputUsdPerMillion: 7 }, services: {} } }))
    await h.handle.reload()
    await wait(100)
    assert.equal(h.applied(), 0)
    assert.equal(h.targets[0]!.provider.pricing.defaults.inputUsdPerMillion, 1)
  } finally {
    h.cleanup()
  }
})
