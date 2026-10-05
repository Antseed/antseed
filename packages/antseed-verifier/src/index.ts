import verifierPlugin from './verifier.js'
import proverPlugin from './prover.js'

/**
 * One package, two halves — both named `antseed-verifier`. The monorepo
 * plugin loader imports this module and picks the export matching the requested kind:
 *   - type:'verifier' -> the default export (buyer half)
 *   - type:'prover'   -> the `prover` export  (seller half; embedded, not a provider)
 */
export default verifierPlugin
export const prover = proverPlugin

// The AntSeed plugin contract this SDK implements (vendored; self-contained types).
export type {
  AntseedPluginBase,
  AntseedVerifierPlugin,
  Prover,
  VerifyContext,
  VerifyResult,
  ClaimResult,
  SellerRequest,
  SellerResponse,
} from './antseed-node-types.js'

// Self-hosted TDX quote minting — for provider tooling that adopts antseed-rd-v1.
// configfs-tsm (bare-metal or GCP TDX) and the dstack guest agent (Phala CVMs).
export { generateTdxQuote } from './collect/configfs.js'
export { generateDstackQuote } from './collect/dstack.js'

// Capability model — the menu, its registry, and helpers.
export type {
  Capability,
  CapabilityVerifyInput,
  CapabilityCollectInput,
} from './capability.js'
export {
  registerCapability,
  getCapability,
  listCapabilities,
  capabilityIds,
} from './capability.js'
export {
  nodeTeeCapability,
  providerTeeCapability,
  sellerBoundCapability,
  measuredImageCapability,
  gpuNvidiaCapability,
  providerClaimsCapability,
} from './caps/index.js'

// Provider-claims: the SDK-frozen claims menu (the per-version claim definitions buyers
// verify against) and the canonical provider report_data scheme (domain tag + the [0:32]
// commitment provider tooling computes when it binds a claims document into its TDX quote).
export {
  PROVIDER_CLAIMS_CAP_ID,
  PROVIDER_CLAIMS_MENU,
  PROVIDER_REPORT_DATA_DOMAIN,
  claimsConfigKey,
  claimsReportData,
} from './caps/provider-claims.js'
export type { ProviderClaimDefinition } from './caps/provider-claims.js'

// Buyer policy loaders (read from env): the measured-image allow-list, and the required-cap
// set that gates the overall verdict (default node-tee + seller-bound; overridable).
export { readMeasuredImagePolicy, readRequiredCaps } from './verifier.js'

// Report_data binding schemes — the frozen registry the buyer verifies provider quotes against.
// antseedRdV1 is the canonical compositional scheme (the node cap is its {peerId} instance);
// noncePubkeySha256V1 is the foreign Chutes construction, replicated only to verify their quotes.
export {
  antseedRdV1,
  noncePubkeySha256V1,
  aciKeysetV1,
  getReportDataScheme,
  verifyReportData,
  REPORT_DATA_SCHEMES,
} from './report-data.js'
export type { ReportDataScheme, BindingIngredients } from './report-data.js'

// In-process provider adapters — bridge a foreign provider's evidence API to the SDK's neutral
// shape, selected by ANTSEED_VERIFIER_PROVIDER_ADAPTER. The core stays provider-agnostic; each
// adapter is an isolated, lazily-loaded module (chutes, aci).
export { loadAdapter, adapterIds } from './adapters/index.js'
export type { ProviderAdapter, ProviderEvidence } from './adapters/index.js'
export type { ReportDataBinding } from './caps/tee-tdx.js'

// Buyer-side orchestration and the injectable DCAP seam (useful for tooling and tests).
export { runVerify } from './verifier.js'
export {
  makeTdxCap,
  defaultVerifyQuote,
  verifyTdxEvidence,
  isTcbAcceptable,
  NODE_TEE_CAP_ID,
  PROVIDER_TEE_CAP_ID,
} from './caps/tee-tdx.js'
export type { VerifyQuoteFn, RawTdxVerification, ParsedTdxQuote, TdMeasurements } from './caps/tee-tdx.js'
export type { ApprovedMeasurement, MeasuredImagePolicy } from './caps/measured-image.js'

// GPU-CC capability and its injectable buyer-side seam (NRAS or offline local).
export {
  makeGpuNvidiaCap,
  makeNrasGpuVerify,
  nrasGpuVerify,
  localGpuVerify,
  defaultGpuVerify,
} from './caps/gpu-nvidia.js'
export type { GpuVerifyFn, GpuVerification, NrasOptions } from './caps/gpu-nvidia.js'
export {
  NRAS_GPU_ATTEST_URL_DEFAULT,
  NRAS_JWKS_URL_DEFAULT,
  buildNrasRequest,
  verifyEar,
} from './nras.js'
export type { NvidiaGpuEvidence, NrasEvidenceItem, NrasRequest, NrasSubmitFn, EarVerification } from './nras.js'

// Shared constants and helpers.
export {
  VERIFIER_ID,
  ATTEST_PATH,
  claimId,
  computeReportData,
  bundleDigest,
  sellerBoundPreimage,
} from './shared.js'
