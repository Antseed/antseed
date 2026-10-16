import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { VerificationStorage, type StoredResponseAuth } from './storage.js'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('VerificationStorage ResponseAuth preimages', () => {
  it('migrates and round-trips exact request and response preimages', () => {
    const directory = mkdtempSync(join(tmpdir(), 'antseed-verification-storage-'))
    directories.push(directory)
    const storage = new VerificationStorage(join(directory, 'verification.db'))
    const record: StoredResponseAuth = {
      version: 1,
      requestId: 'request-1',
      buyerPeerId: '11'.repeat(20),
      sellerPeerId: '22'.repeat(20),
      advertisedService: 'model-a',
      provider: 'test',
      statusCode: 200,
      requestHash: `0x${'33'.repeat(32)}`,
      responseHash: `0x${'44'.repeat(32)}`,
      responseStartedAt: 1,
      responseCompletedAt: 2,
      signature: `0x${'55'.repeat(65)}`,
      receivedAt: 3,
      verified: true,
      verificationError: null,
      requestPreimage: Uint8Array.from([1, 2, 3]),
      responsePreimage: Uint8Array.from([4, 5, 6]),
    }
    storage.insertResponseAuth(record)
    const stored = storage.getResponseAuth(record.requestId)
    storage.close()
    expect(stored).not.toBeNull()
    expect([...stored!.requestPreimage!]).toEqual([1, 2, 3])
    expect([...stored!.responsePreimage!]).toEqual([4, 5, 6])
  })
})
