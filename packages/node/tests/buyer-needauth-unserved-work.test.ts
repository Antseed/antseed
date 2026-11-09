import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { BuyerPaymentManager } from '../src/payments/buyer-payment-manager.js';
import { ChannelStore } from '../src/payments/channel-store.js';
import type { PaymentMux } from '../src/p2p/payment-mux.js';
import type { Identity } from '../src/p2p/identity.js';
import { bytesToHex } from '../src/utils/hex.js';
import { toPeerId } from '../src/types/peer.js';
import type { NeedAuthPayload, SpendingAuthPayload } from '@antseed/protocol/messages';

/** maxPerRequestUsdc: the most the buyer signs beyond cost it has verified ($0.50). */
const WINDOW = 500_000n;
/** maxReserveAmountUsdc: one reserve step ($1.00). */
const RESERVE = 1_000_000n;
/** The buyer's whole deposit ($10.00). */
const DEPOSIT = 10_000_000n;
/** $1 per million tokens: N claimed input tokens price to exactly N base units. */
const PRICING = { inputUsdPerMillion: 1, outputUsdPerMillion: 1 };

/**
 * A seller with an open channel sends NeedAuth frames and collects whatever the
 * buyer signs. The buyer sends it no request and receives no response.
 */
describe('BuyerPaymentManager: NeedAuth from a seller that served nothing', () => {
  let tempDir: string;
  let store: ChannelStore;
  let manager: BuyerPaymentManager;
  let sent: SpendingAuthPayload[];
  let mux: PaymentMux;
  let sellerPeerId: string;
  let channelId: string;
  /** What the deposits contract holds for the buyer, and what the channel has locked. */
  let chain: { available: bigint; locked: bigint };
  let topUps: number;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'buyer-needauth-unserved-'));
    store = new ChannelStore(tempDir);
    const privateKey = randomBytes(32);
    const wallet = new Wallet('0x' + bytesToHex(privateKey));
    const identity: Identity = { peerId: toPeerId(wallet.address.slice(2).toLowerCase()), privateKey, wallet };
    manager = new BuyerPaymentManager(identity, {
      rpcUrl: 'http://127.0.0.1:8545',
      depositsContractAddress: '0x' + 'dd'.repeat(20),
      channelsContractAddress: '0x' + 'cc'.repeat(20),
      usdcAddress: '0x' + 'ee'.repeat(20),
      identityRegistryAddress: '0x' + 'ff'.repeat(20),
      chainId: 31337,
      defaultAuthDurationSecs: 3600,
      maxPerRequestUsdc: WINDOW,
      maxReserveAmountUsdc: RESERVE,
      dataDir: tempDir,
    }, store);
    sent = [];
    mux = { sendSpendingAuth: (payload: SpendingAuthPayload) => { sent.push(payload); } } as unknown as PaymentMux;
    chain = { available: DEPOSIT, locked: 0n };
    topUps = 0;
    vi.spyOn(manager, 'getBalance').mockImplementation(async () => ({ available: chain.available, reserved: chain.locked }));
    manager.setChannelDepositReader(async () => chain.locked);

    sellerPeerId = Buffer.from('seller-serves-nothing').toString('hex').padEnd(40, '0').slice(0, 40);
    channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, RESERVE, PRICING);
    // The seller's reserve() lands and it acknowledges the channel.
    chain = { available: DEPOSIT - RESERVE, locked: RESERVE };
    await manager.handleAuthAck(sellerPeerId, { channelId });
    sent.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const signed = (): bigint => manager.getCumulativeAmount(sellerPeerId);

  /**
   * The seller sends one NeedAuth (by default asking for the whole reserve),
   * then submits to the chain any reserve top-up the buyer signs in reply.
   */
  async function sellerSends(frame: Partial<NeedAuthPayload> = {}): Promise<void> {
    const before = sent.length;
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requiredCumulativeAmount: manager.getReserveCeiling(sellerPeerId).toString(),
      currentAcceptedCumulative: '0',
      deposit: chain.locked.toString(),
      ...frame,
    }, mux);
    for (const auth of sent.slice(before)) {
      if (auth.reserveMaxAmount === undefined) continue;
      const newMax = BigInt(auth.reserveMaxAmount);
      chain = { available: chain.available - (newMax - chain.locked), locked: newMax };
      topUps += 1;
    }
  }

  it('does not sign for cost claims that name requests the buyer never sent', async () => {
    for (let frame = 0; frame < 40; frame += 1) {
      const claim = manager.getReserveCeiling(sellerPeerId) - signed();
      if (claim <= 0n) break;
      // The token count is the seller's own number, so it always prices to the claimed cost.
      await sellerSends({
        requestId: `never-sent-${frame}`,
        lastRequestCost: claim.toString(),
        inputTokens: claim.toString(),
        outputTokens: '0',
      });
    }

    expect(signed(), 'signed for a seller that served nothing').toBeLessThanOrEqual(WINDOW);
    expect(topUps, 'reserve top-ups signed for a seller that served nothing').toBe(0);
  });

  it('does not let frames without a cost claim raise the signed amount past the overdraft window', async () => {
    for (let frame = 0; frame < 60; frame += 1) {
      const before = signed();
      const topUpsBefore = topUps;
      await sellerSends();
      if (signed() === before && topUps === topUpsBefore) break;
    }

    expect(signed(), 'signed for a seller that served nothing').toBeLessThanOrEqual(WINDOW);
    expect(topUps, 'reserve top-ups signed for a seller that served nothing').toBe(0);
  });

  it('signs a cost claim for a request the buyer sent, and refuses a second claim for the same request', async () => {
    manager.trackRequestService('sent-once', 'some-model');
    const claim = { requestId: 'sent-once', lastRequestCost: '100000', inputTokens: '100000', outputTokens: '0' };

    await sellerSends({ ...claim, requiredCumulativeAmount: '100000' });
    expect(signed()).toBe(100_000n);

    await sellerSends({ ...claim, requiredCumulativeAmount: '200000' });
    expect(signed(), 'signed twice for one request').toBe(100_000n);
  });
});
