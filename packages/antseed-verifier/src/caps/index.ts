import { registerCapability } from '../capability.js'
import { nodeTeeCapability, providerTeeCapability } from './tee-tdx.js'
import { sellerBoundCapability } from './seller-bound.js'
import { measuredImageCapability } from './measured-image.js'
import { gpuNvidiaCapability } from './gpu-nvidia.js'
import { providerClaimsCapability } from './provider-claims.js'

/**
 * Registration order defines both the advertised menu order and the seller's collect order.
 * Invariant: seller-bound signs over the whole bundle, so every evidence-producing cap (the
 * TDX caps, gpu-cc and provider-claims) must be registered before seller-bound. They are then
 * already collected when it builds the digest it signs. measured-image derives from the
 * provider quote (no own evidence), so its position does not matter.
 */
registerCapability(nodeTeeCapability)
registerCapability(providerTeeCapability)
registerCapability(gpuNvidiaCapability)
registerCapability(providerClaimsCapability)
registerCapability(sellerBoundCapability)
registerCapability(measuredImageCapability)

export { nodeTeeCapability, providerTeeCapability, sellerBoundCapability, measuredImageCapability, gpuNvidiaCapability, providerClaimsCapability }
