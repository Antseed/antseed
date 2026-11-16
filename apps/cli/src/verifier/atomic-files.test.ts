import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  acquirePidFileLock,
  readJsonIfExists,
  writeJsonAtomic,
  writeTextAtomic,
} from './atomic-files.js'

test('atomic writers create parent directories and replace complete files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-atomic-'))
  const path = join(directory, 'nested', 'value.json')
  try {
    await writeTextAtomic(path, 'first')
    await writeJsonAtomic(path, { value: 'second' })
    assert.equal(await readFile(path, 'utf8'), '{\n  "value": "second"\n}')
    assert.deepEqual(await readJsonIfExists(path), { value: 'second' })
    assert.equal(await readJsonIfExists(join(directory, 'missing.json')), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('atomic writers remove temporary files after a failed rename', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-atomic-'))
  const path = join(directory, 'destination')
  try {
    await mkdir(path)
    await assert.rejects(writeTextAtomic(path, 'value'))
    assert.deepEqual(await readdir(directory), ['destination'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('PID locks reject live owners and recover stale owners', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-lock-'))
  const path = join(directory, 'run.lock')
  try {
    const lock = await acquirePidFileLock(path)
    await assert.rejects(acquirePidFileLock(path), /already active/)
    await lock.release()
    await writeFile(path, JSON.stringify({ pid: 2_147_483_647, token: 'stale' }))
    const recovered = await acquirePidFileLock(path)
    const current = JSON.parse(await readFile(path, 'utf8')) as { pid: number }
    assert.equal(current.pid, process.pid)
    await recovered.release()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('PID locks treat a fresh unreadable lock as held, not stale', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-lock-'))
  const path = join(directory, 'run.lock')
  try {
    await writeFile(path, '')
    await assert.rejects(acquirePidFileLock(path), /already active/)
    assert.equal(await readFile(path, 'utf8'), '', 'the other owner keeps its lock')
    const old = new Date(Date.now() - 120_000)
    await utimes(path, old, old)
    const recovered = await acquirePidFileLock(path)
    await recovered.release()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('PID locks never expose a partly written lock and leave no temporary files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-lock-'))
  const path = join(directory, 'run.lock')
  try {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => acquirePidFileLock(path)))
    const held = results.filter((result) => result.status === 'fulfilled')
    assert.equal(held.length, 1)
    const current = JSON.parse(await readFile(path, 'utf8')) as { pid: number }
    assert.equal(current.pid, process.pid)
    await (held[0] as PromiseFulfilledResult<{ release(): Promise<void> }>).value.release()
    assert.deepEqual(await readdir(directory), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
