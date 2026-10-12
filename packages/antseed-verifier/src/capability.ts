import type { ClaimResult } from './antseed-node-types.js'

/**
 * A Capability is one independent seller attestation. The SDK offers a menu of them.
 * A seller produces evidence for the caps its infra supports (collect), and a buyer
 * verifies each one (verify) into a single ClaimResult. Caps are generic — no provider
 * hostnames or schemas. Provider differences live only in config-driven collectors.
 */

/** Input to a capability's buyer-side check. */
export interface CapabilityVerifyInput {
  /** The buyer's fresh nonce for this attestation round. */
  nonce: Uint8Array
  /** The seller's peer id (EVM address, normalized by the caller). */
  peerId: string
  /** This capability's own evidence bytes, if the seller returned any. */
  evidence?: Uint8Array
  /**
   * The already-DCAP-verified TDX quote this cap consumes (a ParsedTdxQuote from
   * caps/tee-tdx). A TDX cap reads its own; a derived cap (measured-image) reads the
   * quote it targets. `unknown` keeps this core module free of any cap-specific type.
   */
  parsedQuote?: unknown
  /** Buyer policy for this capability (e.g. approved measurements). Data, never fetched. */
  policy?: unknown
  /**
   * The full per-cap evidence map returned this round. seller-bound digests it (minus its
   * own entry) to verify one seller signature covers the entire bundle.
   */
  evidenceBundle?: Record<string, Uint8Array>
}

/** Input to a capability's seller-side evidence collection. */
export interface CapabilityCollectInput {
  nonce: Uint8Array
  peerId: string
  /** Generic, provider-neutral config (source, url, field path, prior evidence, ...). */
  config: Record<string, string>
  /** Signs a 32-byte digest with the seller's identity key; absent when unavailable. */
  sign?: (msg: Uint8Array) => Promise<Uint8Array>
}

export interface Capability {
  id: string
  /** Most caps yield one ClaimResult; a granular cap (provider-claims) yields one per sub-claim. */
  verify(input: CapabilityVerifyInput): ClaimResult | ClaimResult[] | Promise<ClaimResult | ClaimResult[]>
  /** Present only for caps a seller can produce evidence for. A throw means "not offered". */
  collect?(input: CapabilityCollectInput): Promise<Uint8Array>
}

/** Registry — insertion order defines the menu order and the buyer's verify order. */
const registry = new Map<string, Capability>()

export function registerCapability(cap: Capability): void {
  registry.set(cap.id, cap)
}

export function getCapability(id: string): Capability | undefined {
  return registry.get(id)
}

export function listCapabilities(): Capability[] {
  return [...registry.values()]
}

export function capabilityIds(): string[] {
  return [...registry.keys()]
}
