/**
 * Public entry point of @antseed/node/worker-e2e: buyer-to-worker encryption
 * for colony pools (worker-crypto.ts), Apple device attestation, and the
 * buyer's client. Spec: docs/protocol/colony-pool.md.
 */
export * from './worker-crypto.js';
export {
  APPLE_ENTERPRISE_ATTESTATION_ROOT_CA,
  deviceAttestationNonce,
  isDeviceAttestation,
  verifyDeviceAttestation,
  type DeviceAttestation,
  type DeviceAttestationReport,
} from './apple-attestation.js';
export { NodeWorkerE2EClient, sellerPayeeAddress } from './client.js';
