import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBuyerRouter } from '../lib/buyer-router.mjs';

const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const tmp = await mkdtemp(join(tmpdir(), 'tb-buyer-router-'));
after(() => rm(tmp, { recursive: true, force: true }));

const PEER_ID = 'a'.repeat(40);
/** A seller as the buyer sees it after discovery: one provider, one service, per-million prices. */
const seller = (inputUsdPerMillion, outputUsdPerMillion) => ({
  peerId: PEER_ID, lastSeen: Date.now(), providers: ['openai'], reputationScore: 0,
  defaultInputUsdPerMillion: inputUsdPerMillion, defaultOutputUsdPerMillion: outputUsdPerMillion,
  providerPricing: { openai: { defaults: { inputUsdPerMillion, outputUsdPerMillion } } },
});
const request = { requestId: 'r1', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ model: 'testbench-chat', messages: [{ role: 'user', content: 'hi' }] })) };

/** The sdk buyer's config as the supervisor writes and loads it (minPeerReputation 0, the topology's maxPricing). */
async function loadedBuyerConfig(maxPricing) {
  const path = join(tmp, `config-${Math.random().toString(16).slice(2)}.json`);
  await writeFile(path, JSON.stringify({ buyer: { proxyPort: 18999, minPeerReputation: 0, ...(maxPricing ? { maxPricing } : {}) } }));
  const { loadConfig } = await import(join(repo, 'apps/cli/dist/config/loader.js'));
  return loadConfig(path);
}

describe('sdk buyer router (the one antseed buyer start installs)', () => {
  it('rejects a seller over the topology maxPricing cap and keeps one under it', async () => {
    const router = await createBuyerRouter(repo, await loadedBuyerConfig({ defaults: { inputUsdPerMillion: 5, outputUsdPerMillion: 5 } }));
    const under = seller(3, 4);
    const over = seller(3, 15);
    assert.equal(router.allowsPeerForPolicy(request, under), true, 'under the cap: usable');
    assert.equal(router.allowsPeerForPolicy(request, over), false, 'over the cap: rejected');
    assert.match(router.explainPolicyRejection(request, over), /output price \$15 over buyer cap \$5/);
    assert.equal(router.selectPeer(request, [over]), null, 'never routed to');
    assert.equal(router.selectPeer(request, [over, under])?.peerId, PEER_ID);
  });

  it('without a topology maxPricing, applies the CLI default cap like antseed buyer start', async () => {
    // The CLI buyer config holds maxPricing.defaults only (its loader keeps no provider or service caps), default 100/100.
    const router = await createBuyerRouter(repo, await loadedBuyerConfig());
    assert.equal(router.allowsPeerForPolicy(request, seller(3, 15)), true, 'the testbench sellers price far below it');
    assert.equal(router.allowsPeerForPolicy(request, seller(3, 150)), false);
  });
});
