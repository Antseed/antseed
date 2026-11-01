import { keccak256, toUtf8Bytes } from 'ethers';

export interface VerifierClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
  /**
   * Block the verification contract was deployed at. Default lower bound for
   * event queries; without it, queries require an explicit `fromBlock`.
   */
  deploymentBlock?: number;
  /** Max blocks per `eth_getLogs` window (defaults to 10k). */
  logQueryChunkBlocks?: number;
}

/** Mirrors IAntseedKbfVerification.Verdict. */
export const VERIFIER_VERDICT = {
  NONE: 0,
  SAME: 1,
  DIFF: 2,
  UNDETERMINED: 3,
} as const;

export type VerifierVerdictName = Exclude<keyof typeof VERIFIER_VERDICT, 'NONE'>;
export type VerifierVerdict = (typeof VERIFIER_VERDICT)[keyof typeof VERIFIER_VERDICT];

export function serviceHash(service: string): string {
  return keccak256(toUtf8Bytes(service.trim().toLowerCase()));
}

/** Identifies the model a service was audited as. */
export function modelHash(model: string): string {
  return keccak256(toUtf8Bytes(model.trim().toLowerCase()));
}
