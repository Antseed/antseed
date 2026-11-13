import { describe, expect, it, vi } from 'vitest';
import { IdentityHistoryCollector, scoreIdentityHistory, IDENTITY_HISTORY_TTL_MS } from '../src/reputation/identity-history.js';
import { isPublicIpv4, publicHttpsUrl } from '../src/reputation/public-json.js';
import type { PeerInfo, PeerVerificationResults } from '../src/types/peer.js';

import { NOW, PEER_ID, YEAR, projects, verification, peerWithGithub } from './helpers/identity-fixtures.js';

const points = (peer: PeerInfo, now = NOW) => scoreIdentityHistory(peer, now)?.points ?? 0;

describe('identity history score', () => {
  it('credits established original portfolios, not empty old accounts or proof repos', () => {
    expect(points(peerWithGithub())).toBe(70);
    for (const repos of [[], projects(1, 0, 10), projects(2, 0, 10), projects(30, 0, 0.1)]) {
      expect(points(peerWithGithub(repos))).toBe(0);
    }
    expect(points(peerWithGithub(projects(8, 25, 0.75)))).toBeGreaterThan(60);
    expect(points(peerWithGithub(projects(8, 25, 0.75)))).toBeLessThan(70);
  });

  it('caps stars per project and discounts archived history', () => {
    const capped = points(peerWithGithub(projects(1, 500)));
    expect(points(peerWithGithub(projects(1, 10_000_000)))).toBe(capped);
    expect(capped).toBeLessThan(25);
    expect(points(peerWithGithub(projects().map((project) => ({ ...project, archived: true }))))).toBeLessThan(25);
  });

  it('excludes the ownership-proof repository and projects predating the account', () => {
    expect(points(peerWithGithub([{ ...projects(1)[0]!, name: 'proof' }]))).toBe(0);
    expect(points(peerWithGithub(projects(10, 100, 12)))).toBe(0);
  });

  it('takes the strongest identity and never adds identities or duplicate projects', () => {
    const source = peerWithGithub();
    const evidence = source.verificationResults!.identityHistory!;
    evidence.identities.push(...evidence.identities, { kind: 'domain', claim: 'portfolio.example', status: 'available',
      identityId: 'domain:portfolio.example', fetchedAtMs: NOW, createdAtMs: NOW - 20 * YEAR });
    expect(scoreIdentityHistory(source, NOW)).toMatchObject({ kind: 'github', claim: 'portfolio', points: 70 });
    const single = projects(1);
    expect(points(peerWithGithub([...single, ...single]))).toBe(points(peerWithGithub(single)));
  });

  it('scores a verified domain by registration age up to 12 points', () => {
    const source = peerWithGithub([]);
    source.verificationResults!.identityHistory = { version: 1, identities: [{ kind: 'domain', claim: 'portfolio.example',
      status: 'available', identityId: 'domain:portfolio.example', fetchedAtMs: NOW, createdAtMs: NOW - 2.5 * YEAR }] };
    expect(scoreIdentityHistory(source, NOW)).toMatchObject({ kind: 'domain', points: 6 });
    source.verificationResults!.identityHistory.identities[0]!.createdAtMs = NOW - 20 * YEAR;
    expect(points(source)).toBe(12);
  });

  it('expires evidence and verification independently and rejects unknown versions/future timestamps', () => {
    expect(scoreIdentityHistory(peerWithGithub(), NOW + IDENTITY_HISTORY_TTL_MS + 1)).toBeNull();
    const source = peerWithGithub();
    source.verificationResults!.identityHistory!.identities[0]!.fetchedAtMs = NOW + 1;
    expect(scoreIdentityHistory(source, NOW)).toBeNull();
    source.verificationResults!.identityHistory!.identities[0]!.fetchedAtMs = NOW;
    source.verificationResults!.github[0]!.verified = false;
    expect(scoreIdentityHistory(source, NOW)).toBeNull();
    const unknown = peerWithGithub();
    (unknown.verificationResults!.identityHistory as { version: number }).version = 99;
    expect(scoreIdentityHistory(unknown, NOW)).toBeNull();
  });

  it('does not transfer proof to another peer, revoked claims, or malformed persisted data', () => {
    const other = peerWithGithub();
    other.peerId = 'b'.repeat(40) as PeerInfo['peerId'];
    expect(scoreIdentityHistory(other, NOW)).toBeNull();
    const revoked = peerWithGithub();
    revoked.metadata = { verifications: {} } as PeerInfo['metadata'];
    expect(scoreIdentityHistory(revoked, NOW)).toBeNull();
    expect(scoreIdentityHistory({ peerId: PEER_ID, providers: [], lastSeen: NOW, reputationScore: 100 }, NOW)).toBeNull();
    expect(scoreIdentityHistory({ ...peerWithGithub(), verificationResults: {} as PeerVerificationResults }, NOW)).toBeNull();
  });
});

describe('buyer-local collection', () => {
  const account = { id: 42, login: 'portfolio', created_at: '2016-01-01T00:00:00Z' };
  const repo = { id: 1, owner: { id: 42 }, name: 'original', size: 100, fork: false, archived: false, stargazers_count: 100, created_at: '2020-01-01T00:00:00Z' };

  it('collects original projects, excludes forks/wrong owners, and caches by stable ID', async () => {
    const getJson = vi.fn(async (url: string): Promise<unknown> => url.includes('/repos?')
      ? [repo, { ...repo, id: 2, fork: true }, { ...repo, id: 3, owner: { id: 99 } }, { ...repo, id: 4, size: 0 }]
      : account);
    const collector = new IdentityHistoryCollector(getJson, () => NOW);
    const results = verification();
    results.domains = [];
    results.github.push({ ...results.github[0]! });
    const first = await collector.collect(results);
    expect(first.version).toBe(1);
    expect(first.identities).toHaveLength(1);
    expect(first.identities[0]!.projects).toHaveLength(1);
    expect(first.identities[0]!.identityId).toBe('github:42');
    await collector.collect(results);
    expect(getJson.mock.calls.filter(([url]) => url.includes('/repos?'))).toHaveLength(1);
    expect(getJson).toHaveBeenCalledTimes(3);
  });

  it('does not lend cached history to a reassigned username', async () => {
    let accountId = 42;
    const getJson = vi.fn(async (url: string): Promise<unknown> => url.includes('/repos?')
      ? accountId === 42 ? [repo] : [] : { ...account, id: accountId });
    const collector = new IdentityHistoryCollector(getJson, () => NOW);
    const results = verification();
    results.domains = [];
    await collector.collect(results);
    accountId = 99;
    const next = await collector.collect(results);
    expect(next.identities[0]!.identityId).toBe('github:99');
    expect(next.identities[0]!.projects).toEqual([]);
  });

  it('paginates under a strict five-request budget and records truncation', async () => {
    const getJson = vi.fn(async (url: string): Promise<unknown> => url.includes('/repos?') ? Array.from({ length: 100 }, (_, index) => ({ ...repo, id: index + 1 })) : account);
    const results = verification();
    results.domains = [];
    const evidence = await new IdentityHistoryCollector(getJson, () => NOW).collect(results);
    expect(getJson).toHaveBeenCalledTimes(5);
    expect(evidence.identities[0]!.truncated).toBe(true);
    expect(evidence.identities[0]!.projects).toHaveLength(100);
  });

  it('uses IANA discovery and exact RDAP registration matches, never parent age', async () => {
    const getJson = vi.fn(async (url: string): Promise<unknown> => url.includes('iana.org')
      ? { services: [[['example'], ['https://rdap.registry.example/']]] }
      : { objectClassName: 'domain', ldhName: 'portfolio.example', events: [{ eventAction: 'registration', eventDate: '2008-05-24T00:00:00Z' }] });
    const collector = new IdentityHistoryCollector(getJson, () => NOW);
    const results = verification();
    results.github = [];
    expect((await collector.collect(results)).identities[0]!.status).toBe('available');
    results.domains[0]!.domain = 'sub.portfolio.example';
    expect((await collector.collect(results)).identities[0]!.status).toBe('unavailable');
    expect(getJson.mock.calls.filter(([url]) => url.includes('iana.org'))).toHaveLength(1);
  });

  it('does not fetch unverified identities and distinguishes unavailable public data', async () => {
    const getJson = vi.fn(async (): Promise<unknown> => { throw new Error('rate limited'); });
    const results = verification();
    results.domains = [];
    results.github[0]!.verified = false;
    const collector = new IdentityHistoryCollector(getJson, () => NOW);
    expect((await collector.collect(results)).identities).toEqual([]);
    expect(getJson).not.toHaveBeenCalled();
    results.github[0]!.verified = true;
    const evidence = await collector.collect(results);
    expect(evidence.identities[0]!.status).toBe('unavailable');
    expect(results.github[0]!.verified).toBe(true);
  });

  it('expires portfolio cache after seven days and bounds distinct claims per pass', async () => {
    let now = NOW;
    const getJson = vi.fn(async (url: string): Promise<unknown> => url.includes('/repos?') ? [repo] : account);
    const collector = new IdentityHistoryCollector(getJson, () => now);
    const results = verification();
    results.domains = [];
    await collector.collect(results);
    now += IDENTITY_HISTORY_TTL_MS + 1;
    await collector.collect(results);
    expect(getJson.mock.calls.filter(([url]) => url.includes('/repos?'))).toHaveLength(2);
    const many = verification();
    many.github = [];
    many.domains = Array.from({ length: 20 }, (_, index) => ({ ...many.domains[0]!, domain: `domain${index}.example` }));
    const evidence = await collector.collect(many);
    expect(evidence.identities).toHaveLength(8);
  });

  it('rejects unsafe bootstrap endpoints before making a registry request', async () => {
    const getJson = vi.fn(async (): Promise<unknown> => ({ services: [[['example'], ['https://127.0.0.1/']]] }));
    const results = verification();
    results.github = [];
    expect((await new IdentityHistoryCollector(getJson, () => NOW).collect(results)).identities[0]!.status).toBe('unavailable');
    expect(getJson).toHaveBeenCalledTimes(1);
  });
});

describe('public network restrictions', () => {
  it.each(['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.1.1', '198.18.1.1', '224.0.0.1', '::1', '::ffff:127.0.0.1'])('blocks %s', (address) => {
    expect(isPublicIpv4(address)).toBe(false);
  });
  it.each(['http://example.com', 'https://127.0.0.1', 'https://user:pass@example.com', 'https://example.com:444', 'https://localhost'])('rejects %s', (url) => {
    expect(() => publicHttpsUrl(url)).toThrow();
  });
  it('accepts public IPv4 addresses and normal HTTPS hosts', () => {
    expect(isPublicIpv4('8.8.8.8')).toBe(true);
    expect(publicHttpsUrl('https://api.github.com/users/example').hostname).toBe('api.github.com');
  });
});
