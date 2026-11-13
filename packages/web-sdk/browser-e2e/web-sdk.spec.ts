import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { Wallet, keccak256, verifyTypedData } from 'ethers';
import {
  ConnectionManager,
  FrameDecoder,
  encodeFrame,
} from '@antseed/node/p2p';
import { ProxyMux, toPeerId } from '@antseed/node';
import {
  MessageType,
  RESERVE_AUTH_TYPES,
  SPENDING_AUTH_TYPES,
  decodeSpendingAuth,
  encodeAuthAck,
  encodeNeedAuth,
  encodePaymentRequired,
  makeChannelsDomain,
  type SpendingAuthPayload,
} from '@antseed/protocol';
import { RelayServer } from '../../../apps/relay/dist/server.js';
import { SellerCache } from '../../../apps/relay/dist/seller-cache.js';

let manager: ConnectionManager;
let relay: RelayServer;
let vite: ViteDevServer;
let relayUrl: string;
let pageUrl: string;
let sellerPeerId: string;
let paidBuyerAddress = '';
const paidState = {
  channelId: null as string | null,
  onChain: false,
  recognized: false,
  cumulative: 0n,
  reserveAuths: [] as SpendingAuthPayload[],
  spendingAuths: [] as SpendingAuthPayload[],
};

const CHANNELS_ADDRESS = '0xa513E6E4b8f2a923D98304ec87F64353C4D5C853';

test.beforeAll(async () => {
  const sellerWallet = Wallet.createRandom();
  sellerPeerId = sellerWallet.address.slice(2).toLowerCase();
  manager = await ConnectionManager.init();
  manager.setLocalIdentity({ peerId: toPeerId(sellerPeerId), wallet: sellerWallet as never });
  manager.on('connection', (connection) => wireSeller(connection));
  await manager.startListening({ peerId: toPeerId(sellerPeerId), host: '127.0.0.1', port: 0 });
  const sellerPort = manager.getListeningPort();
  if (!sellerPort) throw new Error('seller listener did not bind');

  const cache = new SellerCache({
    dht: false,
    pollIntervalMs: 60_000,
    staticSellers: [{ peerId: sellerPeerId, host: '127.0.0.1', port: sellerPort }],
  });
  relay = new RelayServer(cache, {
    port: 0,
    host: '127.0.0.1',
    maxBridgesPerIp: 4,
    tcpConnectTimeoutMs: 5_000,
    idleTimeoutMs: 30_000,
  });
  await relay.start();
  relayUrl = `http://127.0.0.1:${relay.address().port}`;

  vite = await createServer({
    root: fileURLToPath(new URL('.', import.meta.url)),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
  });
  await vite.listen();
  const address = vite.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite test server did not bind');
  pageUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await vite?.close();
  await relay?.stop();
  await manager?.stopListening();
});

test('native browser WebRTC reaches an unchanged seller through relay signaling', async ({ page }) => {
  const buyer = Wallet.createRandom();
  await page.goto(pageUrl);
  const result = await page.evaluate(async (config) => {
    return window.runAntseedAcceptance(config);
  }, {
    relayUrl,
    sellerPeerId,
    buyerPrivateKey: buyer.privateKey,
  });

  expect(result.peerId).toBe(buyer.address.slice(2).toLowerCase());
  expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body)).toEqual({ ok: true, runtime: 'browser' });
});

test('two tabs cannot sign as one buyer and a crashed owner releases the lock', async ({ browser }) => {
  const context = await browser.newContext();
  const owner = await context.newPage();
  const contender = await context.newPage();
  await Promise.all([owner.goto(pageUrl), contender.goto(pageUrl)]);
  const buyer = Wallet.createRandom();
  const config = { relayUrl, sellerPeerId, buyerPrivateKey: buyer.privateKey };

  await owner.evaluate((value) => window.openAntseedBuyer(value), config);
  const blocked = await contender.evaluate(async (value) => {
    try {
      await window.openAntseedBuyer(value);
      return { opened: true };
    } catch (error) {
      return {
        opened: false,
        name: (error as Error).name,
        code: (error as { code?: string }).code,
      };
    }
  }, config);
  expect(blocked).toMatchObject({
    opened: false,
    name: 'BuyerAlreadyActiveError',
    code: 'buyer_active_in_another_tab',
  });

  // Closing a renderer simulates a tab crash: the browser releases its Web
  // Lock even though client.close() never ran.
  await owner.close();
  const successorPeerId = await contender.evaluate(
    (value) => window.openAntseedBuyer({ ...value, waitForLock: true }),
    config,
  );
  expect(successorPeerId).toBe(buyer.address.slice(2).toLowerCase());
  await contender.evaluate(() => window.closeAntseedBuyer());
  await context.close();
});

test('paid browser authorization survives reload and recovers the existing channel', async ({ page }) => {
  const buyer = Wallet.createRandom();
  paidBuyerAddress = buyer.address;
  Object.assign(paidState, {
    channelId: null,
    onChain: false,
    recognized: false,
    cumulative: 0n,
    reserveAuths: [],
    spendingAuths: [],
  });
  const config = { relayUrl, sellerPeerId, buyerPrivateKey: buyer.privateKey };
  await page.goto(pageUrl);

  const first = await page.evaluate(
    (value) => window.runPaidAntseedAcceptance(value),
    config,
  );
  expect(first.statusCode).toBe(200);
  expect(BigInt(first.authMax)).toBeGreaterThan(0n);
  expect(paidState.reserveAuths).toHaveLength(1);

  // Simulate a seller process restart while the browser reloads. The channel
  // remains active on-chain, but both peers must recover their local state.
  paidState.recognized = false;
  await page.reload();
  const recovered = await page.evaluate(
    (value) => window.runPaidAntseedAcceptance(value),
    config,
  );
  expect(recovered.statusCode).toBe(200);
  expect(recovered.channelId).toBe(first.channelId);
  expect(BigInt(recovered.authMax)).toBeGreaterThanOrEqual(BigInt(first.authMax));
  expect(paidState.reserveAuths).toHaveLength(1);
  expect(paidState.spendingAuths.length).toBeGreaterThanOrEqual(2);
});

function wireSeller(connection: any): void {
  const decoder = new FrameDecoder();
  const mux = new ProxyMux(connection);
  let messageId = 0;
  const sendPaymentFrame = (type: MessageType, payload: Uint8Array) => {
    connection.send(encodeFrame({ type, messageId: ++messageId, payload }));
  };
  mux.onProxyRequest((request) => {
    if (request.headers['x-browser-paid'] === '1') {
      if (!paidState.recognized) {
        mux.sendProxyResponse({
          requestId: request.requestId,
          statusCode: 402,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(JSON.stringify({
            error: 'payment_required',
            minBudgetPerRequest: '1000',
            suggestedAmount: '500000',
            inputUsdPerMillion: 3000,
            outputUsdPerMillion: 15000,
          })),
        });
        sendPaymentFrame(MessageType.PaymentRequired, encodePaymentRequired({
          minBudgetPerRequest: '1000',
          suggestedAmount: '500000',
          requestId: request.requestId,
          inputUsdPerMillion: 3000,
          outputUsdPerMillion: 15000,
        }));
        return;
      }

      mux.sendProxyResponse({
        requestId: request.requestId,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({ ok: true, paid: true })),
      });
      paidState.cumulative += 1_200n;
      sendPaymentFrame(MessageType.NeedAuth, encodeNeedAuth({
        channelId: paidState.channelId!,
        requiredCumulativeAmount: paidState.cumulative.toString(),
        currentAcceptedCumulative: (paidState.cumulative - 1_200n).toString(),
        deposit: '500000',
        requestId: request.requestId,
        lastRequestCost: '1200',
        inputTokens: '300000',
        cachedInputTokens: '50000',
        freshInputTokens: '250000',
        outputTokens: '20000',
        service: 'browser-paid',
      }));
      return;
    }

    mux.sendProxyResponse({
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ ok: true, runtime: 'browser' })),
    });
  });
  connection.on('message', (bytes: Uint8Array) => {
    for (const frame of decoder.feed(bytes)) {
      if (frame.type === MessageType.Ping) {
        connection.send(encodeFrame({
          type: MessageType.Pong,
          messageId: frame.messageId,
          payload: frame.payload,
        }));
      } else if (frame.type === MessageType.SpendingAuth) {
        const auth = decodeSpendingAuth(frame.payload);
        const domain = makeChannelsDomain(31337, CHANNELS_ADDRESS);
        if (auth.reserveSalt) {
          const signer = verifyTypedData(domain, RESERVE_AUTH_TYPES, {
            channelId: auth.channelId,
            maxAmount: BigInt(auth.reserveMaxAmount!),
            deadline: BigInt(auth.reserveDeadline!),
          }, auth.spendingAuthSig);
          expect(signer.toLowerCase()).toBe(paidBuyerAddress.toLowerCase());
          paidState.reserveAuths.push(auth);
          paidState.channelId = auth.channelId;
          paidState.onChain = true;
          paidState.recognized = true;
          sendPaymentFrame(MessageType.AuthAck, encodeAuthAck({ channelId: auth.channelId }));
        } else {
          const signer = verifyTypedData(domain, SPENDING_AUTH_TYPES, {
            channelId: auth.channelId,
            cumulativeAmount: BigInt(auth.cumulativeAmount),
            metadataHash: auth.metadataHash,
          }, auth.spendingAuthSig);
          expect(signer.toLowerCase()).toBe(paidBuyerAddress.toLowerCase());
          expect(keccak256(auth.metadata)).toBe(auth.metadataHash);
          paidState.spendingAuths.push(auth);
          if (paidState.onChain && !paidState.recognized) {
            paidState.recognized = true;
            paidState.channelId = auth.channelId;
            sendPaymentFrame(MessageType.AuthAck, encodeAuthAck({ channelId: auth.channelId }));
          }
        }
      } else {
        void mux.handleFrame(frame);
      }
    }
  });
}
