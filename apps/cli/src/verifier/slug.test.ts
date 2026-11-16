import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeServiceSlug } from './slug.js'

test('sanitizes disallowed characters to underscores', () => {
  assert.equal(safeServiceSlug('Qwen/Qwen3-32B'), 'Qwen_Qwen3-32B')
  assert.equal(safeServiceSlug('kimi-k2'), 'kimi-k2')
  assert.equal(safeServiceSlug('gpt-5.5'), 'gpt-5.5')
})

test('rejects dot-only names that would escape the directory', () => {
  assert.throws(() => safeServiceSlug('.'), /unsafe service name/)
  assert.throws(() => safeServiceSlug('..'), /unsafe service name/)
  assert.throws(() => safeServiceSlug('...'), /unsafe service name/)
  assert.throws(() => safeServiceSlug(''), /unsafe service name/)
})

test('path-traversal attempts collapse to safe underscored slugs', () => {
  // "../../x" → ".._.._x" — no separator survives, so it cannot traverse.
  const slug = safeServiceSlug('../../x')
  assert.ok(!slug.includes('/'))
  assert.ok(!/^\.+$/.test(slug))
})
