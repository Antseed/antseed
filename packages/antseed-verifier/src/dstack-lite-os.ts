/**
 * Local dstack OS measurement check. Recomputes MRTD and RTMR0-2 from the seller's GetQuote
 * vm_config and full event log, and returns the OS image hash. It does not decide whether that
 * hash is approved.
 */

import { verifyTdxLiteOs as dstackVerifyTdxLiteOs } from '@phala/dstack-verifier-wasm'

export interface TdxLiteOsInput {
  mrtd: string
  rtmr0: string
  rtmr1: string
  rtmr2: string
  eventLog: string
  vmConfig: string
}

export interface TdxLiteOsResult {
  ok: boolean
  osImageHash: string | null
  reason: string | null
}

export type VerifyTdxLiteOs = (input: TdxLiteOsInput) => TdxLiteOsResult

/** The packaged dstack lite OS verifier. */
export function loadVerifyTdxLiteOs(): VerifyTdxLiteOs {
  return dstackVerifyTdxLiteOs
}

let injected: VerifyTdxLiteOs | undefined

/** Tests inject a fake of the verifyTdxLiteOs contract. Pass undefined to restore the loader. */
export function injectVerifyTdxLiteOs(impl: VerifyTdxLiteOs | undefined): void {
  injected = impl
}

/** Sync; never throws. MRs are hex; eventLog and vmConfig are the GetQuote strings verbatim. */
export function verifyTdxLiteOs(input: TdxLiteOsInput): TdxLiteOsResult {
  const impl = injected ?? loadVerifyTdxLiteOs()
  try {
    return impl(input)
  } catch (err) {
    return { ok: false, osImageHash: null, reason: err instanceof Error ? err.message : String(err) }
  }
}
