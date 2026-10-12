/**
 * The AntSeed plugin contract this SDK implements, vendored so the published package is
 * self-contained (no external type dependency, no peer dependency to build). These interfaces
 * mirror the AntSeed runtime's plugin surface, which loads this SDK's default and `prover` exports
 * structurally. Keep them in sync if that contract changes.
 */

export interface AntseedPluginBase {
  name: string
  displayName: string
  version: string
  description: string
}

/** One capability's verdict. `claim` is a namespaced id, e.g. 'antseed-verifier:seller-bound'. */
export interface ClaimResult {
  claim: string
  ok: boolean
  detail?: string
}

/** Overall verify result; the buyer applies its own required-vs-optional policy. */
export interface VerifyResult {
  ok: boolean
  claims: ClaimResult[]
}

/** A request the verifier sends to the seller over the existing buyer↔seller comms. */
export interface SellerRequest {
  method: string
  path: string
  headers?: Record<string, string>
  body?: Uint8Array
}

export interface SellerResponse {
  statusCode: number
  headers: Record<string, string>
  body: Uint8Array
}

export interface VerifyContext {
  peerId: string
  /** Verifier id selected by the buyer; must match this SDK's name. */
  verifierId: string
  /** Seller prover path for this verifier. */
  attestPath: string
  fetchFromSeller(req: SellerRequest): Promise<SellerResponse>
  signal?: AbortSignal
}

/** Buyer half (the default export). */
export interface AntseedVerifierPlugin extends AntseedPluginBase {
  type: 'verifier'
  verify(ctx: VerifyContext): VerifyResult | Promise<VerifyResult>
}

/** Seller half (the `prover` export) — serves reserved attestation requests. */
export interface Prover extends AntseedPluginBase {
  type: 'prover'
  prove(req: SellerRequest): SellerResponse | Promise<SellerResponse>
}
