import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizePluginInstallError, npmCommand, npmInvocation } from './manager.js'

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

test('on Windows npm runs as npm-cli.js on this Node, never through a shell', () => {
  const node = 'C:\\Program Files\\nodejs\\node.exe'
  const besideNode = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
  assert.deepEqual(npmInvocation('win32', node, (file) => file === besideNode, {}), { file: node, leadingArgs: [besideNode] })

  // Another Node (Electron's): the npm that npm.cmd on PATH belongs to.
  const electron = 'C:\\Program Files\\Antseed\\Antseed.exe'
  const onPath = 'D:\\tools\\node\\node_modules\\npm\\bin\\npm-cli.js'
  const files = new Set(['D:\\tools\\node\\npm.cmd', onPath])
  assert.deepEqual(npmInvocation('win32', electron, (file) => files.has(file), { Path: 'C:\\Windows;D:\\tools\\node' }), { file: electron, leadingArgs: [onPath] })

  // Or the user-wide npm.
  const appData = 'C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npm-cli.js'
  assert.deepEqual(npmInvocation('win32', electron, (file) => file === appData, { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }), { file: electron, leadingArgs: [appData] })

  // None found: setup stops with guidance instead of falling back to cmd.exe.
  assert.throws(() => npmInvocation('win32', electron, () => false, {}), (error: NodeJS.ErrnoException) => error.code === 'ENOENT' && /npm was not found/.test(error.message))
  assert.match(normalizePluginInstallError('x', (() => { try { npmInvocation('win32', electron, () => false, {}) } catch (e) { return e } })()).message, /Install Node\.js 20 or newer/)

  assert.deepEqual(npmInvocation('darwin', '/usr/local/bin/node', () => true), { file: 'npm', leadingArgs: [] })
})

test('a package spec reaches npm exactly as given', () => {
  const spec = 'https://example.com/%PATH%/pkg "quoted" & more.tgz'
  const npm = { file: 'C:\\node\\node.exe', leadingArgs: ['C:\\node\\node_modules\\npm\\bin\\npm-cli.js'] }
  assert.deepEqual(npmCommand(['install', '--ignore-scripts', spec], npm), {
    file: npm.file,
    args: [...npm.leadingArgs, 'install', '--ignore-scripts', spec],
  })
})
