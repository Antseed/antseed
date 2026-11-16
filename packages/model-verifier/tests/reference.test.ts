import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadReference } from '../src/reference.js'
import { testReference } from './fixtures.js'

describe('loadReference', () => {
  it('loads and validates a reference file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'model-verifier-'))
    const path = join(dir, 'reference.json')
    const reference = testReference()
    await writeFile(path, JSON.stringify(reference))
    await expect(loadReference(path)).resolves.toMatchObject({ referenceId: reference.referenceId })
  })

  it('rejects a reference whose content no longer matches its id', async () => {
    const reference = testReference()
    reference.probes[0]!.consensus = 99
    const fetchImpl = (async () => new Response(JSON.stringify(reference))) as unknown as typeof fetch
    await expect(loadReference('https://refs.example.test/r.json', { fetchImpl })).rejects.toThrow()
  })
})
