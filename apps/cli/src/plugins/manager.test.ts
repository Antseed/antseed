import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizePluginInstallError, npmInvocation } from './manager.js'

test('normalizePluginInstallError explains when npm is unavailable', () => {
  const error = Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' })
  const normalized = normalizePluginInstallError('@antseed/provider-openai', error)

  assert.match(normalized.message, /npm was not found/)
  assert.match(normalized.message, /Install Node\.js 20 or newer/)
  assert.match(normalized.message, /@antseed\/provider-openai/)
})

test('normalizePluginInstallError preserves other install failures', () => {
  const error = new Error('registry unavailable')
  assert.equal(normalizePluginInstallError('@antseed/provider-openai', error), error)
})

test('on Windows npm runs as npm-cli.js beside this Node, or through the shell without one', () => {
  const node = 'C:\\Program Files\\nodejs\\node.exe'
  const cli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
  assert.deepEqual(npmInvocation('win32', node, (file) => file === cli), { file: node, leadingArgs: [cli], shell: false })
  assert.deepEqual(npmInvocation('win32', node, () => false), { file: 'npm', leadingArgs: [], shell: true })
  assert.deepEqual(npmInvocation('darwin', '/usr/local/bin/node', () => true), { file: 'npm', leadingArgs: [], shell: false })
})
