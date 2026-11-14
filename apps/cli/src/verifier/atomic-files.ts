import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, rename, rm, stat, unlink } from 'node:fs/promises'
import { readFileSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { canonicalJsonStringify } from '@antseed/fingerprints'

export async function writeJsonAtomic(path: string, value: unknown, canonical = false): Promise<void> {
  const text = canonical ? canonicalJsonStringify(value) : JSON.stringify(value, null, 2)
  await writeTextAtomic(path, text)
}

export async function readJsonIfExists<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function writeTextAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeExclusive(temporary, text)
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

const UNREADABLE_LOCK_STALE_MS = 60_000

export interface FileLock {
  release(): Promise<void>
  /** `release` for a process's `exit` handler, which cannot wait. */
  releaseSync(): void
}

/** A lock another live process holds. Its message says what holds it (`heldMessage`), or that a verifier run does. */
export class LockHeldError extends Error {
  constructor(readonly path: string, heldMessage: string | null) {
    super(`${heldMessage ?? 'verifier run already active'} (lock ${path})`)
    this.name = 'LockHeldError'
  }
}

/**
 * Takes the lock at `path` without waiting; a dead owner's lock is taken over. `heldMessage` is what
 * another process trying the lock is told while this one holds it.
 */
export async function acquirePidFileLock(path: string, options: { heldMessage?: string } = {}): Promise<FileLock> {
  await mkdir(dirname(path), { recursive: true })
  const token = randomUUID()
  const contents = JSON.stringify({
    pid: process.pid, token, createdAt: new Date().toISOString(),
    ...(options.heldMessage ? { heldMessage: options.heldMessage } : {}),
  })
  const temporary = `${path}.tmp-${process.pid}-${token}`
  await writeExclusive(temporary, contents)
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await link(temporary, path)
        return {
          async release() {
            try {
              const current = JSON.parse(await readFile(path, 'utf8')) as { token?: unknown }
              if (current.token === token) await unlink(path)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            }
          },
          releaseSync() {
            try {
              const current = JSON.parse(readFileSync(path, 'utf8')) as { token?: unknown }
              if (current.token === token) unlinkSync(path)
            } catch {
              // Gone already, or unreadable: a lock whose process has exited is stale for the next one anyway.
            }
          },
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const stale = await readStaleLock(path)
        if (stale === null) throw new LockHeldError(path, await readHeldMessage(path))
        await removeStaleLock(path, stale)
      }
    }
    throw new Error(`could not acquire verifier lock ${path}`)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function writeExclusive(path: string, text: string): Promise<void> {
  const handle = await open(path, 'wx')
  try {
    await handle.writeFile(text)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Returns the lock's contents when its owner process is gone, or null when the lock is held.
 * Locks are linked into place fully written, so an unreadable lock is treated as held,
 * unless it is older than a minute (left behind by a crashed older build).
 */
async function readStaleLock(path: string): Promise<string | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
  let pid: unknown
  try {
    pid = (JSON.parse(text) as { pid?: unknown }).pid
  } catch {
    return (await isOlderThan(path, UNREADABLE_LOCK_STALE_MS)) ? text : null
  }
  if (!Number.isInteger(pid) || Number(pid) <= 0) return null
  try {
    process.kill(Number(pid), 0)
    return null
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? text : null
  }
}

async function readHeldMessage(path: string): Promise<string | null> {
  try {
    const message = (JSON.parse(await readFile(path, 'utf8')) as { heldMessage?: unknown }).heldMessage
    return typeof message === 'string' && message.length > 0 ? message : null
  } catch {
    return null
  }
}

async function isOlderThan(path: string, ageMs: number): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs > ageMs
  } catch {
    return false
  }
}

/** Removes the lock only if it still holds the stale contents, so a fresh owner's lock survives. */
async function removeStaleLock(path: string, staleText: string): Promise<void> {
  const aside = `${path}.stale-${process.pid}-${randomUUID()}`
  try {
    await rename(path, aside)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  try {
    if ((await readFile(aside, 'utf8')) !== staleText) {
      await link(aside, path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
    }
  } finally {
    await rm(aside, { force: true })
  }
}
