import assert from 'node:assert/strict';
import test from 'node:test';
import { onlineManager } from '@tanstack/query-core';
import { TEE_BADGE_MAX_AGE_MS, TEE_MAX_AGE_MS } from '@antseed/node/tee-status';
import type { VerifyOutcome } from '../plugins/verifier.js';
import { TeeVerification } from './tee-verification.js';

const peer = { peerId: 'a'.repeat(40), capabilities: ['verifier.antseed-verifier'] };
const strict = { require: true, prefer: ['antseed-verifier'] };
const pass: VerifyOutcome = { ok: true, verified: true, sellerNodeVerified: true, sdk: 'antseed-verifier' };

test('display checks reuse successful evidence for 24 hours without extending it on reads', async () => {
  let now = 100;
  let runs = 0;
  const service = new TeeVerification(strict, () => now);
  const run = async () => { runs += 1; return pass; };
  await service.verifyForDisplay(peer, run);
  const evidence = service.snapshot([peer]).evidence[0]!;
  assert.equal(evidence.checkedAt, 100);
  assert.equal(evidence.expiresAt, 100 + TEE_BADGE_MAX_AGE_MS);
  now += TEE_MAX_AGE_MS;
  await service.verifyForDisplay(peer, run);
  now = evidence.expiresAt - 1;
  await service.verifyForDisplay(peer, run);
  assert.equal(runs, 1);
  assert.deepEqual(service.snapshot([peer]).evidence[0], evidence);
  now = evidence.expiresAt;
  await service.verifyForDisplay(peer, run);
  assert.equal(runs, 2);
});

test('a day-long badge never authorizes routing after the five-minute routing expiry', async () => {
  let now = 100;
  const service = new TeeVerification(strict, () => now);
  let runs = 0;
  await service.verifyForDisplay(peer, async () => pass);
  now += TEE_MAX_AGE_MS;
  assert.ok(service.snapshot([peer]).evidence[0]!.expiresAt > now);
  const outcome = await service.verify(peer, strict, async () => {
    runs += 1;
    return { ok: false, verified: false, sellerNodeVerified: false };
  });
  assert.equal(runs, 1);
  assert.equal(outcome.ok, false);
  assert.equal(service.snapshot([peer]).evidence[0]?.sellerNodeVerified, false);
  assert.equal(service.snapshot([peer]).evidence[0]?.expiresAt, now + TEE_MAX_AGE_MS);
});

test('routing and display share in-flight checks and revoke badges on unavailable results', async () => {
  let now = 100;
  const service = new TeeVerification(strict, () => now);
  let finish!: (outcome: VerifyOutcome) => void;
  const display = service.verifyForDisplay(peer, () => new Promise<VerifyOutcome>((resolve) => { finish = resolve; }));
  const routed = service.verify(peer, strict, async () => { assert.fail('duplicate attestation'); });
  await Promise.resolve();
  finish(pass);
  assert.ok((await display).sellerNodeVerified);
  assert.ok((await routed).ok);
  now += TEE_MAX_AGE_MS;
  await service.verify(peer, strict, async () => ({ ok: false, verified: false, transient: true }));
  assert.equal(service.snapshot([peer]).evidence[0]?.sellerNodeVerified, false);
  assert.equal(service.snapshot([peer]).evidence[0]?.unavailable, true);
  assert.ok((await service.verifyForDisplay(peer, async () => pass)).sellerNodeVerified);
});

test('display failures keep the short TTL and capability changes discard day-long successes', async () => {
  let now = 100;
  let runs = 0;
  const service = new TeeVerification(strict, () => now);
  await service.verifyForDisplay(peer, async () => ({ ok: false, verified: false }));
  assert.equal(service.snapshot([peer]).evidence[0]?.expiresAt, now + TEE_MAX_AGE_MS);
  now += TEE_MAX_AGE_MS;
  const run = async () => { runs += 1; return pass; };
  await service.verifyForDisplay(peer, run);
  const changed = { ...peer, capabilities: [...peer.capabilities, 'verifier.other'] };
  service.observePeers([changed]);
  assert.deepEqual(service.snapshot([changed]).evidence, []);
  await service.verifyForDisplay(changed, run);
  assert.equal(runs, 2);
  service.close();
  assert.deepEqual(service.snapshot([changed]).evidence, []);
  assert.equal((await service.verifyForDisplay(changed, run)).ok, false);
});

test('evidence cache never reuses an optional routing allowance as required verification', async () => {
  const service = new TeeVerification(strict);
  const fail = { ok: true, verified: false, reason: 'Failed' };
  assert.equal((await service.verify(peer, { require: false }, async () => fail)).ok, true);
  assert.equal((await service.verify(peer, strict, async () => pass)).ok, false);
  assert.equal(service.snapshot([peer]).evidence[0]?.sellerNodeVerified, false);
  assert.equal(service.snapshot([peer]).evidence[0]?.unavailable, false);
});

test('badge claim requirements do not become a new CLI routing policy', async () => {
  const service = new TeeVerification(strict);
  const genericPass = { ok: true, verified: true, sellerNodeVerified: false };
  const display = await service.verifyForDisplay(peer, async () => genericPass);
  assert.equal(display.ok, false);
  assert.equal(service.snapshot([peer]).evidence[0]?.sellerNodeVerified, false);
  const routed = await service.verify(peer, strict, async () => { assert.fail('should reuse generic verifier evidence'); });
  assert.equal(routed.ok, true);
  assert.deepEqual(service.snapshot([peer]), {
    sessionId: service.sessionId, verificationEnabled: true, evidence: service.snapshot([peer]).evidence,
  });
  service.close();
});

test('expiry, forced failed recheck, transient retries and daemon restart revoke success', async () => {
  let now = 100;
  let runs = 0;
  const service = new TeeVerification(strict, () => now);
  const run = async () => { runs += 1; return pass; };
  await service.verify(peer, strict, run);
  await service.verify(peer, strict, run);
  assert.equal(runs, 1);
  now += TEE_MAX_AGE_MS;
  await service.verify(peer, strict, run);
  assert.equal(runs, 2);
  await service.verify(peer, strict, async () => ({ ok: false, verified: false, transient: true }), true);
  assert.equal(service.snapshot([peer]).evidence[0]?.sellerNodeVerified, false);
  assert.equal(service.snapshot([peer]).evidence[0]?.unavailable, true);
  await service.verify(peer, strict, run);
  assert.equal(runs, 3);
  const restarted = new TeeVerification(strict);
  assert.notEqual(service.sessionId, restarted.sessionId);
  assert.deepEqual(restarted.snapshot([peer]).evidence, []);
});

test('concurrent checks deduplicate; superseded advertisements cannot restore old evidence', async () => {
  const service = new TeeVerification(strict);
  let finish!: (outcome: VerifyOutcome) => void;
  let runs = 0;
  const run = () => { runs += 1; return new Promise<VerifyOutcome>((resolve) => { finish = resolve; }); };
  const first = service.verify(peer, strict, run);
  const second = service.verify(peer, strict, run, true);
  await Promise.resolve();
  assert.equal(runs, 1);
  assert.equal(service.snapshot([peer]).evidence[0]?.checking, true);
  const changed = { ...peer, capabilities: [...peer.capabilities, 'verifier.other'] };
  await service.verify(changed, strict, async () => ({ ok: false, verified: false }));
  finish(pass);
  assert.equal((await first).ok, false);
  assert.equal((await second).ok, false);
  assert.equal(service.snapshot([changed]).evidence[0]?.sellerNodeVerified, false);
  assert.deepEqual(service.snapshot([{ ...peer, capabilities: [] }]).evidence, []);
  assert.deepEqual(service.snapshot([peer]).evidence, []);
});

test('discovery updates revoke evidence even without a status reader', async () => {
  const service = new TeeVerification(strict);
  await service.verify(peer, strict, async () => pass);
  service.observePeers([{ ...peer, capabilities: [] }]);
  service.observePeers([peer]);
  assert.deepEqual(service.snapshot([peer]).evidence, []);
});

test('stopped sessions and exhausted concurrency fail closed', async () => {
  const service = new TeeVerification(strict);
  const finishers: Array<(outcome: VerifyOutcome) => void> = [];
  const pending = Array.from({ length: 8 }, (_, index) => service.verify({ ...peer, peerId: String(index) }, strict,
    () => new Promise<VerifyOutcome>((resolve) => finishers.push(resolve))));
  assert.equal((await service.verify(peer, strict, async () => pass)).ok, false);
  await Promise.resolve();
  service.close();
  finishers.forEach((finish) => finish(pass));
  assert.ok((await Promise.all(pending)).every((outcome) => !outcome.ok));
  assert.equal((await service.verify(peer, strict, async () => pass)).ok, false);
});

test('verifier exceptions revoke success without automatic retries', async () => {
  const service = new TeeVerification(strict);
  await service.verifyForDisplay(peer, async () => pass);
  let runs = 0;
  const run = async () => { runs += 1; throw new Error('Verifier unavailable'); };
  const result = await service.verify(peer, strict, run, true);
  assert.equal(result.ok, false);
  assert.equal(result.transient, true);
  assert.equal(result.reason, 'Verifier unavailable');
  assert.equal(runs, 1);
  assert.equal(service.snapshot([peer]).evidence[0]?.sellerNodeVerified, false);
  await service.verifyForDisplay(peer, run);
  assert.equal(runs, 2);
  service.close();
});

test('refresh hides stale success and shares evidence, not caller routing policy', async () => {
  const service = new TeeVerification(strict);
  await service.verifyForDisplay(peer, async () => pass);
  let finish!: (outcome: VerifyOutcome) => void;
  const optional = service.verify(peer, { require: false }, () => new Promise<VerifyOutcome>((resolve) => { finish = resolve; }), true);
  const required = service.verifyForDisplay(peer, async () => { assert.fail('duplicate attestation'); });
  const evidence = service.snapshot([peer]).evidence[0]!;
  assert.equal(evidence.checking, true);
  assert.equal(evidence.sellerNodeVerified, false);
  await Promise.resolve();
  finish({ ok: true, verified: false, sellerNodeVerified: false });
  assert.equal((await optional).ok, true);
  assert.equal((await required).ok, false);
  service.close();
});

test('invalidating pending queries releases waiters but retains the underlying concurrency limit', async () => {
  const service = new TeeVerification(strict);
  const finishers: Array<(outcome: VerifyOutcome) => void> = [];
  const pending = Array.from({ length: 8 }, (_, index) => service.verify({ ...peer, peerId: String(index) }, strict,
    () => new Promise<VerifyOutcome>((resolve) => finishers.push(resolve))));
  await Promise.resolve();
  service.observePeers([]);
  assert.ok((await Promise.all(pending)).every((outcome) => !outcome.ok && outcome.transient));
  const busy = await service.verifyForDisplay(peer, async () => { assert.fail('exceeded concurrency limit'); });
  assert.equal(busy.code, 'busy');
  finishers.forEach((finish) => finish(pass));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(service.snapshot([peer]).evidence, []);
  assert.equal((await service.verifyForDisplay(peer, async () => pass)).ok, true);
  service.close();
});

test('bounded query cache evicts settled entries, not pending checks', async () => {
  const service = new TeeVerification(strict);
  let finish!: (outcome: VerifyOutcome) => void;
  const pending = service.verifyForDisplay(peer, () => new Promise<VerifyOutcome>((resolve) => { finish = resolve; }));
  const peers = Array.from({ length: 512 }, (_, index) => ({ ...peer, peerId: String(index) }));
  for (const seller of peers) await service.verifyForDisplay(seller, async () => pass);
  const snapshot = service.snapshot([peer, ...peers]);
  assert.equal(snapshot.evidence.length, 512);
  assert.equal(snapshot.evidence.find((entry) => entry.peerId === peer.peerId)?.checking, true);
  assert.equal(snapshot.evidence.some((entry) => entry.peerId === peers[0]!.peerId), false);
  const duplicate = service.verifyForDisplay(peer, async () => { assert.fail('evicted pending attestation'); });
  finish(pass);
  assert.equal((await pending).ok, true);
  assert.equal((await duplicate).ok, true);
  service.close();
});

test('expiry is measured from check start, not query completion time', async () => {
  let now = 100;
  const service = new TeeVerification(strict, () => now);
  await service.verifyForDisplay(peer, async () => { now += TEE_MAX_AGE_MS; return pass; });
  assert.equal(service.snapshot([peer]).evidence[0]?.checkedAt, 100);
  assert.equal(service.snapshot([peer]).evidence[0]?.expiresAt, 100 + TEE_BADGE_MAX_AGE_MS);
  let runs = 0;
  await service.verify(peer, strict, async () => { runs += 1; return pass; });
  assert.equal(runs, 1);
  service.close();
});

test('headless buyer checks do not pause for browser connectivity state', async () => {
  const service = new TeeVerification(strict);
  const wasOnline = onlineManager.isOnline();
  onlineManager.setOnline(false);
  try {
    assert.equal((await service.verifyForDisplay(peer, async () => pass)).ok, true);
  } finally {
    service.close();
    onlineManager.setOnline(wasOnline);
  }
});
