import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises'
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

export interface FileLock {
  release(): Promise<void>
}

export async function acquirePidFileLock(path: string): Promise<FileLock> {
  await mkdir(dirname(path), { recursive: true })
  const token = randomUUID()
  const contents = JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeExclusive(path, contents)
      return {
        async release() {
          try {
            const current = JSON.parse(await readFile(path, 'utf8')) as { token?: unknown }
            if (current.token === token) await unlink(path)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const stale = await isStaleLock(path)
      if (!stale) throw new Error(`verifier run already active (lock ${path})`)
      await rm(path, { force: true })
    }
  }
  throw new Error(`could not acquire verifier lock ${path}`)
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

async function isStaleLock(path: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown }
    if (!Number.isInteger(parsed.pid) || Number(parsed.pid) <= 0) return true
    try {
      process.kill(Number(parsed.pid), 0)
      return false
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH'
    }
  } catch {
    return true
  }
}
