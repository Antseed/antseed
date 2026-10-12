import assert from 'node:assert/strict';
import test from 'node:test';
import type { AntseedVerifierPlugin, VerifyResult } from '@antseed/node';
import { TEE_REQUIRED_CLAIMS } from '@antseed/node/tee-status';
import { runVerifier } from './verifier.js';

const claims = TEE_REQUIRED_CLAIMS.map((claim) => ({ claim, ok: true }));
const policy = { require: true, prefer: ['antseed-verifier'] };
const caps = ['verifier.antseed-verifier'];
function loader(result: VerifyResult, name = 'antseed-verifier') {
  return async (): Promise<AntseedVerifierPlugin> => ({ name, type: 'verifier', version: '0.1.0', displayName: 'Test', description: 'Test', verify: () => result });
}
const reach = () => async () => ({ statusCode: 200, headers: {}, body: new Uint8Array() });

test('TEE badge requires genuine-node and seller-binding claims without changing generic CLI verification', async () => {
  const passed = await runVerifier(policy, 'seller', caps, reach, undefined, loader({ ok: true, claims }));
  assert.equal(passed.ok, true);
  assert.equal(passed.sellerNodeVerified, true);
  assert.equal(passed.version, '0.1.0');
  assert.deepEqual(passed.claims, claims);
  for (const result of [
    { ok: true, claims: [] },
    { ok: false, claims },
    { ok: true, claims: claims.slice(1) },
    { ok: true, claims: [...claims, { ...claims[0]!, ok: false }] },
    { ok: true, claims: null } as unknown as VerifyResult,
    { ok: true, claims: [{ claim: 'anything', ok: 'yes' }] } as unknown as VerifyResult,
  ]) {
    const failed = await runVerifier(policy, 'seller', caps, reach, undefined, loader(result));
    assert.equal(failed.ok, result.ok);
    assert.equal(failed.sellerNodeVerified, false);
    const optional = await runVerifier({ require: false }, 'seller', caps, reach, undefined, loader(result));
    assert.equal(optional.ok, true);
    assert.equal(optional.sellerNodeVerified, false);
  }
});

test('missing/unavailable/wrong verifier never produces positive evidence', async () => {
  assert.equal((await runVerifier(policy, 'seller', [], reach)).ok, false);
  assert.equal((await runVerifier(policy, 'seller', caps, reach, undefined, loader({ ok: true, claims }, 'other'))).ok, false);
  const unavailable = await runVerifier(policy, 'seller', caps, reach, undefined, async () => { throw new Error('SDK unavailable'); });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.transient, true);
});
