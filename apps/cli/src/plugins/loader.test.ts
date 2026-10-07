import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertPinnedPluginVersion, selectPluginExport } from './loader.js'

const TEE_PACKAGE = '@antseed/antseed-verifier'

function withPluginVersion(pkgName: string, version: string, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-loader-test-'))
  try {
    const pkgDir = join(dir, 'node_modules', ...pkgName.split('/'))
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: pkgName, version }), 'utf-8')
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('assertPinnedPluginVersion handles pinned and unpinned installs', () => {
  withPluginVersion(TEE_PACKAGE, '0.1.0', (dir) => {
    assert.doesNotThrow(() => assertPinnedPluginVersion(TEE_PACKAGE, dir))
  })
  withPluginVersion(TEE_PACKAGE, '0.1.1', (dir) => {
    assert.throws(() => assertPinnedPluginVersion(TEE_PACKAGE, dir), /version-locked to 0\.1\.0/)
  })
  withPluginVersion('@antseed/provider-openai', '999.0.0', (dir) => {
    assert.doesNotThrow(() => assertPinnedPluginVersion('@antseed/provider-openai', dir))
  })
})

test('assertPinnedPluginVersion reports a missing install distinctly from a wrong version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-loader-test-'))
  try {
    assert.throws(
      () => assertPinnedPluginVersion(TEE_PACKAGE, dir),
      /it is not installed/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('selectPluginExport dedupes default export and rejects ambiguous matches', () => {
  const plugin = { type: 'verifier', verify: () => {} }
  assert.equal(selectPluginExport({ default: plugin, verifierPlugin: plugin }, 'verifier', 'verify'), plugin)
  const a = { type: 'verifier', verify: () => {} }
  const b = { type: 'verifier', verify: () => {} }
  assert.throws(() => selectPluginExport({ default: a, other: b }, 'verifier', 'verify'), /multiple/)
  assert.equal(
    selectPluginExport({ default: { type: 'provider', createProvider: () => {} } }, 'verifier', 'verify'),
    undefined,
  )
})
