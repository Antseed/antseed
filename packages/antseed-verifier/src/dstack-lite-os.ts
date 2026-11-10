/**
 * Local dstack OS measurement check. Recomputes MRTD and RTMR0-2 from the seller's GetQuote
 * vm_config and full event log, and returns the OS image hash. It does not decide whether that
 * hash is approved.
 *
 * The WASM package is not a dependency yet. loadVerifyTdxLiteOs returns null (unavailable).
 * Wire it by returning the package's verifyTdxLiteOs from loadVerifyTdxLiteOs.
 */

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
  acpiTablesVerified: boolean
  reason: string | null
}

export type VerifyTdxLiteOs = (input: TdxLiteOsInput) => TdxLiteOsResult

export const DSTACK_LITE_OS_UNAVAILABLE = 'dstack lite OS verifier is unavailable'

function unavailable(): TdxLiteOsResult {
  return { ok: false, osImageHash: null, acpiTablesVerified: false, reason: DSTACK_LITE_OS_UNAVAILABLE }
}

/**
 * The dstack lite OS verifier, or null when it is not packaged.
 * One-line wiring: `return verifyTdxLiteOs` after `import { verifyTdxLiteOs } from '<package>'`.
 */
export function loadVerifyTdxLiteOs(): VerifyTdxLiteOs | null {
  return null
}

let injected: VerifyTdxLiteOs | null | undefined

/** Tests inject a fake of the verifyTdxLiteOs contract. Pass undefined to restore the loader. */
export function injectVerifyTdxLiteOs(impl: VerifyTdxLiteOs | null | undefined): void {
  injected = impl
}

/** Sync; never throws. MRs are hex; eventLog and vmConfig are the GetQuote strings verbatim. */
export function verifyTdxLiteOs(input: TdxLiteOsInput): TdxLiteOsResult {
  const impl = injected !== undefined ? injected : loadVerifyTdxLiteOs()
  if (impl === null) return unavailable()
  try {
    return impl(input)
  } catch (err) {
    return { ok: false, osImageHash: null, acpiTablesVerified: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
