import { describe, it, expect, afterEach } from 'vitest';
import { AntseedNode, identityFromPrivateKeyHex } from '@antseed/node';
import type { SerializedHttpRequest, PeerInfo, PeerId } from '@antseed/node';
import { createLocalBootstrap } from './helpers/local-bootstrap.js';
import { MockAnthropicProvider } from './helpers/mock-provider.js';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

function makeRequest(): SerializedHttpRequest {
  return {
    requestId: randomUUID(),
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Hello' }],
    })),
  };
}

describe('Buyer identities: one buyer node pays as several wallets', () => {
  let bootstrap: Awaited<ReturnType<typeof createLocalBootstrap>> | null = null;
  let sellerNode: AntseedNode | null = null;
  let buyerNode: AntseedNode | null = null;
  const dirs: string[] = [];

  afterEach(async () => {
    try { await buyerNode?.stop(); } catch {}
    try { await sellerNode?.stop(); } catch {}
    try { await bootstrap?.stop(); } catch {}
    buyerNode = null;
    sellerNode = null;
    bootstrap = null;
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  async function setupNetwork(): Promise<PeerInfo> {
    bootstrap = await createLocalBootstrap();
    const sellerDataDir = await mkdtemp(join(tmpdir(), 'antseed-seller-'));
    const buyerDataDir = await mkdtemp(join(tmpdir(), 'antseed-buyer-'));
    dirs.push(sellerDataDir, buyerDataDir);

    sellerNode = new AntseedNode({
      role: 'seller',
      dataDir: sellerDataDir,
      dhtPort: 0,
      signalingPort: 0,
      bootstrapNodes: bootstrap.bootstrapConfig,
      allowPrivateIPs: true,
      noOfficialBootstrap: true,
    });
    sellerNode.registerProvider(new MockAnthropicProvider());
    await sellerNode.start();

    buyerNode = new AntseedNode({
      role: 'buyer',
      dataDir: buyerDataDir,
      dhtPort: 0,
      bootstrapNodes: bootstrap.bootstrapConfig,
      allowPrivateIPs: true,
      noOfficialBootstrap: true,
    });
    await buyerNode.start();

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const seller = (await buyerNode.discoverPeers()).find((peer) => peer.peerId === sellerNode!.peerId);
      if (seller) return seller;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Seller was not discovered');
  }

  it('routes each request through the selected identity, seen by the seller as a separate buyer', async () => {
    const seller = await setupNetwork();
    const teamIdentity = identityFromPrivateKeyHex(randomBytes(32).toString('hex'));
    const added = await buyerNode!.addBuyerIdentity('team-a', teamIdentity);
    expect(added.address).toBe(teamIdentity.wallet.address);
    expect(buyerNode!.buyerIdentities().map((entry) => entry.name)).toEqual(['default', 'team-a']);

    const viaDefault = await buyerNode!.sendRequest(seller, makeRequest());
    expect(viaDefault.statusCode).toBe(200);
    const viaTeam = await buyerNode!.sendRequest(seller, makeRequest(), { buyerIdentity: 'team-a' });
    expect(viaTeam.statusCode).toBe(200);

    // The seller holds one authenticated connection per buyer wallet.
    expect(sellerNode!.getPeerConnectionState(buyerNode!.peerId as PeerId)).not.toBeNull();
    expect(sellerNode!.getPeerConnectionState(teamIdentity.peerId)).not.toBeNull();
  });

  it('rejects duplicate wallets and unknown identities, and stops serving removed ones', async () => {
    const seller = await setupNetwork();
    const teamIdentity = identityFromPrivateKeyHex(randomBytes(32).toString('hex'));
    await buyerNode!.addBuyerIdentity('team-a', teamIdentity);

    await expect(buyerNode!.addBuyerIdentity('team-b', teamIdentity)).rejects.toThrow(/already loaded/);
    await expect(buyerNode!.addBuyerIdentity('default', identityFromPrivateKeyHex(randomBytes(32).toString('hex'))))
      .rejects.toThrow(/Invalid buyer identity name/);
    await expect(buyerNode!.sendRequest(seller, makeRequest(), { buyerIdentity: 'missing' }))
      .rejects.toThrow(/Unknown buyer identity/);

    await buyerNode!.removeBuyerIdentity('team-a');
    expect(buyerNode!.hasBuyerIdentity('team-a')).toBe(false);
    await expect(buyerNode!.sendRequest(seller, makeRequest(), { buyerIdentity: 'team-a' }))
      .rejects.toThrow(/Unknown buyer identity/);
  });
});
