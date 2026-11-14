import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntseedNode } from '../src/node.js';
import { ChannelStore } from '../src/payments/channel-store.js';
import { ConnectionManager } from '../src/p2p/connection-manager.js';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import type { PaymentMux } from '../src/p2p/payment-mux.js';
import { decodeMetadataAttribution } from '../src/payments/evm/signatures.js';
import type { BuyerPaymentManager } from '../src/payments/buyer-payment-manager.js';

const CLIENT_ID = '0x' + '00'.repeat(31) + '2a';
const INVITE = { epoch: 42n, index: 7n, r: '0x' + '11'.repeat(32), vs: '0x' + '22'.repeat(32) };

function recordingMux(): PaymentMux & { sent: Array<{ metadata: string }> } {
  const sent: Array<{ metadata: string }> = [];
  return { sent, sendSpendingAuth: (payload: { metadata: string }) => { sent.push(payload); } } as unknown as PaymentMux & { sent: typeof sent };
}

/** Attribution in the metadata the identity's payment manager signs when opening a channel. */
async function signedAttribution(manager: BuyerPaymentManager, seller: string) {
  const mux = recordingMux();
  await manager.authorizeSpending(seller.repeat(20), mux, 10_000n, { inputUsdPerMillion: 1, outputUsdPerMillion: 1 });
  return decodeMetadataAttribution(mux.sent[0]!.metadata);
}

describe('buyer identities and referral attribution', () => {
  let dataDir: string;
  let store: ChannelStore;
  let node: AntseedNode;

  beforeEach(() => {
    // No WebRTC here: loading node-datachannel in this worker is not needed to sign.
    vi.spyOn(ConnectionManager, 'init').mockImplementation(async (iceConfig, options) =>
      new (ConnectionManager as unknown as new (...args: unknown[]) => ConnectionManager)(iceConfig, options));
    dataDir = mkdtempSync(join(tmpdir(), 'antseed-identity-attribution-'));
    store = new ChannelStore(dataDir);
    node = new AntseedNode({
      role: 'buyer',
      dataDir,
      payments: {
        enabled: true,
        rpcUrl: 'http://127.0.0.1:8545',
        depositsAddress: '0x' + 'dd'.repeat(20),
        channelsAddress: '0x' + 'cc'.repeat(20),
        usdcAddress: '0x' + 'ee'.repeat(20),
        freeUsageAddress: '0x' + 'ff'.repeat(20),
        chainId: 31337,
        attribution: { clientId: CLIENT_ID, invite: INVITE },
      },
    });
    Object.assign(node, {
      _started: true,
      _buyerHandler: {},
      _identity: identityFromPrivateKeyHex('44'.repeat(32)),
      _channelStore: store,
      _freeUsageClient: {},
    });
  });

  afterEach(async () => {
    await node.removeBuyerIdentity('work');
    vi.restoreAllMocks();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("does not let an added identity sign the default wallet's invite", async () => {
    await node.addBuyerIdentity('work', identityFromPrivateKeyHex('55'.repeat(32)));
    const work = (node as unknown as { _buyerIdentities: Map<string, any> })._buyerIdentities.get('work');

    expect(await signedAttribution(work.paymentManager, 'a1')).toEqual({ clientId: CLIENT_ID, invite: null });
    expect(work.freeUsageManager._attribution).toEqual({ clientId: CLIENT_ID });
    // The default identity (the wallet that redeemed the invite) keeps it.
    const internals = node as unknown as { _buyerAttribution: unknown; _buyerPaymentConfig: (dir: string, attribution: unknown) => { attribution?: unknown } };
    expect(internals._buyerPaymentConfig(dataDir, internals._buyerAttribution).attribution).toEqual({ clientId: CLIENT_ID, invite: INVITE });

    // A later update keeps the invite on the default identity only.
    const nextInvite = { ...INVITE, index: 8n };
    node.setBuyerAttribution({ clientId: CLIENT_ID, invite: nextInvite });
    expect(await signedAttribution(work.paymentManager, 'a3')).toEqual({ clientId: CLIENT_ID, invite: null });
    expect(work.freeUsageManager._attribution).toEqual({ clientId: CLIENT_ID });

    node.setBuyerAttribution(undefined);
    expect(work.paymentManager._attribution).toBeUndefined();
    expect(work.freeUsageManager._attribution).toBeUndefined();
  });

  it('gives identities added after an update the current client id only', async () => {
    node.setBuyerAttribution({ clientId: '0x' + '00'.repeat(31) + '07', invite: INVITE });
    await node.addBuyerIdentity('work', identityFromPrivateKeyHex('66'.repeat(32)));
    const work = (node as unknown as { _buyerIdentities: Map<string, any> })._buyerIdentities.get('work');
    expect(await signedAttribution(work.paymentManager, 'b1')).toEqual({ clientId: '0x' + '00'.repeat(31) + '07', invite: null });
  });
});
