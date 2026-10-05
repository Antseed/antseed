import { EventLog, Interface, Log, Wallet, type Provider } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import {
  VERIFICATION_ABI,
  VERIFIER_VERDICT_DIFF,
  VerifierClient,
  serviceHash,
  type SubmitVerificationBundleInput,
} from '../src/payments/evm/verifier-client.js';

const VERIFICATION_ADDRESS = '0x' + '10'.repeat(20);
const AUDIT_ID = '0x' + '11'.repeat(32);
const SERVICE_HASH = '0x' + '44'.repeat(32);

describe('VerifierClient combined ABI', () => {
  it('normalizes service names before hashing', () => {
    expect(serviceHash('  GPT-5.6-SOL ')).toBe(serviceHash('gpt-5.6-sol'));
  });

  it('encodes one per-model verification bundle', async () => {
    const client = new VerifierClient({
      rpcUrl: 'http://127.0.0.1:1',
      contractAddress: VERIFICATION_ADDRESS,
    });
    const signer = Wallet.createRandom();
    const execWrite = vi.fn().mockResolvedValue('0xattest');
    (client as unknown as { _execWrite: typeof execWrite })._execWrite = execWrite;
    const input: SubmitVerificationBundleInput = {
      evidenceHash: '0x' + '99'.repeat(32),
      evidenceUri: 'ipfs://bafytest',
      results: [{
        agentId: 9,
        serviceHash: SERVICE_HASH,
        verdict: VERIFIER_VERDICT_DIFF,
      }],
    };

    await expect(client.submitVerificationBundle(signer, input)).resolves.toBe('0xattest');
    expect(execWrite).toHaveBeenCalledWith(
      signer,
      VERIFICATION_ABI,
      'submitVerificationBundle',
      input.evidenceHash,
      input.evidenceUri,
      [{ agentId: 9n, serviceHash: SERVICE_HASH, verdict: VERIFIER_VERDICT_DIFF }],
    );
  });

  it('keeps the verification ABI raw and consequence-free', () => {
    const iface = new Interface(VERIFICATION_ABI);
    expect(iface.getFunction('submitVerificationBundle')).not.toBeNull();
    expect(iface.getFunction('isVerificationSubmitted')).not.toBeNull();
    expect(iface.getFunction('verificationBundle')).not.toBeNull();
    expect(iface.getFunction('verificationResult')).not.toBeNull();
    expect(iface.getFunction('activeAgentDiffVerifierCount')).toBeNull();
    expect(iface.getFunction('activeServiceDiffVerifierCount')).toBeNull();
    expect(iface.getFunction('latestVerifierVerdict')).toBeNull();
    expect(iface.getFunction('clearVerifierVerdict')).toBeNull();
    expect(iface.getFunction('claimVerifierReward')).toBeNull();
    expect(iface.getFunction('pendingVerifierReward')).toBeNull();
    expect(iface.getFunction('epochCreditUsdMicros')).toBeNull();
    expect(iface.getFunction('emissionsGate')).toBeNull();
    expect(iface.getFunction('currentEpoch')).toBeNull();
    expect(iface.getFunction('agentPointsPenaltyBps')).toBeNull();
    expect(iface.getFunction('latestAttestation')).toBeNull();
    expect(iface.getFunction('servicePointsPenaltyBps')).toBeNull();
    expect(iface.getFunction('epochRewardClaimed')).toBeNull();
    expect(iface.getFunction('getAttestation')).toBeNull();
    expect(iface.getFunction('verificationStats')).toBeNull();
    expect(iface.getFunction('agentVerificationStats')).toBeNull();
    expect(iface.getFunction('verifierRegistry')).toBeNull();
    expect(iface.getFunction('gate')).toBeNull();
    expect(iface.getFunction('commitProbes')).toBeNull();
    expect(iface.getFunction('claimDelegateReward')).toBeNull();
  });

  it('exposes shared bundle and compact result event shapes', () => {
    const iface = new Interface(VERIFICATION_ABI);
    const bundle = iface.getEvent('VerificationBundleSubmitted');
    expect(bundle?.inputs.map((input) => input.name)).toEqual([
      'evidenceHash',
      'verifier',
      'resultCount',
      'evidenceUri',
    ]);
    const result = iface.getEvent('VerificationResultSubmitted');
    expect(result?.inputs.map((input) => input.name)).toEqual([
      'evidenceHash',
      'agentId',
      'serviceHash',
      'verifier',
      'verdict',
    ]);
  });

  it('parses the on-chain IPFS evidence URI from bundle events', () => {
    const client = new VerifierClient({
      rpcUrl: 'http://127.0.0.1:1',
      contractAddress: VERIFICATION_ADDRESS,
    });
    const iface = new Interface(VERIFICATION_ABI);
    const fragment = iface.getEvent('VerificationBundleSubmitted')!;
    const evidenceUri = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3r3eifqeedsvt2eubqtskghpm';
    const encoded = iface.encodeEventLog(fragment, [AUDIT_ID, VERIFICATION_ADDRESS, 1, evidenceUri]);
    const log = new Log({
      transactionHash: '0x' + '22'.repeat(32),
      blockHash: '0x' + '33'.repeat(32),
      blockNumber: 12,
      removed: false,
      address: VERIFICATION_ADDRESS,
      data: encoded.data,
      topics: encoded.topics,
      index: 3,
      transactionIndex: 1,
    }, null as unknown as Provider);
    const parsed = (client as unknown as {
      _bundleEvents(logs: readonly unknown[]): Array<{ evidenceUri: string }>;
    })._bundleEvents([new EventLog(log, iface, fragment)]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.evidenceUri).toBe(evidenceUri);
  });
});
