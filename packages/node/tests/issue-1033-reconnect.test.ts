import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import { BuyerPaymentManager } from '../src/payments/buyer-payment-manager.js';
import { BuyerPaymentNegotiator } from '../src/payments/buyer-payment-negotiator.js';
import { SellerPaymentManager } from '../src/payments/seller-payment-manager.js';
import { ChannelStore, CHANNEL_STATUS } from '../src/payments/channel-store.js';
import { DepositsClient } from '../src/payments/evm/deposits-client.js';
import { PaymentMux } from '../src/p2p/payment-mux.js';
import { ConnectionState } from '../src/types/connection.js';
import { toPeerId, type PeerInfo } from '../src/types/peer.js';
import type { Identity } from '../src/p2p/identity.js';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../src/types/http.js';
import type { SpendingAuthPayload } from '../src/types/protocol.js';
import { captureUnitBillingContext } from '../../buyer-core/src/unit-billing.js';
import { makeDepositsDomain, signSetOperator } from '../src/payments/evm/signatures.js';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import { VerificationMux } from '../src/verification/verification-mux.js';
import { encodeHttpRequest } from '../src/proxy/request-codec.js';
import { MessageType } from '../src/types/protocol.js';
import type { PeerConnection } from '../src/p2p/connection-manager.js';
import type { Provider } from '../src/interfaces/seller-provider.js';

const encoder = new TextEncoder();
const pricing = { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
const unitModel = { version: 1 as const, components: [{ unit: 'output_images' as const, priceUsd: 0.025 }] };
const chain: { rpcUrl: string; usdc: string; registry: string; staking: string; deposits: string; channels: string } | undefined
  = process.env.ISSUE_1033_CHAIN_CONFIG ? JSON.parse(process.env.ISSUE_1033_CHAIN_CONFIG) : undefined;

function identity(): Identity {
  const wallet = new Wallet('0x' + randomBytes(32).toString('hex'));
  return { wallet, peerId: toPeerId(wallet.address.slice(2).toLowerCase()),
    privateKey: Buffer.from(wallet.privateKey.slice(2), 'hex') };
}

describe('issue #1033 reconnect without increasing earned spend', () => {
  let directory: string;
  let buyerStore: ChannelStore;
  let sellerStore: ChannelStore;
  let provider: JsonRpcProvider | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'antseed-1033-'));
    buyerStore = new ChannelStore(join(directory, 'buyer'));
    sellerStore = new ChannelStore(join(directory, 'seller'));
    if (!chain) {
      vi.spyOn(DepositsClient.prototype, 'getBuyerBalance').mockResolvedValue({
        available: 10_000_000n, reserved: 0n, lastActivityAt: 0n,
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    buyerStore.close();
    sellerStore.close();
    provider?.destroy();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    { delivered: false, reconnects: 0, nextDelivered: false, cooperative: false },
    { delivered: false, reconnects: 2, nextDelivered: false, cooperative: false },
    { delivered: false, reconnects: 1, nextDelivered: false, cooperative: true },
    { delivered: false, reconnects: 1, nextDelivered: true, cooperative: false },
    { delivered: true, reconnects: 0, nextDelivered: false, cooperative: false },
    { delivered: true, reconnects: 1, nextDelivered: true, cooperative: false },
  ])('delivered=$delivered reconnects=$reconnects nextDelivered=$nextDelivered cooperative=$cooperative', async (scenario) => {
    const buyerIdentity = identity();
    const sellerIdentity = identity();
    let sellerAgentId: number | undefined;
    if (chain) {
      expect(new URL(chain.rpcUrl).hostname).toBe('127.0.0.1');
      provider = new JsonRpcProvider(chain.rpcUrl, undefined, { cacheTimeout: -1 });
      expect((await provider.getNetwork()).chainId).toBe(31337n);
      buyerIdentity.wallet = buyerIdentity.wallet.connect(provider);
      sellerIdentity.wallet = sellerIdentity.wallet.connect(provider);
      const deployer = await provider.getSigner(0);
      for (const participant of [buyerIdentity, sellerIdentity]) {
        await (await deployer.sendTransaction({ to: participant.wallet.address, value: 2n * 10n ** 18n })).wait();
      }
      const usdc = new Contract(chain.usdc, ['function mint(address,uint256)', 'function approve(address,uint256) returns (bool)'], deployer);
      await (await usdc.getFunction('mint')(buyerIdentity.wallet.address, 10_000_000n)).wait();
      await (await usdc.getFunction('mint')(sellerIdentity.wallet.address, 50_000_000n)).wait();
      const registry = new Contract(chain.registry, ['function register() returns (uint256)'], sellerIdentity.wallet);
      const agentId = await registry.getFunction('register').staticCall();
      sellerAgentId = Number(agentId);
      await (await registry.getFunction('register')()).wait();
      await (await usdc.connect(sellerIdentity.wallet).getFunction('approve')(chain.staking, 50_000_000n)).wait();
      const staking = new Contract(chain.staking, ['function stake(uint256,uint256)'], sellerIdentity.wallet);
      await (await staking.getFunction('stake')(agentId, 50_000_000n)).wait();
      const deposits = new Contract(chain.deposits, ['function setOperator(address,address,uint256,bytes)',
        'function deposit(address,uint256)'], buyerIdentity.wallet);
      const signature = await signSetOperator(buyerIdentity.wallet, makeDepositsDomain(31337, chain.deposits),
        { operator: buyerIdentity.wallet.address, nonce: 0n });
      await (await deposits.getFunction('setOperator')(buyerIdentity.wallet.address, buyerIdentity.wallet.address, 0n, signature)).wait();
      await (await usdc.connect(buyerIdentity.wallet).getFunction('approve')(chain.deposits, 10_000_000n)).wait();
      await (await deposits.getFunction('deposit')(buyerIdentity.wallet.address, 10_000_000n)).wait();
    }
    const common = { rpcUrl: chain?.rpcUrl ?? 'http://127.0.0.1:1', chainId: 31337,
      channelsContractAddress: chain?.channels ?? '0x' + 'cc'.repeat(20) };
    const buyer = new BuyerPaymentManager(buyerIdentity, {
      ...common, depositsContractAddress: chain?.deposits ?? '0x' + 'dd'.repeat(20), usdcAddress: chain?.usdc ?? '0x' + 'ee'.repeat(20),
      identityRegistryAddress: chain?.registry ?? '0x' + 'ff'.repeat(20), defaultAuthDurationSecs: 3600,
      maxPerRequestUsdc: 100_000n, maxReserveAmountUsdc: 1_000_000n, dataDir: join(directory, 'buyer'),
    }, buyerStore);
    const seller = new SellerPaymentManager(sellerIdentity, {
      ...common, dataDir: join(directory, 'seller'), minBudgetPerRequest: '10000',
      ...(scenario.delivered && scenario.reconnects > 0 ? { settleOnDisconnect: false } : {}),
    }, sellerStore);
    const onChain = { buyer: buyerIdentity.wallet.address, seller: sellerIdentity.wallet.address,
      deposit: 1_000_000n, settled: 0n, metadataHash: '0x' + '00'.repeat(32),
      deadline: 0n, settledAt: 0n, closeRequestedAt: 0n, status: 1 };
    const close = vi.spyOn(seller.channelsClient, 'close');
    if (!chain) {
      vi.spyOn(seller.channelsClient, 'reserve').mockResolvedValue('0xreserve');
      vi.spyOn(seller.channelsClient, 'getSession').mockImplementation(async () => ({ ...onChain }));
      close.mockImplementation(async (_signer, _channel, amount) => {
        onChain.settled = amount;
        onChain.status = 2;
        return '0xclose';
      });
    }
    const requestClose = vi.spyOn(seller.channelsClient, 'requestClose').mockResolvedValue('0xrequestclose');
    const withdraw = vi.spyOn(seller.channelsClient, 'withdraw').mockResolvedValue('0xwithdraw');
    const connection = { state: ConnectionState.Open, send: vi.fn(), on: vi.fn(), off: vi.fn(), hasRemoteCapability: () => false };
    const buyerMux = new PaymentMux(connection);
    const sellerMux = new PaymentMux(connection);
    const auths: SpendingAuthPayload[] = [];
    const accepted: string[] = [];
    let pending = Promise.resolve();
    vi.spyOn(sellerMux, 'sendAuthAck').mockImplementation((payload) => {
      void buyer.handleAuthAck(sellerIdentity.peerId, payload);
    });
    vi.spyOn(buyerMux, 'sendSpendingAuth').mockImplementation((payload) => {
      auths.push(payload);
      pending = pending.then(async () => {
        accepted.push(await seller.handleSpendingAuth(buyerIdentity.peerId, payload, sellerMux));
      });
    });
    const channelId = await buyer.authorizeSpending(sellerIdentity.peerId, buyerMux, 10_000n, 1_000_000n, pricing);
    await pending;
    expect(accepted).toEqual(['reserved']);
    expect(buyer.getCumulativeAmount(sellerIdentity.peerId)).toBe(0n);
    const peer = { peerId: sellerIdentity.peerId, lastSeen: Date.now(), providers: ['openai'] } as PeerInfo;
    const createNegotiator = () => {
      const negotiator = new BuyerPaymentNegotiator(buyerIdentity, buyer, null,
        seller.channelsClient, buyerStore, {}, { emit: vi.fn() });
      vi.spyOn(negotiator, 'getOrCreatePaymentMux').mockReturnValue(buyerMux);
      return negotiator;
    };
    const request: SerializedHttpRequest = { requestId: 'failed-image', method: 'POST', path: '/v1/images/generations',
      headers: { 'content-type': 'application/json' },
      body: encoder.encode(JSON.stringify({ model: 'fixture-image', prompt: 'test', n: 1 })) };
    let delivered = scenario.delivered;
    const providerRequest = vi.fn(async (incoming: SerializedHttpRequest): Promise<SerializedHttpResponse> => ({
      requestId: incoming.requestId, statusCode: delivered ? 200 : 400, headers: request.headers,
      body: encoder.encode(JSON.stringify(delivered
        ? { data: [{ b64_json: 'fixture-image' }] } : { error: { message: 'fixture failure' } })),
    }));
    const fixtureProvider: Provider = {
      name: 'openai', services: ['fixture-image'], pricing: { defaults: pricing },
      serviceApiProtocols: { 'fixture-image': ['openai-images'] },
      serviceUnitBillingModels: { 'fixture-image': { 'openai-images': unitModel } },
      maxConcurrency: 1, getCapacity: () => ({ current: 0, max: 1 }), handleRequest: providerRequest,
    };
    const handler = new SellerRequestHandler({ identity: sellerIdentity, providers: [fixtureProvider],
      sellerPaymentManager: seller, sessionTracker: null, channelsClient: seller.channelsClient, announcer: null, emit: () => false });
    const transport = connection as unknown as PeerConnection;
    const { mux: proxyMux } = handler.handleConnection(transport, buyerIdentity.peerId, sellerMux, new VerificationMux(transport));
    const responses = vi.spyOn(proxyMux, 'sendProxyResponse').mockImplementation(() => {});
    const needAuths = vi.spyOn(sellerMux, 'sendNeedAuth').mockImplementation(() => {});
    const serve = async (incoming: SerializedHttpRequest): Promise<SerializedHttpResponse> => {
      await proxyMux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest(incoming) });
      return responses.mock.calls.at(-1)![0];
    };
    const track = (incoming: SerializedHttpRequest): void => {
      const captured = captureUnitBillingContext({ sellerPeerId: peer.peerId, provider: 'openai',
        service: 'fixture-image', serviceApiProtocol: 'openai-images', request: incoming });
      buyer.trackRequestBilling(incoming.requestId, { ...captured, unitModel, tokenPricing: pricing });
    };
    const acknowledgeResponse = async (negotiator: BuyerPaymentNegotiator, response: SerializedHttpResponse): Promise<void> => {
      await negotiator.estimateCostFromResponse(peer, response, 'fixture-image', response.requestId);
      const needAuth = needAuths.mock.calls.filter(([payload]) => payload.requestId === response.requestId).at(-1)?.[0];
      expect(needAuth).toBeDefined();
      await buyer.handleNeedAuth(peer.peerId, needAuth!, buyerMux);
      await pending;
    };
    track(request);
    const response = await serve(request);
    const deliveredCost = scenario.delivered ? 25_000n : 0n;
    expect(response.statusCode).toBe(scenario.delivered ? 200 : 400);
    expect(seller.getCumulativeSpend(channelId)).toBe(deliveredCost);
    const initialNegotiator = createNegotiator();
    await acknowledgeResponse(initialNegotiator, response);
    expect(buyer.getCumulativeAmount(peer.peerId)).toBe(deliveredCost);
    const beforeReconnect = buyer.getCumulativeAmount(peer.peerId);
    const recoveryAmounts: string[] = [];
    for (let reconnect = 0; reconnect < scenario.reconnects; reconnect++) {
      seller.onBuyerDisconnect(buyerIdentity.peerId);
      expect(close).not.toHaveBeenCalled();
      const negotiator = createNegotiator();
      const nextRequest = { ...request, requestId: `reconnected-image-${reconnect}` };
      track(nextRequest);
      const paymentRequired = await serve(nextRequest);
      expect(paymentRequired.statusCode).toBe(402);
      expect(providerRequest).toHaveBeenCalledTimes(reconnect + 1);
      const result = await negotiator.handle402(paymentRequired, peer, connection, nextRequest);
      await pending;
      expect(result.action).toBe('retry');
      expect(seller.hasSession(buyerIdentity.peerId)).toBe(true);
      expect(buyer.isLockConfirmed(peer.peerId)).toBe(true);
      expect(buyer.getCumulativeAmount(peer.peerId)).toBe(beforeReconnect);
      expect(seller.getCumulativeSpend(channelId)).toBe(deliveredCost);
      recoveryAmounts.push(buyer.getCumulativeAmount(peer.peerId).toString());
      delivered = scenario.nextDelivered;
      const nextResponse = await serve(nextRequest);
      expect(nextResponse.statusCode).toBe(scenario.nextDelivered ? 200 : 400);
      expect(providerRequest).toHaveBeenCalledTimes(reconnect + 2);
      await acknowledgeResponse(negotiator, nextResponse);
      negotiator.cleanup();
    }
    const afterReconnect = buyer.getCumulativeAmount(peer.peerId);
    const recordedSpend = seller.getCumulativeSpend(channelId);
    if (scenario.cooperative) {
      const result = await seller.handleCloseChannelRequest(buyerIdentity.peerId,
        { version: 1, channelId }, sellerMux);
      expect(result.status).toBe('closed');
    } else {
      await seller.settleSession(buyerIdentity.peerId);
      if (afterReconnect === 0n) {
        expect(close).not.toHaveBeenCalled();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_601_000);
        await seller.checkTimeouts();
        clock.mockRestore();
      }
    }
    const finalOnChain = await seller.channelsClient.getSession(channelId);
    const agentStats = sellerAgentId === undefined ? undefined : await seller.channelsClient.getAgentStats(sellerAgentId);
    const balance = chain ? await new DepositsClient({ rpcUrl: chain.rpcUrl, contractAddress: chain.deposits,
      usdcAddress: chain.usdc, evmChainId: 31337 }).getBuyerBalance(buyerIdentity.wallet.address) : undefined;
    if (chain) console.log(JSON.stringify({ realChain: true, ...scenario,
      responseStatus: response.statusCode, recordedSpend: recordedSpend.toString(),
      beforeReconnect: beforeReconnect.toString(), recoveryAmounts, afterReconnect: afterReconnect.toString(),
      closeAmount: close.mock.calls[0]?.[2].toString(), signatureVerifiedBySeller: !accepted.includes('rejected'),
      authorizations: auths.map((auth) => auth.cumulativeAmount),
      chainStatus: finalOnChain.status, chainSettled: finalOnChain.settled.toString(),
      buyerAvailable: balance?.available.toString(), buyerReserved: balance?.reserved.toString(),
      sellerGhostCount: agentStats?.ghostCount,
    }));
    const expectedCost = deliveredCost + (scenario.reconnects > 0 && scenario.nextDelivered ? 25_000n : 0n);
    expect(recordedSpend).toBe(expectedCost);
    expect(accepted).not.toContain('rejected');
    expect(afterReconnect).toBe(expectedCost);
    expect(close).toHaveBeenCalledOnce();
    expect(close.mock.calls[0]![2]).toBe(afterReconnect);
    expect(finalOnChain.status).toBe(2);
    expect(finalOnChain.settled).toBe(afterReconnect);
    if (balance) {
      expect(balance.available).toBe(10_000_000n - afterReconnect);
      expect(balance.reserved).toBe(0n);
    }
    if (agentStats) expect(agentStats.ghostCount).toBe(0);
    expect(sellerStore.getChannel(channelId)?.status).toBe(CHANNEL_STATUS.SETTLED);
    expect(requestClose).not.toHaveBeenCalled();
    expect(withdraw).not.toHaveBeenCalled();
    initialNegotiator.cleanup();
  }, chain ? 60_000 : 5_000);
});
