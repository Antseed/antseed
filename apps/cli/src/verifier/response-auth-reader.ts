import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { keccak256 } from 'ethers'
import {
  VerificationStorage,
  encodeResponseAuthSigningPayload,
  type StoredRequestCost,
  type StoredResponseAuth,
} from '@antseed/node'
import { normalized, sleep } from './utils.js'

export const DEFAULT_RESPONSE_AUTH_WAIT_TIMEOUT_MS = 35_000
export const RESPONSE_AUTH_POLL_INTERVAL_MS = 100

export interface ResponseAuthLookup {
  getResponseAuth(requestId: string): StoredResponseAuth | null
  getRequestCost(requestId: string): StoredRequestCost | null
}

export interface ResponseAuthEvidenceStatus {
  requestId: string | null
  status: 'verified' | 'missing' | 'invalid'
  responseAuth: StoredResponseAuth | null
  signedPreimages: SignedResponseAuthPreimages | null
  failureReason: string | null
}

export interface SignedResponseAuthPreimages {
  encoding: 'antseed-http-codec-v1'
  signatureEncoding: 'antseed-response-auth-signing-v1'
  requestBase64: string
  responseBase64: string
  responseAuthSigningBase64: string
  requestHash: string
  responseHash: string
}

export interface ResponseAuthReader {
  waitForVerified(input: {
    requestId: string
    sellerPeerId: string
    advertisedService: string
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<ResponseAuthEvidenceStatus>
  getRequestCost(requestId: string): StoredRequestCost | null
  close(): void
}

export async function openResponseAuthReader(input: {
  dataDir: string
  timeoutMs?: number
  sleepFn?: (delayMs: number) => Promise<void>
}): Promise<ResponseAuthReader> {
  const path = join(input.dataDir, 'verification.db')
  try {
    await access(path)
  } catch {
    throw new Error(`buyer verification database not found at ${path}; start antseed buyer first`)
  }
  const storage = new VerificationStorage(path)
  return createResponseAuthReader(storage, input.timeoutMs, input.sleepFn)
}

export function createResponseAuthReader(
  storage: ResponseAuthLookup & { close?: () => void },
  defaultTimeoutMs = DEFAULT_RESPONSE_AUTH_WAIT_TIMEOUT_MS,
  sleepFn: (delayMs: number) => Promise<void> = sleep,
): ResponseAuthReader {
  return {
    async waitForVerified(input) {
      const timeoutMs = input.timeoutMs ?? defaultTimeoutMs
      const deadline = Date.now() + timeoutMs
      for (;;) {
        if (input.signal?.aborted) {
          return {
            requestId: input.requestId,
            status: 'missing',
            responseAuth: null,
            signedPreimages: null,
            failureReason: 'seller audit deadline exceeded while waiting for ResponseAuth',
          }
        }
        const record = storage.getResponseAuth(input.requestId)
        if (record) return validateStoredResponseAuth(record, input)
        if (Date.now() >= deadline) {
          return {
            requestId: input.requestId,
            status: 'missing',
            responseAuth: null,
            signedPreimages: null,
            failureReason: `ResponseAuth was not persisted within ${timeoutMs}ms`,
          }
        }
        await sleepFn(Math.min(RESPONSE_AUTH_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())))
      }
    },
    getRequestCost(requestId) {
      return storage.getRequestCost(requestId)
    },
    close() {
      storage.close?.()
    },
  }
}

export function validateStoredResponseAuth(
  record: StoredResponseAuth,
  expected: { requestId: string; sellerPeerId: string; advertisedService: string },
): ResponseAuthEvidenceStatus {
  const signedPreimages = responseAuthPreimages(record)
  const mismatch = record.requestId !== expected.requestId
    ? `request ID mismatch (${record.requestId} != ${expected.requestId})`
    : normalized(record.sellerPeerId) !== normalized(expected.sellerPeerId)
      ? `seller peer ID mismatch (${record.sellerPeerId} != ${expected.sellerPeerId})`
      : normalized(record.advertisedService) !== normalized(expected.advertisedService)
        ? `advertised service mismatch (${record.advertisedService} != ${expected.advertisedService})`
        : record.verified !== true
          ? record.verificationError ?? 'ResponseAuth is not verified'
          : !signedPreimages
            ? 'verified ResponseAuth is missing exact signed request/response preimages; restart the rebuilt buyer proxy'
          : null
  return {
    requestId: expected.requestId,
    status: mismatch ? 'invalid' : 'verified',
    responseAuth: record,
    signedPreimages,
    failureReason: mismatch,
  }
}

function responseAuthPreimages(record: StoredResponseAuth): SignedResponseAuthPreimages | null {
  if (!record.requestPreimage || !record.responsePreimage) return null
  const requestHash = keccak256(record.requestPreimage)
  const responseHash = keccak256(record.responsePreimage)
  if (requestHash !== record.requestHash || responseHash !== record.responseHash) return null
  const { signature: _signature, receivedAt: _receivedAt, verified: _verified,
    verificationError: _verificationError, requestPreimage: _requestPreimage,
    responsePreimage: _responsePreimage, ...unsigned } = record
  return {
    encoding: 'antseed-http-codec-v1',
    signatureEncoding: 'antseed-response-auth-signing-v1',
    requestBase64: Buffer.from(record.requestPreimage).toString('base64'),
    responseBase64: Buffer.from(record.responsePreimage).toString('base64'),
    responseAuthSigningBase64: Buffer.from(encodeResponseAuthSigningPayload(unsigned)).toString('base64'),
    requestHash,
    responseHash,
  }
}
