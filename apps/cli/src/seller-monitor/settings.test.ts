import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
