import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Wallet } from 'ethers';
import type { KeyedRelayEvent, KeyedRelayProcess } from '@antseed/keyed-relay';
import { keyedRequestTailFields } from '@antseed/protocol/blind-relay';
import type { NeedAuthPayload, SpendingAuthPayload } from '@antseed/protocol/messages';
import { recordRelayedCost } from '../src/blind-relay-billing.js';
import type { KeyedRelayReveal } from '../src/keyed-relay-billing.js';
import { BuyerPaymentManager } from '../src/payments/buyer-payment-manager.js';
import { BuyerPaymentNegotiator } from '../src/payments/buyer-payment-negotiator.js';
import { ChannelStore } from '../src/payments/channel-store.js';
import { computeCostUsdc } from '../src/payments/pricing.js';
import { SellerBlindRelay, type BlindRelayCharge } from '../src/seller-blind-relay.js';
import type { KeyedRelayTarget, Provider } from '../src/interfaces/seller-provider.js';
import type { PaymentMux } from '../src/p2p/payment-mux.js';
import type { Identity } from '../src/p2p/identity.js';
import type { PeerInfo } from '../src/types/peer.js';
import { toPeerId } from '../src/types/peer.js';
import { bytesToHex } from '../src/utils/hex.js';

/**
 * One relayed answer, billed by the seller's own code (`SellerBlindRelay`) and
 * priced by the buyer's (`recordRelayedCost`, then the payment manager's
 * NeedAuth check): the buyer signs what the seller charges, request after
 * request, whatever the buyer's reveal shows of the usage.
 */

const PRICING = { inputUsdPerMillion: 2, outputUsdPerMillion: 8 };
/** The buyer's overdraft window: what it signs past the cost it verified itself. */
const WINDOW = 10_000n;
const RESERVE = 1_000_000n;
const SERVICE = 'open-model';
const MAX_TOKENS = 500;
const b64 = (text: string): string => Buffer.from(text).toString('base64');

const TARGET: KeyedRelayTarget = {
  host: 'api.example.com',
  port: 443,
  baseUrl: 'https://api.example.com/v1',
  path: '/v1/chat/completions',
  model: 'org/open-model',
  headers: [['Authorization', 'Bearer sk-seller-secret']],
  request: { maxTokensField: 'max_tokens', maxTokens: 1000 },
};

/** The request as the buyer writes it: its body, and what the buyer reveals of it for the seller's check. */
function request() {
  const fields = keyedRequestTailFields(TARGET.request, { model: TARGET.model, maxTokens: MAX_TOKENS, stream: true });
  const tail = `,${fields}}`;
  const body = `{"messages":[{"role":"user","content":"hidden"}]${tail}`;
  const headers = `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  const length = Buffer.byteLength(headers + body);
  return {
    body: new TextEncoder().encode(body),
    revealed: { length, ranges: [{ offset: 0, data: b64(headers) }, { offset: length - Buffer.byteLength(tail), data: b64(tail) }] },
  };
}

/** A streamed answer of about 4,000 bytes. `usageWithAnswer` puts the usage on the event with the answer's last words, as some upstreams do. */
function answer(usageWithAnswer: boolean) {
  const status = 'HTTP/1.1 200 OK';
  const usage = '"usage":{"prompt_tokens":12,"completion_tokens":1}';
  const words = ' giraffe'.repeat(480);
  const events = usageWithAnswer
    ? `data: {"model":"org/open-model","choices":[{"delta":{"content":"${words}"}}],${usage}}\n\ndata: [DONE]\n\n`
    : `data: {"model":"org/open-model","choices":[{"delta":{"content":"${words}"}}]}\n\ndata: {"model":"org/open-model","choices":[],${usage}}\n\ndata: [DONE]\n\n`;
  const raw = `${status}\r\nContent-Type: text/event-stream\r\n\r\n${events}`;
  const length = Buffer.byteLength(raw);
  // The buyer shows a tail only when it holds none of the answer: from the event with the usage to the end.
  const tailAt = raw.lastIndexOf('data: {"model"');
  const revealed: KeyedRelayReveal = {
    length,
    ranges: [{ offset: 0, data: b64(status) }, ...(usageWithAnswer ? [] : [{ offset: tailAt, data: b64(raw.slice(tailAt)) }])],
  };
  return { length, revealed, body: new TextEncoder().encode(events) };
}

describe('a relayed answer: what the seller charges and what the buyer signs', () => {
  let tempDir: string;
  let store: ChannelStore;
  let manager: BuyerPaymentManager;
  let negotiator: BuyerPaymentNegotiator;
  let sent: SpendingAuthPayload[];
  let mux: PaymentMux;
  let peer: PeerInfo;
  let channelId: string;
  let buyerPeerId: string;
  const sellerPeerId = 'ab'.repeat(20);

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'blind-relay-billing-'));
    store = new ChannelStore(tempDir);
    const privateKey = randomBytes(32);
    const wallet = new Wallet('0x' + bytesToHex(privateKey));
    const identity: Identity = { peerId: toPeerId(wallet.address.slice(2).toLowerCase()), privateKey, wallet };
    buyerPeerId = identity.peerId;
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
    vi.spyOn(manager, 'getBalance').mockImplementation(async () => ({ available: 0n, reserved: RESERVE }));
    manager.setChannelDepositReader(async () => RESERVE);
    negotiator = new BuyerPaymentNegotiator(identity, manager, null, null, null, {}, { emit: () => {} });
    sent = [];
    mux = { sendSpendingAuth: (payload: SpendingAuthPayload) => { sent.push(payload); } } as unknown as PaymentMux;
    peer = { peerId: sellerPeerId } as unknown as PeerInfo;
    channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, RESERVE, PRICING);
    await manager.handleAuthAck(sellerPeerId, { channelId });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** The seller's side of one request: its sidecar's events, as `SellerBlindRelay` bills them. */
  async function sellerBills(blind: SellerBlindRelay, sidecars: EventEmitter[], credentialId: string, requestId: string, relayed: ReturnType<typeof answer>): Promise<void> {
    (await blind.authorize(buyerPeerId, requestId, credentialId)).open();
    const sidecar = sidecars.at(-1)!;
    const emit = (event: KeyedRelayEvent): boolean => sidecar.emit('event', event);
    emit({ type: 'request', ...request().revealed });
    await new Promise((resolve) => setTimeout(resolve, 0));
    emit({ type: 'responseEnd', length: relayed.length, bytesUp: 4_000, bytesDown: relayed.length + 600 });
    emit({ type: 'revealed', ...relayed.revealed });
    sidecar.emit('exit', { code: 0, stderr: '' });
  }

  /** The buyer's side: it prices the answer before its reveal, and the seller's charge arrives as a NeedAuth. */
  async function buyerPays(requestId: string, relayed: ReturnType<typeof answer>, charge: BlindRelayCharge, spent: bigint): Promise<void> {
    manager.beginPaidRequest(sellerPeerId);
    recordRelayedCost(negotiator, peer, {
      requestId,
      service: SERVICE,
      requestBody: request().body,
      response: { requestId, statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: relayed.body },
      revealed: relayed.revealed,
      maxOutputTokens: MAX_TOKENS,
    });
    manager.endPaidRequest(sellerPeerId, requestId);
    const frame: NeedAuthPayload = {
      channelId,
      requestId,
      requiredCumulativeAmount: spent.toString(),
      currentAcceptedCumulative: '0',
      deposit: RESERVE.toString(),
      lastRequestCost: charge.costUsdc.toString(),
      inputTokens: charge.usage.inputTokens.toString(),
      outputTokens: charge.usage.outputTokens.toString(),
    };
    await manager.handleNeedAuth(sellerPeerId, frame, mux);
  }

  async function run(relayed: ReturnType<typeof answer>, requests: number): Promise<{ charges: BlindRelayCharge[]; spent: bigint }> {
    const charges: BlindRelayCharge[] = [];
    const sidecars: EventEmitter[] = [];
    const blind = new SellerBlindRelay({
      charge: (charge) => charges.push(charge),
      spawnKeyedRelay: () => {
        const sidecar = Object.assign(new EventEmitter(), { peer: new PassThrough(), startSeller: () => {}, admit: () => {}, refuse: () => {} });
        sidecars.push(sidecar);
        return sidecar as unknown as KeyedRelayProcess;
      },
      usageCostUsdc: (_provider, _service, usage) => computeCostUsdc(usage.freshInputTokens, usage.outputTokens, PRICING, usage.cachedInputTokens),
      admitKeyedRequest: () => ({ admitted: true }),
    });
    const minted = blind.mint(buyerPeerId, SERVICE, { keyedRelayTarget: () => TARGET } as unknown as Provider);
    let spent = 0n;
    for (let index = 1; index <= requests; index += 1) {
      const requestId = `relayed-${index}`;
      await sellerBills(blind, sidecars, minted.credentialId, requestId, relayed);
      expect(charges, `request ${index} is charged`).toHaveLength(index);
      spent += charges[index - 1]!.costUsdc;
      await buyerPays(requestId, relayed, charges[index - 1]!, spent);
      // A seller admits the next relayed request only once the earlier ones are signed for.
      expect(manager.getCumulativeAmount(sellerPeerId), `signed after request ${index} of ${requests}; the seller spent ${spent}`).toBe(spent);
    }
    return { charges, spent };
  }

  it('signs the seller\'s charge for every answer whose usage the buyer could not reveal, however many follow', async () => {
    const relayed = answer(true);
    const { charges, spent } = await run(relayed, 6);
    // Billed within the request the seller checked: the body's length, and the answer's length up to the output limit.
    const inputTokens = Math.ceil(request().body.length / 4);
    expect(charges[0]!.usage).toEqual({ inputTokens, freshInputTokens: inputTokens, cachedInputTokens: 0, outputTokens: MAX_TOKENS });
    // Far past the overdraft window: every charge was verified, none signed on trust.
    expect(spent).toBeGreaterThan(2n * WINDOW);
  });

  it('signs the usage the answer reports when the buyer reveals it', async () => {
    const { charges } = await run(answer(false), 6);
    expect(charges[0]!.usage).toEqual({ inputTokens: 12, freshInputTokens: 12, cachedInputTokens: 0, outputTokens: 1 });
  });
});
