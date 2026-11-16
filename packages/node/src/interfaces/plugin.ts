import type { Provider } from './seller-provider.js'
import type { Router } from './buyer-router.js'

export interface ConfigField {
  key: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'secret' | 'string[]'
  required?: boolean
  default?: unknown
  description?: string
}

/** @deprecated Use ConfigField instead */
export type PluginConfigKey = ConfigField

export interface AntseedPluginBase {
  name: string
  displayName: string
  version: string
  description: string
  configSchema?: ConfigField[]
  /** @deprecated Use configSchema instead */
  configKeys?: ConfigField[]
}

export interface AntseedProviderPlugin extends AntseedPluginBase {
  type: 'provider'
  createProvider(config: Record<string, string>): Provider | Promise<Provider>
}

export interface AntseedRouterPlugin extends AntseedPluginBase {
  type: 'router'
  createRouter(config: Record<string, string>): Router | Promise<Router>
}

export interface ClaimResult {
  /** Namespaced claim id, e.g. 'antseed-tee/dcap:hardware-genuine'. */
  claim: string
  ok: boolean
  detail?: string
}

export interface VerifyResult {
  /** Overall pass/fail. The buyer applies its own policy (optional vs required). */
  ok: boolean
  claims: ClaimResult[]
}

/** A request the verifier issues to the seller over the existing buyer<->seller comms. */
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
  /**
   * Buyer-local, never sent by the seller: hex session hash of the buyer's encrypted
   * connection to the seller (see ANTSEED_CHANNEL_BINDING_HEADER).
   */
  channelBinding?: string
}

export interface VerifyContext {
  peerId: string
  /** Verifier id selected by the buyer; must match the SDK name. */
  verifierId: string
  /** Seller prover path for this verifier. */
  attestPath: string
  fetchFromSeller(req: SellerRequest): Promise<SellerResponse>
  signal?: AbortSignal
}

export interface AntseedVerifierPlugin extends AntseedPluginBase {
  type: 'verifier'
  verify(ctx: VerifyContext): VerifyResult | Promise<VerifyResult>
}

export const ANTSEED_ATTEST_PATH = '/_antseed/attest'

/**
 * Header the seller node sets on attestation requests it hands to its prover: the hex session
 * hash of the connection the request arrived on (any buyer-sent value is replaced). A TEE
 * prover binds it into its quote so the buyer can check its own connection ends in the TEE.
 */
export const ANTSEED_CHANNEL_BINDING_HEADER = 'x-antseed-channel-binding'

export interface Prover extends AntseedPluginBase {
  type: 'prover'
  prove(req: SellerRequest): SellerResponse | Promise<SellerResponse>
}

export type AntseedPlugin = AntseedProviderPlugin | AntseedRouterPlugin | AntseedVerifierPlugin | Prover
