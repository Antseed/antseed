import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { readSellerAlertSettings, readSellerSettings, resetSellerConfigOverrides, resolveSellerConfigPath, updateSellerAlerts, updateSellerSettings } from './settings.js'
import { loadSellerConfig } from '../config/overrides.js'

test('a read-only config (a ConfigMap mount) saves settings as overrides in the data dir, and reset drops them', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'seller-settings-'))
  const mount = join(dir, 'etc')
  mkdirSync(mount)
  const configPath = join(mount, 'config.json')
  writeFileSync(configPath, JSON.stringify({ seller: { maxConcurrentBuyers: 10, alerts: { telegram: { chatId: '1' } } } }))
  chmodSync(configPath, 0o444)
  chmodSync(mount, 0o555)
  t.after(() => chmodSync(mount, 0o755))
  let view = await readSellerSettings(configPath, dir)
  assert.deepEqual([view.writable, view.savesTo, view.overridden], [true, 'overrides', []])
  view = (await updateSellerSettings(configPath, dir, { maxConcurrentBuyers: 5, displayName: 'Forge' })).settings
  assert.deepEqual([view.maxConcurrentBuyers, view.displayName], [5, 'Forge'])
  assert.deepEqual(view.overridden.sort(), ['identity.displayName', 'seller.maxConcurrentBuyers'])
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'config.overrides.json'), 'utf8')), { identity: { displayName: 'Forge' }, seller: { maxConcurrentBuyers: 5 } })
  // The seller starts from the config file with the overrides applied.
  const { config } = await loadSellerConfig(configPath, dir)
  assert.equal(config.seller.maxConcurrentBuyers, 5)
  // An edit back to the file's value drops that override.
  view = (await updateSellerSettings(configPath, dir, { maxConcurrentBuyers: 10 })).settings
  assert.deepEqual(view.overridden, ['identity.displayName'])
  await resetSellerConfigOverrides(dir)
  view = await readSellerSettings(configPath, dir)
  assert.deepEqual([view.displayName === 'Forge', view.overridden], [false, []])
  assert.equal(existsSync(join(dir, 'config.overrides.json')), false)
  // Neither the config file nor the data dir writable: nothing can be saved.
  chmodSync(dir, 0o555)
  t.after(() => chmodSync(dir, 0o755))
  view = await readSellerSettings(configPath, dir)
  assert.equal(view.writable, false)
  assert.match(view.readOnlyReason!, /read-only/)
  await assert.rejects(updateSellerSettings(configPath, dir, { maxConcurrentBuyers: 5 }), { code: 'config_read_only' })
  chmodSync(dir, 0o755)
  // Alerts are saved in the data dir, layered over the read-only config.json, so they stay editable.
  assert.equal((await readSellerAlertSettings(configPath, dir, {})).writable, true)
  assert.deepEqual(await updateSellerAlerts(dir, { telegramBotToken: '123456789:AAFakeTokenForTestsOnly_abcdefghij', telegramChatId: '-5', idleMinutes: 5 }), { telegramBotToken: 'set', telegramChatId: 'set', idleMinutes: '5' })
  const alerts = await readSellerAlertSettings(configPath, dir, {})
  assert.deepEqual([alerts.telegram.chatId, alerts.telegram.active, alerts.idleMinutes], ['-5', true, 5])
  // null turns a config.json value off.
  await updateSellerAlerts(dir, { telegramChatId: null })
  assert.equal((await readSellerAlertSettings(configPath, dir, {})).telegram.chatId, null)
})

test('alerts refuse to save when the data dir is not writable', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'seller-settings-'))
  chmodSync(dir, 0o555)
  t.after(() => chmodSync(dir, 0o755))
  assert.equal((await readSellerAlertSettings(join(dir, 'config.json'), dir, {})).writable, false)
  await assert.rejects(updateSellerAlerts(dir, { idleMinutes: 5 }), { code: 'data_dir_read_only' })
})

test('an env token wins over the saved one and is reported as such', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seller-settings-'))
  const configPath = join(dir, 'config.json')
  writeFileSync(configPath, JSON.stringify({ seller: { alerts: { telegram: { chatId: '7', botTokenEnv: 'MY_TOKEN' } } } }))
  const alerts = await readSellerAlertSettings(configPath, dir, { MY_TOKEN: 'from-env' })
  assert.deepEqual(alerts.telegram, { chatId: '7', botTokenEnv: 'MY_TOKEN', tokenSet: true, tokenSource: 'env', active: true })
})

test('the seller config path: explicit env, the shared gateway file, or the seller data dir', () => {
  const gateway = { dataDir: '/gw', configPath: '/gw/config.json' }
  assert.equal(resolveSellerConfigPath('/gw', gateway, {}), '/gw/config.json')
  assert.equal(resolveSellerConfigPath('/seller', gateway, {}), '/seller/config.json')
  assert.equal(resolveSellerConfigPath('/seller', gateway, { ANTSEED_SELLER_CONFIG: '/etc/antseed/config.json' }), '/etc/antseed/config.json')
})

test('free tier: each model shows what buyers get, and its own program and the seller-wide tiers are edited in place', async () => {
  const configPath = join(mkdtempSync(join(tmpdir(), 'seller-settings-')), 'config.json')
  writeFileSync(configPath, JSON.stringify({
    seller: {
      freeTier: { maxRequestsPerAddress: 200 },
      providers: { openai: { plugin: 'openai', baseUrl: 'https://upstream.example', services: {
        'glm-5.3': { pricing: { inputUsdPerMillion: 0.7, outputUsdPerMillion: 2.2 } },
        'qwen-free': { pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
      } } },
    },
  }))
  let view = await readSellerSettings(configPath, dirname(configPath))
  const glm = () => view.services.find((entry) => entry.service === 'glm-5.3')!
  const qwen = () => view.services.find((entry) => entry.service === 'qwen-free')!
  assert.deepEqual([glm().paid, glm().freeTier, glm().ownFreeTier], [true, null, null], 'a paid model has no allowance of its own')
  assert.equal(qwen().paid, false)
  assert.deepEqual(qwen().freeTier?.base, { maxRequestsPerAddress: 200, maxRequestsPerIp: null, windowMs: 86_400_000 }, 'a free model gets the seller-wide program')
  assert.deepEqual(qwen().freeTier?.stakeTiers, view.defaultStakeTiers)
  assert.deepEqual(view.freeTier, { maxRequestsPerAddress: 200, maxRequestsPerIp: null, windowMs: null, stakersOnly: false, stakeTiers: null })

  const saved = await updateSellerSettings(configPath, dirname(configPath), {
    freeTier: { stakeTiers: [{ minPower: 52_000, multiplier: 2 }, { minPower: 260_000, multiplier: 'unlimited' }] },
    pricing: [{ provider: 'openai', service: 'glm-5.3', freeTier: { maxRequestsPerAddress: 50, stakersOnly: true } }],
  })
  assert.deepEqual(saved.fields, ['freeTier', 'pricing'])
  view = saved.settings
  assert.deepEqual(glm().ownFreeTier, { maxRequestsPerAddress: 50, maxRequestsPerIp: null, windowMs: null, stakersOnly: true, stakeTiers: null })
  assert.equal(glm().freeTier?.base.stakersOnly, true)
  assert.deepEqual(glm().inputUsdPerMillion, 0.7, 'a free-tier edit leaves the price alone')
  const raw = JSON.parse(readFileSync(configPath, 'utf8'))
  assert.deepEqual(raw.seller.providers.openai.services['glm-5.3'], { pricing: { inputUsdPerMillion: 0.7, outputUsdPerMillion: 2.2 }, freeTier: { maxRequestsPerAddress: 50, stakersOnly: true } })
  assert.deepEqual(raw.seller.freeTier.stakeTiers, [{ minPower: 52_000, multiplier: 2 }, { minPower: 260_000, multiplier: 'unlimited' }])

  // The node's own checks apply: tiers must rise, and a program needs a limit.
  await assert.rejects(updateSellerSettings(configPath, dirname(configPath), { freeTier: { stakeTiers: [{ minPower: 100, multiplier: 5 }, { minPower: 50, multiplier: 10 }] } }), { code: 'invalid_request' })
  await assert.rejects(updateSellerSettings(configPath, dirname(configPath), { pricing: [{ provider: 'openai', service: 'qwen-free', freeTier: { windowMs: 3_600_000 } }] }), { code: 'invalid_request' })
  view = (await updateSellerSettings(configPath, dirname(configPath), { freeTier: { stakeTiers: null }, pricing: [{ provider: 'openai', service: 'glm-5.3', freeTier: null }] })).settings
  assert.deepEqual([glm().ownFreeTier, view.freeTier.stakeTiers], [null, null])
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).seller.providers.openai.services['glm-5.3'].freeTier, undefined)
})

test('a model id has one free-tier program across providers, and clearing both seller-wide limits removes that program', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seller-settings-'))
  const configPath = join(dir, 'config.json')
  const service = (freeTier?: object) => ({ pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, ...(freeTier ? { freeTier } : {}) })
  writeFileSync(configPath, JSON.stringify({ seller: {
    freeTier: { maxRequestsPerAddress: 10, stakeTiers: [] },
    providers: {
      a: { plugin: 'openai', baseUrl: 'https://a.example', services: { glm: service() } },
      b: { plugin: 'openai', baseUrl: 'https://b.example', services: { glm: service({ maxRequestsPerAddress: 5 }), kimi: service() } },
    },
  } }))
  // Both providers show the one program the seller applies to the model id.
  const view = await readSellerSettings(configPath, dirname(configPath))
  assert.deepEqual(view.services.map((entry) => [entry.provider, entry.service, entry.ownFreeTier?.maxRequestsPerAddress ?? null]), [['a', 'glm', 5], ['b', 'glm', 5], ['b', 'kimi', null]])
  // A field edit through either provider edits that one program, and every provider gets it, so the config stays valid.
  await updateSellerSettings(configPath, dirname(configPath), { pricing: [{ provider: 'a', service: 'glm', freeTier: { maxRequestsPerIp: 3 } }] })
  const saved = JSON.parse(readFileSync(configPath, 'utf-8')).seller
  assert.deepEqual([saved.providers.a.services.glm.freeTier, saved.providers.b.services.glm.freeTier], [{ maxRequestsPerAddress: 5, maxRequestsPerIp: 3 }, { maxRequestsPerAddress: 5, maxRequestsPerIp: 3 }])
  // Without a limit there is no seller-wide program: the tiers go with it.
  await updateSellerSettings(configPath, dirname(configPath), { freeTier: { maxRequestsPerAddress: null } })
  assert.equal(JSON.parse(readFileSync(configPath, 'utf-8')).seller.freeTier, undefined)
  // Stakers only (or tiers) without a seller-wide limit is refused, not silently dropped.
  await assert.rejects(updateSellerSettings(configPath, dirname(configPath), { freeTier: { stakersOnly: true } }), /requires maxRequestsPerAddress/)
  // The limits the config itself accepts are accepted here.
  await updateSellerSettings(configPath, dirname(configPath), { healthCheck: { failureThreshold: 500 }, gasCheck: { minBalanceEth: 25 }, maxConcurrentBuyers: 250_000 })
  await assert.rejects(updateSellerSettings(configPath, dirname(configPath), { healthCheck: { intervalMs: 30_000 } }), /intervalMs/)
})

test('a pricing patch naming an Object.prototype member is refused and touches nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seller-settings-'))
  const configPath = join(dir, 'config.json')
  writeFileSync(configPath, JSON.stringify({ seller: { providers: { openai: { plugin: 'openai', services: { 'glm-5.3': {} } } } } }))
  for (const entry of [{ provider: 'openai', service: '__proto__' }, { provider: '__proto__', service: 'glm-5.3' }, { provider: 'openai', service: 'constructor' }]) {
    await assert.rejects(updateSellerSettings(configPath, dirname(configPath), { pricing: [{ ...entry, inputUsdPerMillion: 9, outputUsdPerMillion: 9 }] }), { code: 'invalid_request' })
  }
  assert.equal(({} as Record<string, unknown>).pricing, undefined)
  assert.equal(JSON.parse(readFileSync(configPath, 'utf-8')).seller.providers.openai.services['glm-5.3'].pricing, undefined)
})

test('a writable config is edited in place, unless overrides were saved: then edits go to them so none is shadowed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seller-settings-'))
  const configPath = join(dir, 'config.json')
  writeFileSync(configPath, JSON.stringify({ seller: { maxConcurrentBuyers: 10 } }))
  let view = (await updateSellerSettings(configPath, dir, { maxConcurrentBuyers: 7 })).settings
  assert.deepEqual([view.savesTo, view.maxConcurrentBuyers], ['config', 7])
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).seller.maxConcurrentBuyers, 7)
  writeFileSync(join(dir, 'config.overrides.json'), JSON.stringify({ seller: { maxConcurrentBuyers: 3 } }))
  view = await readSellerSettings(configPath, dir)
  assert.deepEqual([view.savesTo, view.maxConcurrentBuyers, view.overridden], ['overrides', 3, ['seller.maxConcurrentBuyers']])
  view = (await updateSellerSettings(configPath, dir, { maxConcurrentBuyers: 4 })).settings
  assert.equal(view.maxConcurrentBuyers, 4)
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).seller.maxConcurrentBuyers, 7, 'the file is left alone')
})

test('models: turned off and on, unit prices edited by what they bill, token models added and removed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seller-settings-'))
  const configPath = join(dir, 'config.json')
  writeFileSync(configPath, JSON.stringify({ seller: { providers: {
    openai: { plugin: 'openai', services: { 'glm-5.3': { pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } } },
    fal: { plugin: 'fal-video', services: { wan: { unitBillingModels: { 'fal-video': { version: 1, components: [
      { unit: 'video_seconds', priceUsd: 0.05, match: { resolution: '720p' } }, { unit: 'video_seconds', priceUsd: 0.1, match: { resolution: '1080p' } },
    ] } } } } },
  } } }))
  let view = (await updateSellerSettings(configPath, dir, { pricing: [
    { provider: 'openai', service: 'glm-5.3', enabled: false },
    { provider: 'fal', service: 'wan', unitPrices: [{ protocol: 'fal-video', unit: 'video_seconds', match: { resolution: '1080p' }, priceUsd: 0.08 }] },
  ] })).settings
  const glm = view.services.find((entry) => entry.service === 'glm-5.3')!
  const wan = view.services.find((entry) => entry.service === 'wan')!
  assert.equal(glm.enabled, false)
  assert.deepEqual(wan.unitComponents.map((component) => component.priceUsd), [0.05, 0.08])
  assert.deepEqual(view.providers.map((provider) => [provider.name, provider.unitBilled]), [['openai', false], ['fal', true]])
  await assert.rejects(updateSellerSettings(configPath, dir, { pricing: [{ provider: 'fal', service: 'wan', unitPrices: [{ protocol: 'fal-video', unit: 'video_seconds', match: { resolution: '4k' }, priceUsd: 1 }] }] }), /no video_seconds price/)
  view = (await updateSellerSettings(configPath, dir, { pricing: [{ provider: 'openai', service: 'glm-5.3', enabled: true }],
    addServices: [{ provider: 'openai', service: 'deepseek-v4.2', upstreamModel: 'deepseek-ai/DeepSeek-V4.2', categories: ['Chat', 'coding'], inputUsdPerMillion: 0.3, outputUsdPerMillion: 1.1 }] })).settings
  const file = JSON.parse(readFileSync(configPath, 'utf8')).seller.providers
  assert.equal(file.openai.services['glm-5.3'].enabled, undefined, 'on again: the flag is gone')
  assert.deepEqual(file.openai.services['deepseek-v4.2'], { upstreamModel: 'deepseek-ai/DeepSeek-V4.2', categories: ['chat', 'coding'], pricing: { inputUsdPerMillion: 0.3, outputUsdPerMillion: 1.1 } })
  await assert.rejects(updateSellerSettings(configPath, dir, { addServices: [{ provider: 'openai', service: 'deepseek-v4.2', inputUsdPerMillion: 1, outputUsdPerMillion: 1 }] }), /already offered/)
  await assert.rejects(updateSellerSettings(configPath, dir, { addServices: [{ provider: 'fal', service: 'veo', inputUsdPerMillion: 1, outputUsdPerMillion: 1 }] }), /bills per image or video/)
  await assert.rejects(updateSellerSettings(configPath, dir, { addServices: [{ provider: 'openai', service: '__proto__', inputUsdPerMillion: 1, outputUsdPerMillion: 1 }] }), /not a model id/)
  view = (await updateSellerSettings(configPath, dir, { removeServices: [{ provider: 'openai', service: 'deepseek-v4.2' }] })).settings
  // Every model off would leave nothing to start, and the dashboard with it.
  await assert.rejects(updateSellerSettings(configPath, dir, { pricing: [{ provider: 'openai', service: 'glm-5.3', enabled: false }, { provider: 'fal', service: 'wan', enabled: false }] }), /At least one model must stay offered/)
  // The last model of a provider is turned off, not removed: a provider with no models would stop the seller from starting.
  await assert.rejects(updateSellerSettings(configPath, dir, { removeServices: [{ provider: 'fal', service: 'wan' }] }), /last model of fal; turn it off/)
  assert.deepEqual(view.services.map((entry) => entry.service), ['glm-5.3', 'wan'])
})

test('a model stays on among the providers the seller starts, and models turned off are not offerings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seller-settings-'))
  const configPath = join(dir, 'config.json')
  writeFileSync(configPath, JSON.stringify({ seller: { providers: {
    a: { plugin: 'openai', services: { one: { pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } } },
    b: { plugin: 'openai', services: { two: { pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } } },
  } } }))
  // The seller runs with --provider a only (its state file lists what it started).
  writeFileSync(join(dir, 'daemon.state.json'), JSON.stringify({ updatedAt: Date.now(), providerPricing: { a: {} } }))
  await assert.rejects(updateSellerSettings(configPath, dir, { pricing: [{ provider: 'a', service: 'one', enabled: false }] }), /providers this seller starts \(a\)/)
  await updateSellerSettings(configPath, dir, { pricing: [{ provider: 'b', service: 'two', enabled: false }] })
})
