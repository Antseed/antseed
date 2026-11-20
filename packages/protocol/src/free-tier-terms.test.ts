/**
 * Shared vectors for the staked free-tier promise board: the encoding and hash of terms, the
 * contract's bounds (with its error codes), program lookup and tiers. This test builds them, checks the
 * TypeScript side, and compares them with the committed file forge checks the contract against
 * (`packages/contracts/test/vectors/free-tier-terms.json`, run by
 * `test/freeTier/AntseedFreeTierTerms.t.sol`). Regenerate after a deliberate change with
 * `UPDATE_FREE_TIER_VECTORS=1 pnpm --filter @antseed/protocol test`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Interface, keccak256 } from 'ethers';

import {
  FREE_TIER_KIND_ALLOWANCE,
  FREE_TIER_KIND_FREE,
  FREE_TIER_SELLER_WIDE_SCOPE,
  FREE_TIER_TERMS_ABI,
  FREE_TIER_UNLIMITED,
  decodeFreeTierTerms,
  encodeFreeTierTerms,
  freeTierModelHash,
  freeTierTermsHash,
  programForModel,
  tierFor,
  validateFreeTierTerms,
  type FreeTierProgram,
  type FreeTierTerms,
} from './free-tier-terms.js';

const VECTORS_FILE = fileURLToPath(new URL('../../contracts/test/vectors/free-tier-terms.json', import.meta.url));
const ARTIFACT = fileURLToPath(new URL('../../contracts/out/AntseedFreeTierTerms.sol/AntseedFreeTierTerms.json', import.meta.url));
const E18 = 10n ** 18n;

const MODEL = freeTierModelHash('example/free-model');
const PRICED = freeTierModelHash('example/priced-model');
const UTF8 = freeTierModelHash('例/モデル-🚀');
const UNLIMITED_MODEL = freeTierModelHash('example/unlimited-model');

const byHash = <T extends { modelHash: string }>(models: T[]) => [...models].sort((a, b) => (BigInt(a.modelHash) < BigInt(b.modelHash) ? -1 : 1));
const byScope = (programs: FreeTierProgram[]) => [...programs].sort((a, b) => (BigInt(a.scope) < BigInt(b.scope) ? -1 : 1));

function scoped(hash: string, tiers: FreeTierProgram['tiers'], windowSecs = 3600): FreeTierProgram {
  return { scope: hash, windowSecs, buyerLimitsApplyToStakers: false, tiers, models: [{ modelHash: hash, kind: FREE_TIER_KIND_FREE }] };
}

const SIMPLE: FreeTierTerms = {
  noticeEpochs: 2,
  programs: [{
    scope: FREE_TIER_SELLER_WIDE_SCOPE,
    windowSecs: 3600,
    buyerLimitsApplyToStakers: false,
    tiers: [{ minPowerAnts: 10n, requests: 5 }, { minPowerAnts: 100n, requests: 50 }],
    models: [{ modelHash: MODEL, kind: FREE_TIER_KIND_FREE }],
  }],
};

const MIXED: FreeTierTerms = {
  noticeEpochs: 104,
  programs: byScope([
    {
      scope: FREE_TIER_SELLER_WIDE_SCOPE,
      windowSecs: 30 * 24 * 3600,
      buyerLimitsApplyToStakers: true,
      tiers: [{ minPowerAnts: 10n, requests: 5 }, { minPowerAnts: 2n ** 53n - 1n, requests: 2 ** 31 }],
      models: byHash([{ modelHash: MODEL, kind: FREE_TIER_KIND_FREE }, { modelHash: PRICED, kind: FREE_TIER_KIND_ALLOWANCE }]),
    },
    scoped(UNLIMITED_MODEL, [{ minPowerAnts: 1n, requests: FREE_TIER_UNLIMITED }], 60),
    scoped(UTF8, [{ minPowerAnts: 3n, requests: 7 }, { minPowerAnts: 4n, requests: 8 }]),
  ]),
};

const WORST: FreeTierTerms = {
  noticeEpochs: 104,
  programs: [{
    scope: FREE_TIER_SELLER_WIDE_SCOPE,
    windowSecs: 60,
    buyerLimitsApplyToStakers: true,
    tiers: [
      { minPowerAnts: 1n, requests: 1 },
      { minPowerAnts: 2n, requests: 2 ** 30 },
      { minPowerAnts: 3n, requests: 2 ** 31 },
      { minPowerAnts: 2n ** 53n - 1n, requests: FREE_TIER_UNLIMITED },
    ],
    models: byHash(Array.from({ length: 32 }, (_, i) => ({ modelHash: freeTierModelHash(`example/model-${i}`), kind: (i % 2) + 1 }))),
  }],
};

function edit(terms: FreeTierTerms, change: (copy: FreeTierTerms) => void): FreeTierTerms {
  const copy = structuredClone(terms);
  change(copy);
  return copy;
}
const first = (change: (program: FreeTierProgram) => void) => edit(SIMPLE, (t) => change(t.programs[0]!));

const CASES: Array<[string, FreeTierTerms]> = [
  ['simple seller-wide program', SIMPLE],
  ['seller-wide, scoped, UTF-8, unlimited, allowance', MIXED],
  ['no programs: no promise', { noticeEpochs: 2, programs: [] }],
  ['32 models, 4 tiers', WORST],
  ['notice 1', edit(SIMPLE, (t) => { t.noticeEpochs = 1; })],
  ['notice 105', edit(SIMPLE, (t) => { t.noticeEpochs = 105; })],
  ['17 programs', { noticeEpochs: 2, programs: Array.from({ length: 17 }, (_, i) => scoped(freeTierModelHash(`m${i}`), [{ minPowerAnts: 1n, requests: 1 }])) }],
  ['scopes not ascending', { noticeEpochs: 2, programs: byScope([scoped(MODEL, [{ minPowerAnts: 1n, requests: 1 }]), scoped(UTF8, [{ minPowerAnts: 1n, requests: 1 }])]).reverse() }],
  ['duplicate scope', { noticeEpochs: 2, programs: [scoped(MODEL, [{ minPowerAnts: 1n, requests: 1 }]), scoped(MODEL, [{ minPowerAnts: 1n, requests: 1 }])] }],
  ['window 59 seconds', first((p) => { p.windowSecs = 59; })],
  ['window in milliseconds', first((p) => { p.windowSecs = 3_600_000; })],
  ['no models', first((p) => { p.models = []; })],
  ['33 models', edit(WORST, (t) => { t.programs[0]!.models.push({ modelHash: '0x' + 'ff'.repeat(32), kind: 1 }); })],
  ['models not ascending', edit(MIXED, (t) => { t.programs[0]!.models.reverse(); })],
  ['zero model hash', first((p) => { p.models[0]!.modelHash = FREE_TIER_SELLER_WIDE_SCOPE; })],
  ['kind 3', first((p) => { p.models[0]!.kind = 3; })],
  ['kind 0', first((p) => { p.models[0]!.kind = 0; })],
  ['scoped program with two models', { noticeEpochs: 2, programs: [{ ...scoped(MODEL, SIMPLE.programs[0]!.tiers), models: byHash([{ modelHash: MODEL, kind: 1 }, { modelHash: UTF8, kind: 1 }]) }] }],
  ['scoped program lists another model', { noticeEpochs: 2, programs: [{ ...scoped(MODEL, SIMPLE.programs[0]!.tiers), models: [{ modelHash: UTF8, kind: 1 }] }] }],
  ['scoped model also seller-wide', { noticeEpochs: 2, programs: byScope([SIMPLE.programs[0]!, scoped(MODEL, [{ minPowerAnts: 1n, requests: 1 }])]) }],
  ['no tiers', first((p) => { p.tiers = []; })],
  ['five tiers', edit(WORST, (t) => { t.programs[0]!.tiers.splice(3, 0, { minPowerAnts: 4n, requests: 2 ** 31 }); })],
  ['zero threshold', first((p) => { p.tiers[0]!.minPowerAnts = 0n; })],
  ['threshold 2^53', first((p) => { p.tiers[1]!.minPowerAnts = 2n ** 53n; })],
  ['zero requests', first((p) => { p.tiers[0]!.requests = 0; })],
  ['requests 2^31 + 1', first((p) => { p.tiers[1]!.requests = 2 ** 31 + 1; })],
  ['unlimited not last', first((p) => { p.tiers[0]!.requests = FREE_TIER_UNLIMITED; })],
  ['thresholds not increasing', first((p) => { p.tiers[1]!.minPowerAnts = 10n; })],
  ['requests not increasing', first((p) => { p.tiers[1]!.requests = 5; })],
];

const LOOKUP_MODELS = [MODEL, PRICED, UTF8, UNLIMITED_MODEL, freeTierModelHash('example/unpromised'), FREE_TIER_SELLER_WIDE_SCOPE];
const POWERS = [0n, E18 - 1n, E18, 10n * E18 - 1n, 10n * E18, 100n * E18, (2n ** 53n - 1n) * E18, 2n ** 255n];

function buildVectors() {
  const terms = CASES.map(([name, value]) => ({
    name,
    hex: encodeFreeTierTerms(value),
    hash: freeTierTermsHash(value),
    code: validateFreeTierTerms(value),
  }));
  const lookups: unknown[] = [];
  const tiers: unknown[] = [];
  CASES.forEach(([, value], index) => {
    if (validateFreeTierTerms(value) !== 0) return;
    for (const modelHash of LOOKUP_MODELS) {
      const match = programForModel(value, modelHash);
      lookups.push({
        terms: index, modelHash, found: match !== null, scope: match?.program.scope ?? FREE_TIER_SELLER_WIDE_SCOPE,
        kind: match?.kind ?? 0, windowSecs: match?.program.windowSecs ?? 0,
      });
      if (!match) continue;
      for (const power of POWERS) tiers.push({ terms: index, modelHash, power: power.toString(), tier: tierFor(match.program, power) });
    }
  });
  return {
    comment: 'Generated by packages/protocol/src/free-tier-terms.test.ts; checked by forge. Do not edit by hand.',
    termsCount: terms.length, terms, lookupsCount: lookups.length, lookups, tiersCount: tiers.length, tiers,
  };
}

const vectors = buildVectors();

describe('free-tier terms vectors', () => {
  it('match the committed file forge checks', () => {
    const json = JSON.stringify(vectors, null, 2) + '\n';
    if (process.env.UPDATE_FREE_TIER_VECTORS === '1') writeFileSync(VECTORS_FILE, json);
    expect(readFileSync(VECTORS_FILE, 'utf8')).toBe(json);
  });

  it('cover every bound', () => {
    const codes = new Set(vectors.terms.map((v) => v.code));
    for (let code = 0; code <= 14; code += 1) expect(codes, `code ${code}`).toContain(code);
  });
});

describe('free-tier terms', () => {
  it('round-trips through the contract encoding', () => {
    for (const terms of [SIMPLE, MIXED, WORST, { noticeEpochs: 3, programs: [] }]) {
      expect(decodeFreeTierTerms(encodeFreeTierTerms(terms))).toEqual(terms);
      expect(freeTierTermsHash(terms)).toBe(keccak256(encodeFreeTierTerms(terms)));
    }
  });

  it('finds the scoped program first, then the seller-wide one', () => {
    expect(programForModel(MIXED, UNLIMITED_MODEL)?.program.scope).toBe(UNLIMITED_MODEL);
    expect(programForModel(MIXED, PRICED)).toMatchObject({ kind: FREE_TIER_KIND_ALLOWANCE });
    expect(programForModel(MIXED, PRICED)?.program.scope).toBe(FREE_TIER_SELLER_WIDE_SCOPE);
    expect(programForModel(MIXED, freeTierModelHash('example/unpromised'))).toBeNull();
    expect(programForModel(MIXED, FREE_TIER_SELLER_WIDE_SCOPE)).toBeNull();
  });

  it('compares whole ANTS-epochs for tiers', () => {
    const program = SIMPLE.programs[0]!;
    expect(tierFor(program, 10n * E18 - 1n)).toBe(0);
    expect(tierFor(program, 10n * E18)).toBe(1);
    expect(tierFor(program, 100n * E18)).toBe(2);
  });

  it('hashes UTF-8 service ids', () => {
    expect(freeTierModelHash('例/モデル-🚀')).toBe(keccak256(new TextEncoder().encode('例/モデル-🚀')));
  });
});

describe('free-tier board ABI', () => {
  // Needs `forge build` in packages/contracts; `pnpm contracts:check` builds it first.
  it.skipIf(!existsSync(ARTIFACT))('matches the compiled contract', () => {
    const compiled = new Interface(JSON.parse(readFileSync(ARTIFACT, 'utf8')).abi);
    const mirror = new Interface(FREE_TIER_TERMS_ABI as unknown as string[]);
    mirror.forEachFunction((fragment) => {
      expect(compiled.getFunction(fragment.selector)?.format('full'), fragment.format()).toBe(fragment.format('full'));
    });
    mirror.forEachEvent((fragment) => {
      expect(compiled.getEvent(fragment.topicHash)?.format('full'), fragment.format()).toBe(fragment.format('full'));
    });
  });
});
