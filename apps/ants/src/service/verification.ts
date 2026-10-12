import { ZeroAddress } from 'ethers';
import { validateSellerProofArtifact, sellerProofId, type SellerProofSubmissionStep } from '@antseed/node/payments';
import type { AntsContext } from './context.js';
import type { VerificationView, ProofStatusView } from '../api-types.js';
import { toJson } from './json.js';
import { silentReporter, type StepReporter } from './steps.js';

async function safe<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try { return await read(); } catch { return fallback; }
}

function sameAddress(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export async function verification(ctx: AntsContext, seller?: string): Promise<VerificationView> {
  const wash = ctx.washRegistry();
  const policies = ctx.pointsPolicyRegistry();
  const accounting = ctx.usageAccounting();
  const target = seller ?? ctx.address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(target)) throw new Error('Seller must be an address.');
  const [registry, status, policyList, pointsPolicy] = await Promise.all([
    wash ? safe<VerificationView['registry']>(async () => ({ address: wash.contractAddress, ...(await wash.registryConfig()) }), null) : Promise.resolve(null),
    wash ? safe<VerificationView['seller']>(async () => {
      const result = await wash.sellerStatus(target);
      return { seller: result.seller, provenWashVolume: result.provenWashVolume.toString(), totalSellerVolume: result.totalSellerVolume.toString(), provenWashShareBps: result.provenWashShareBps, evidenceDigest: result.evidenceDigest, isProvenWashTrader: result.isProvenWashTrader };
    }, null) : Promise.resolve(null),
    policies ? safe(() => policies.policies(), []) : Promise.resolve([]),
    accounting ? safe<string | null>(() => accounting.pointsPolicy(), null) : Promise.resolve(null),
  ]);
  const described = await Promise.all(policyList.map(async (address) => ({ address, washTradingRegistry: policies ? await policies.washTradingRegistryOf(address) : null })));
  const enforced = !!pointsPolicy && sameAddress(pointsPolicy, policies?.contractAddress) && described.some((policy) => wash && sameAddress(policy.washTradingRegistry, wash.contractAddress));
  return toJson({ registry, seller: status, policies: described, pointsPolicy: pointsPolicy && pointsPolicy !== ZeroAddress ? pointsPolicy : null, enforced });
}

export async function proofStatus(ctx: AntsContext, proofId: string): Promise<ProofStatusView> {
  const wash = ctx.washRegistry();
  if (!wash) throw new Error('Wash-trading registry is not configured for this chain.');
  if (!/^0x[0-9a-fA-F]{64}$/.test(proofId)) throw new Error('Proof ID must be a bytes32 hash.');
  return toJson(await wash.proofStatus(proofId));
}

export interface SubmitProofResult { proofId: string; seller: string; finalized: boolean; transactions: string[]; }

export async function submitProof(ctx: AntsContext, artifact: unknown, report: StepReporter = silentReporter): Promise<SubmitProofResult> {
  const wash = ctx.washRegistry();
  if (!wash) throw new Error('Wash-trading registry is not configured for this chain.');
  const signer = ctx.requireSigner();
  const validated = validateSellerProofArtifact(artifact);
  const config = await wash.registryConfig();
  if (validated.chainId !== undefined && Number(validated.chainId) !== ctx.chain.evmChainId) {
    throw new Error(`Artifact is for chain ${validated.chainId}; this registry is on chain ${ctx.chain.evmChainId}.`);
  }
  const proofId = sellerProofId(validated.publicValues);
  await report(`Submitting seller proof ${proofId} for ${validated.seller} (${validated.blockAuthenticationChunkCount} block-authentication chunk(s), period ${config.periodStartBlock}–${config.periodEndBlock})`);
  const transactions: string[] = [];
  const result = await wash.submitSellerProof(signer, validated, async (step: SellerProofSubmissionStep) => {
    if (step.hash) transactions.push(step.hash);
    if (step.kind === 'stage') await report(step.skipped ? 'Proof already staged' : 'Proof staged (SP1 verification passed)', step.hash);
    else if (step.kind === 'authenticate') await report(`${step.skipped ? 'Already authenticated' : 'Authenticated'} block chunk ${step.chunkIndex + 1}/${step.chunkCount}`, step.hash);
    else await report(step.skipped ? 'Proof was already finalized' : 'Proof finalized', step.hash);
  });
  return { proofId: result.proofId, seller: validated.seller, finalized: result.finalized, transactions };
}
