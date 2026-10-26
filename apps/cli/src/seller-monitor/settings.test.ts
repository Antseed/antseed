import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readSellerAlertSettings, readSellerSettings, resolveSellerConfigPath, updateSellerAlerts, updateSellerSettings } from './settings.js'

test('a read-only config (a ConfigMap mount) is shown read-only and refuses saves', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'seller-settings-'))
  const mount = join(dir, 'etc')
  mkdirSync(mount)
  const configPath = join(mount, 'config.json')
  writeFileSync(configPath, JSON.stringify({ seller: { alerts: { telegram: { chatId: '1' } } } }))
  chmodSync(configPath, 0o444)
  chmodSync(mount, 0o555)
  t.after(() => chmodSync(mount, 0o755))
  const view = await readSellerSettings(configPath)
  assert.equal(view.writable, false)
  assert.match(view.readOnlyReason!, /read-only/)
  await assert.rejects(updateSellerSettings(configPath, { maxConcurrentBuyers: 5 }), { code: 'config_read_only' })
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
  let view = await readSellerSettings(configPath)
  const glm = () => view.services.find((entry) => entry.service === 'glm-5.3')!
  const qwen = () => view.services.find((entry) => entry.service === 'qwen-free')!
  assert.deepEqual([glm().paid, glm().freeTier, glm().ownFreeTier], [true, null, null], 'a paid model has no allowance of its own')
  assert.equal(qwen().paid, false)
  assert.deepEqual(qwen().freeTier?.base, { maxRequestsPerAddress: 200, maxRequestsPerIp: null, windowMs: 86_400_000 }, 'a free model gets the seller-wide program')
  assert.deepEqual(qwen().freeTier?.stakeTiers, view.defaultStakeTiers)
  assert.deepEqual(view.freeTier, { maxRequestsPerAddress: 200, maxRequestsPerIp: null, windowMs: null, stakersOnly: false, stakeTiers: null })

  const saved = await updateSellerSettings(configPath, {
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
  await assert.rejects(updateSellerSettings(configPath, { freeTier: { stakeTiers: [{ minPower: 100, multiplier: 5 }, { minPower: 50, multiplier: 10 }] } }), { code: 'invalid_request' })
  await assert.rejects(updateSellerSettings(configPath, { pricing: [{ provider: 'openai', service: 'qwen-free', freeTier: { windowMs: 3_600_000 } }] }), { code: 'invalid_request' })
  view = (await updateSellerSettings(configPath, { freeTier: { stakeTiers: null }, pricing: [{ provider: 'openai', service: 'glm-5.3', freeTier: null }] })).settings
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
  const view = await readSellerSettings(configPath)
  assert.deepEqual(view.services.map((entry) => [entry.provider, entry.service, entry.ownFreeTier?.maxRequestsPerAddress ?? null]), [['a', 'glm', 5], ['b', 'glm', 5], ['b', 'kimi', null]])
  // A field edit through either provider edits that one program, and every provider gets it, so the config stays valid.
  await updateSellerSettings(configPath, { pricing: [{ provider: 'a', service: 'glm', freeTier: { maxRequestsPerIp: 3 } }] })
  const saved = JSON.parse(readFileSync(configPath, 'utf-8')).seller
  assert.deepEqual([saved.providers.a.services.glm.freeTier, saved.providers.b.services.glm.freeTier], [{ maxRequestsPerAddress: 5, maxRequestsPerIp: 3 }, { maxRequestsPerAddress: 5, maxRequestsPerIp: 3 }])
  // Without a limit there is no seller-wide program: the tiers go with it.
  await updateSellerSettings(configPath, { freeTier: { maxRequestsPerAddress: null } })
  assert.equal(JSON.parse(readFileSync(configPath, 'utf-8')).seller.freeTier, undefined)
  // Stakers only (or tiers) without a seller-wide limit is refused, not silently dropped.
  await assert.rejects(updateSellerSettings(configPath, { freeTier: { stakersOnly: true } }), /requires maxRequestsPerAddress/)
  // The limits the config itself accepts are accepted here.
  await updateSellerSettings(configPath, { healthCheck: { failureThreshold: 500 }, gasCheck: { minBalanceEth: 25 }, maxConcurrentBuyers: 250_000 })
  await assert.rejects(updateSellerSettings(configPath, { healthCheck: { intervalMs: 30_000 } }), /intervalMs/)
})

test('a pricing patch naming an Object.prototype member is refused and touches nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seller-settings-'))
  const configPath = join(dir, 'config.json')
  writeFileSync(configPath, JSON.stringify({ seller: { providers: { openai: { plugin: 'openai', services: { 'glm-5.3': {} } } } } }))
  for (const entry of [{ provider: 'openai', service: '__proto__' }, { provider: '__proto__', service: 'glm-5.3' }, { provider: 'openai', service: 'constructor' }]) {
    await assert.rejects(updateSellerSettings(configPath, { pricing: [{ ...entry, inputUsdPerMillion: 9, outputUsdPerMillion: 9 }] }), { code: 'invalid_request' })
  }
  assert.equal(({} as Record<string, unknown>).pricing, undefined)
  assert.equal(JSON.parse(readFileSync(configPath, 'utf-8')).seller.providers.openai.services['glm-5.3'].pricing, undefined)
})
