import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Wallet } from 'ethers';
import { DepositRelayer } from '../src/payments/deposit-relayer.js';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { makeUsdcDomain, buildReceiveAuthorization } from '../src/payments/evm/signatures.js';
import type { SweepRequestPayload } from '../src/types/protocol.js';
import type { SweepMux } from '../src/p2p/sweep-mux.js';
import type { PeerId } from '../src/types/peer.js';

const RELAY = '0x8A791620dd6260079BF849Dc5567aDC3F2FdC318';
const USDC = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const CHAIN_ID = 31337;
const FEE = 50_000n;

const buyer = new Wallet('0x' + 'a1'.repeat(32));
const sellerIdentity = identityFromPrivateKeyHex('b2'.repeat(32));

const PEER = 'peer-buyer-1' as PeerId;

function makeMux() {
  return { sendSweepReceipt: vi.fn() } as unknown as SweepMux & { sendSweepReceipt: ReturnType<typeof vi.fn> };
}

async function makeValidPayload(overrides?: Partial<SweepRequestPayload>): Promise<SweepRequestPayload> {
  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 60;
  const validBefore = now + 3600;
  const { message, signature } = await buildReceiveAuthorization(buyer, makeUsdcDomain(CHAIN_ID, USDC), {
    to: RELAY,
    value: 5_000_000n,
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
  });
  return {
    version: 1,
    evmChainId: CHAIN_ID,
    relayAddress: RELAY,
    from: buyer.address,
    amount: '5000000',
    validAfter,
    validBefore,
    nonce: message.nonce,
    sig3009: signature,
    ...overrides,
  };
}

function makeRelayer(config?: Partial<ConstructorParameters<typeof DepositRelayer>[1]>) {
  const relayer = new DepositRelayer(sellerIdentity, {
    rpcUrl: 'http://127.0.0.1:1',
    relayAddress: RELAY,
    usdcAddress: USDC,
    evmChainId: CHAIN_ID,
    ...config,
  });
  const estimateSpy = vi.spyOn(relayer.client, 'estimateSweepProfit').mockResolvedValue({
    gasEstimate: 200_000n,
    estGasCostUsdc: 5_000n,
    fee: FEE,
    profitUsdc: FEE - 5_000n,
    maxFeePerGasWei: 100_000_000n,
  });
  const sweepSpy = vi.spyOn(relayer.client, 'sweep').mockResolvedValue('0x' + '77'.repeat(32));
  return { relayer, estimateSpy, sweepSpy };
}

describe('DepositRelayer', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('verifies, simulates, submits, and reports receipts for a valid request', async () => {
    const { relayer, sweepSpy } = makeRelayer();
    const mux = makeMux();
    const payload = await makeValidPayload();

    const result = await relayer.handleSweepRequest(PEER, payload, mux);

    expect(result).toBe('submitted');
    expect(sweepSpy).toHaveBeenCalledTimes(1);
    const statuses = mux.sendSweepReceipt.mock.calls.map((c) => c[0].status);
    expect(statuses).toEqual(['submitted', 'confirmed']);
    expect(mux.sendSweepReceipt.mock.calls[1][0].txHash).toBe('0x' + '77'.repeat(32));
    expect(mux.sendSweepReceipt.mock.calls[1][0].authNonce).toBe(payload.nonce);
    // Speed-ups of the sweep stop at the gas price where it would stop paying for itself.
    expect(sweepSpy.mock.calls[0][2]).toEqual({ maxFeePerGasWei: 100_000_000n });
  });

  it('drops requests for a different relay address without submitting', async () => {
    const { relayer, sweepSpy } = makeRelayer();
    const mux = makeMux();
    const payload = await makeValidPayload({ relayAddress: '0x' + '99'.repeat(20) });

    expect(await relayer.handleSweepRequest(PEER, payload, mux)).toBe('dropped');
    expect(sweepSpy).not.toHaveBeenCalled();
    expect(mux.sendSweepReceipt).not.toHaveBeenCalled();
  });

  it('drops requests for a different chain', async () => {
    const { relayer, sweepSpy } = makeRelayer();
    const payload = await makeValidPayload({ evmChainId: 8453 });
    expect(await relayer.handleSweepRequest(PEER, payload, makeMux())).toBe('dropped');
    expect(sweepSpy).not.toHaveBeenCalled();
  });

  it('rejects tampered payloads (3009 signature mismatch)', async () => {
    const { relayer, sweepSpy } = makeRelayer();
    const mux = makeMux();
    const payload = await makeValidPayload();
    // Signed for 5 USDC; a tampered amount must fail signature recovery.
    payload.amount = '6000000';

    expect(await relayer.handleSweepRequest(PEER, payload, mux)).toBe('rejected');
    expect(sweepSpy).not.toHaveBeenCalled();
    expect(mux.sendSweepReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rejected', reason: 'invalid signature' }),
    );
  });

  it('rejects expired authorization windows', async () => {
    const { relayer } = makeRelayer();
    const mux = makeMux();
    const now = Math.floor(Date.now() / 1000);
    const payload = await makeValidPayload({ validBefore: now + 5 }); // inside safety margin

    expect(await relayer.handleSweepRequest(PEER, payload, mux)).toBe('rejected');
    expect(mux.sendSweepReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rejected', reason: expect.stringContaining('window') }),
    );
  });

  it('drops replayed nonces', async () => {
    const { relayer, sweepSpy } = makeRelayer();
    const payload = await makeValidPayload();

    expect(await relayer.handleSweepRequest(PEER, payload, makeMux())).toBe('submitted');
    expect(await relayer.handleSweepRequest(PEER, payload, makeMux())).toBe('dropped');
    expect(sweepSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects when profit is below the configured minimum', async () => {
    const { relayer, sweepSpy } = makeRelayer({ minProfitBaseUnits: FEE }); // requires zero gas cost
    const mux = makeMux();

    expect(await relayer.handleSweepRequest(PEER, await makeValidPayload(), mux)).toBe('rejected');
    expect(sweepSpy).not.toHaveBeenCalled();
    expect(mux.sendSweepReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rejected', reason: 'unprofitable for relayer' }),
    );
  });

  it('rejects unprofitable sweeps with the default zero minimum', async () => {
    const { relayer, estimateSpy, sweepSpy } = makeRelayer();
    estimateSpy.mockResolvedValue({
      gasEstimate: 200_000n,
      estGasCostUsdc: 80_000n,
      fee: FEE,
      profitUsdc: FEE - 80_000n, // negative
      maxFeePerGasWei: 0n,
    });

    expect(await relayer.handleSweepRequest(PEER, await makeValidPayload(), makeMux())).toBe('rejected');
    expect(sweepSpy).not.toHaveBeenCalled();
  });

  it('accepts unprofitable sweeps when minProfit is negative (local testing)', async () => {
    const { relayer, estimateSpy, sweepSpy } = makeRelayer({ minProfitBaseUnits: -100_000_000n });
    estimateSpy.mockResolvedValue({
      gasEstimate: 200_000n,
      estGasCostUsdc: 4_100_150n, // anvil-scale gas cost
      fee: FEE,
      profitUsdc: FEE - 4_100_150n,
      maxFeePerGasWei: 0n,
    });

    expect(await relayer.handleSweepRequest(PEER, await makeValidPayload(), makeMux())).toBe('submitted');
    expect(sweepSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects when simulation fails', async () => {
    const { relayer, estimateSpy, sweepSpy } = makeRelayer();
    estimateSpy.mockRejectedValue(new Error('execution reverted'));
    const mux = makeMux();

    expect(await relayer.handleSweepRequest(PEER, await makeValidPayload(), mux)).toBe('rejected');
    expect(sweepSpy).not.toHaveBeenCalled();
    expect(mux.sendSweepReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rejected', reason: 'simulation failed' }),
    );
  });

  it('allows a nonce to be retried after transient simulation failure', async () => {
    const { relayer, estimateSpy, sweepSpy } = makeRelayer();
    const payload = await makeValidPayload();

    estimateSpy.mockRejectedValueOnce(new Error('rpc timeout'));

    expect(await relayer.handleSweepRequest(PEER, payload, makeMux())).toBe('rejected');
    expect(await relayer.handleSweepRequest(PEER, payload, makeMux())).toBe('submitted');
    expect(sweepSpy).toHaveBeenCalledTimes(1);
  });

  it('allows a nonce to be retried when the sweep is temporarily unprofitable', async () => {
    const { relayer, estimateSpy, sweepSpy } = makeRelayer();
    const payload = await makeValidPayload();

    estimateSpy.mockResolvedValueOnce({
      gasEstimate: 200_000n,
      estGasCostUsdc: 80_000n,
      fee: FEE,
      profitUsdc: FEE - 80_000n,
      maxFeePerGasWei: 0n,
    });

    expect(await relayer.handleSweepRequest(PEER, payload, makeMux())).toBe('rejected');
    expect(await relayer.handleSweepRequest(PEER, payload, makeMux())).toBe('submitted');
    expect(sweepSpy).toHaveBeenCalledTimes(1);
  });

  it('reports rejected when the submission loses the race', async () => {
    const { relayer, sweepSpy } = makeRelayer();
    sweepSpy.mockRejectedValue(new Error('authorization is used or canceled'));
    const mux = makeMux();

    expect(await relayer.handleSweepRequest(PEER, await makeValidPayload(), mux)).toBe('rejected');
    const statuses = mux.sendSweepReceipt.mock.calls.map((c) => c[0].status);
    expect(statuses).toEqual(['submitted', 'rejected']);
  });

  it('rate-limits per peer', async () => {
    const { relayer, sweepSpy } = makeRelayer({ maxPerPeerPerMinute: 2 });

    expect(await relayer.handleSweepRequest(PEER, await makeValidPayload(), makeMux())).toBe('submitted');
    expect(await relayer.handleSweepRequest(PEER, await makeValidPayload(), makeMux())).toBe('submitted');
    expect(await relayer.handleSweepRequest(PEER, await makeValidPayload(), makeMux())).toBe('dropped');
    expect(sweepSpy).toHaveBeenCalledTimes(2);

    // A different peer is unaffected.
    expect(await relayer.handleSweepRequest('peer-buyer-2' as PeerId, await makeValidPayload(), makeMux())).toBe('submitted');
  });
});
