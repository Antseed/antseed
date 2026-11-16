/**
 * TCB acceptance. UpToDate is always genuine hardware. SWHardeningNeeded flags guest-side
 * software mitigations only — not a hardware compromise — and is accepted by default (real
 * GCP TDX quotes often report it). Set ANTSEED_VERIFIER_STRICT_TCB=true to require UpToDate
 * exactly. Anything else (OutOfDate, Revoked, Unknown, ...) is rejected.
 */
export function isTcbAcceptable(status: string): boolean {
  if (status === 'UpToDate') return true
  if (status === 'SWHardeningNeeded') return process.env['ANTSEED_VERIFIER_STRICT_TCB'] !== 'true'
  return false
}
