import type { PeerInfo, PeerVerificationResults } from '../types/peer.js';
import { fetchPublicJson, publicHttpsUrl } from './public-json.js';

/**
 * Public history for a peer's verified identities, collected buyer-locally.
 *
 * Only identities whose ownership proof verified (see `discovery/*-verification`)
 * are looked up: a GitHub account's public repositories and creation date, or a
 * domain's registration date via the authoritative RDAP registry. The result
 * is the `identity` part of the trust score (see `trust-score.ts`).
 */

export const IDENTITY_HISTORY_VERSION = 1;
/** Evidence and the ownership verification behind it are usable for seven days. */
export const IDENTITY_HISTORY_TTL_MS = 7 * 86_400_000;
/** Maximum points a verified GitHub portfolio can earn. */
export const IDENTITY_GITHUB_MAX_POINTS = 70;
/** Maximum points a verified domain's registration age can earn. */
export const IDENTITY_DOMAIN_MAX_POINTS = 12;

const RETRY_MS = 60 * 60_000;
const MAX_IDENTITIES = 8;
const MAX_CACHE_ENTRIES = 512;

export interface GithubProjectHistory {
  id: number;
  name: string;
  createdAtMs: number;
  stars: number;
  archived: boolean;
}

export interface IdentityHistory {
  kind: 'github' | 'domain';
  claim: string;
  status: 'available' | 'unavailable';
  fetchedAtMs: number;
  /** `github:<numeric account id>` or `domain:<name>`; stable across renames. */
  identityId?: string;
  createdAtMs?: number;
  projects?: GithubProjectHistory[];
  truncated?: boolean;
  source?: string;
}

export interface IdentityHistoryEvidence {
  version: typeof IDENTITY_HISTORY_VERSION;
  identities: IdentityHistory[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function timestamp(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

function id(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export class IdentityHistoryCollector {
  private cache = new Map<string, { expiresAt: number; result: Promise<IdentityHistory> }>();
  private bootstrap: { expiresAt: number; result: Promise<unknown> } | undefined;

  constructor(private readonly getJson = fetchPublicJson, private readonly now = Date.now) {}

  async collect(results: PeerVerificationResults): Promise<IdentityHistoryEvidence> {
    const claims = new Map<string, { kind: 'github' | 'domain'; claim: string }>();
    for (const result of results.github) {
      if (result.verified && /^[a-z0-9-]{1,39}$/i.test(result.username)) {
        const claim = result.username.toLowerCase();
        claims.set(`github:${claim}`, { kind: 'github', claim });
      }
    }
    for (const result of results.domains) {
      if (result.verified && /^[a-z0-9.-]{1,253}$/i.test(result.domain)) {
        const claim = result.domain.toLowerCase();
        claims.set(`domain:${claim}`, { kind: 'domain', claim });
      }
    }
    const identities: IdentityHistory[] = [];
    for (const [claimKey, { kind, claim }] of [...claims].slice(0, MAX_IDENTITIES)) {
      // Resolve the username to its numeric account id on every pass so a
      // reassigned username cannot inherit the previous owner's cached history.
      let account: Record<string, unknown> | undefined;
      if (kind === 'github') {
        try {
          account = record(await this.getJson(`https://api.github.com/users/${claim}`));
          if (!id(account.id) || typeof account.login !== 'string' || account.login.toLowerCase() !== claim
            || !Number.isFinite(timestamp(account.created_at))) throw new Error('Invalid account');
        } catch {
          identities.push({ kind, claim, status: 'unavailable', fetchedAtMs: this.now() });
          continue;
        }
      }
      const key = account ? `github:${account.id}` : claimKey;
      let cached = this.cache.get(key);
      if (!cached || cached.expiresAt <= this.now()) {
        const result = this.load(kind, claim, account);
        cached = { expiresAt: this.now() + RETRY_MS, result };
        if (this.cache.size >= MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, cached);
        const entry = cached;
        void result.then((evidence) => { entry.expiresAt = evidence.fetchedAtMs + (evidence.status === 'available' ? IDENTITY_HISTORY_TTL_MS : RETRY_MS); });
      }
      identities.push({ ...await cached.result, claim });
    }
    return { version: IDENTITY_HISTORY_VERSION, identities };
  }

  private async load(kind: 'github' | 'domain', claim: string, account?: Record<string, unknown>): Promise<IdentityHistory> {
    try {
      const evidence = kind === 'github' ? await this.github(claim, account!) : await this.domain(claim);
      return { ...evidence, kind, claim, status: 'available', fetchedAtMs: this.now() };
    } catch {
      return { kind, claim, status: 'unavailable', fetchedAtMs: this.now() };
    }
  }

  /** One account lookup (done by the caller) plus at most four pages of repositories. */
  private async github(claim: string, account: Record<string, unknown>): Promise<Partial<IdentityHistory>> {
    const source = `https://api.github.com/users/${claim}`;
    const projects = new Map<number, GithubProjectHistory>();
    let truncated = false;
    for (let page = 1; page <= 4; page++) {
      const data = await this.getJson(`https://api.github.com/users/${claim}/repos?per_page=100&page=${page}&sort=created&direction=asc`);
      if (!Array.isArray(data) || data.length > 100) throw new Error('Invalid repository page');
      for (const value of data) {
        const repo = record(value);
        if (record(repo.owner).id !== account.id || repo.fork !== false || !id(repo.id)
          || typeof repo.size !== 'number' || !Number.isFinite(repo.size) || repo.size <= 0 || repo.disabled === true
          || typeof repo.name !== 'string' || !Number.isFinite(timestamp(repo.created_at))
          || typeof repo.stargazers_count !== 'number' || !Number.isSafeInteger(repo.stargazers_count)
          || repo.stargazers_count < 0 || typeof repo.archived !== 'boolean') continue;
        projects.set(repo.id, { id: repo.id, name: repo.name, createdAtMs: timestamp(repo.created_at),
          stars: repo.stargazers_count, archived: repo.archived });
      }
      truncated = data.length === 100;
      if (!truncated) break;
    }
    return { identityId: `github:${account.id}`, createdAtMs: timestamp(account.created_at), projects: [...projects.values()], truncated, source };
  }

  /** IANA RDAP bootstrap (cached) plus one registry query; the registration must match the exact domain. */
  private async domain(claim: string): Promise<Partial<IdentityHistory>> {
    if (!this.bootstrap || this.bootstrap.expiresAt <= this.now()) {
      this.bootstrap = { expiresAt: this.now() + RETRY_MS, result: this.getJson('https://data.iana.org/rdap/dns.json') };
    }
    const services = record(await this.bootstrap.result).services;
    if (!Array.isArray(services)) throw new Error('Invalid RDAP bootstrap');
    const tld = claim.split('.').at(-1);
    const service = services.find((entry: unknown) => Array.isArray(entry) && Array.isArray(entry[0]) && entry[0].includes(tld));
    if (!Array.isArray(service) || !Array.isArray(service[1])) throw new Error('No authoritative RDAP service');
    const base = service[1].find((value: unknown) => typeof value === 'string' && value.startsWith('https://'));
    if (typeof base !== 'string') throw new Error('No HTTPS RDAP service');
    const url = publicHttpsUrl(base);
    url.pathname = `${url.pathname.replace(/\/$/, '')}/domain/${encodeURIComponent(claim)}`;
    url.search = '';
    url.hash = '';
    const domain = record(await this.getJson(url.href));
    if (domain.objectClassName !== 'domain' || typeof domain.ldhName !== 'string' || domain.ldhName.toLowerCase() !== claim) {
      throw new Error('RDAP registration does not match verified domain');
    }
    const events = Array.isArray(domain.events) ? domain.events : [];
    const dates = events.map(record).filter((event) => event.eventAction === 'registration').map((event) => timestamp(event.eventDate));
    if (dates.length !== 1 || !Number.isFinite(dates[0])) throw new Error('Missing unambiguous registration');
    return { identityId: `domain:${claim}`, createdAtMs: dates[0], source: url.href };
  }
}

export interface IdentityScore {
  kind: 'github' | 'domain';
  claim: string;
  identityId: string;
  points: number;
}

const YEAR_MS = 365.25 * 86_400_000;
const MAX_PROJECTS_SCORED = 400;
const MIN_PROJECT_STARS = 5;
const MIN_PROJECT_AGE_YEARS = 0.25;
const ARCHIVED_PROJECT_WEIGHT = 0.2;

/**
 * Score the strongest verified identity, or `null` when none has usable
 * evidence. Identities never add up: several accounts or domains owned by one
 * operator are not independent evidence.
 *
 * GitHub (max 70): original, non-fork repositories at least three months old
 * with at least five stars, excluding the ownership-proof repository.
 *   40 * min(1, sum(log2(1 + min(stars, 500))) / 40)   stars
 * + 20 * min(1, projects / 8)                         breadth
 * + 10 * min(1, oldest project years / 3)             age
 * Archived repositories count at 20%. An empty or zero-star account earns 0.
 *
 * Domain (max 12): 12 * min(1, registration years / 5).
 */
export function scoreIdentityHistory(peer: Pick<PeerInfo, 'peerId' | 'metadata' | 'verificationResults'>, nowMs = Date.now()): IdentityScore | null {
  const results = peer.verificationResults;
  const evidence = results?.identityHistory;
  const fresh = (time: number) => Number.isFinite(time) && time <= nowMs && nowMs - time <= IDENTITY_HISTORY_TTL_MS;
  if (!results || !fresh(results.checkedAtMs) || !Array.isArray(results.github) || !Array.isArray(results.domains)
    || evidence?.version !== IDENTITY_HISTORY_VERSION || !Array.isArray(evidence.identities)) {
    return null;
  }
  const years = (time: number) => Number.isFinite(time) && time > 0 && time <= nowMs ? (nowMs - time) / YEAR_MS : 0;

  let best: IdentityScore | null = null;
  const seen = new Set<string>();
  for (const item of evidence.identities.slice(0, MAX_IDENTITIES)) {
    if (!item || item.status !== 'available' || !fresh(item.fetchedAtMs) || !item.identityId || seen.has(item.identityId)) continue;
    if (!isStillClaimed(peer, item) || !isOwnershipVerified(peer.peerId, results, item, fresh)) continue;

    let points: number;
    if (item.kind === 'github' && /^github:[1-9]\d*$/.test(item.identityId)) {
      points = scoreGithubPortfolio(item, results, years);
    } else if (item.kind === 'domain' && item.identityId === `domain:${item.claim}`) {
      points = IDENTITY_DOMAIN_MAX_POINTS * Math.min(1, years(item.createdAtMs ?? NaN) / 5);
    } else {
      continue;
    }
    seen.add(item.identityId);
    if (!best || points > best.points) best = { kind: item.kind, claim: item.claim, identityId: item.identityId, points };
  }
  return best;
}

/** The seller still announces this claim in its current metadata (or metadata is unavailable). */
function isStillClaimed(peer: Pick<PeerInfo, 'metadata'>, item: IdentityHistory): boolean {
  const announced = peer.metadata?.verifications;
  if (!announced) return true;
  if (item.kind === 'github') {
    return Array.isArray(announced.github)
      && announced.github.some((entry) => typeof entry?.username === 'string' && entry.username.toLowerCase() === item.claim);
  }
  return Array.isArray(announced.domains)
    && announced.domains.some((entry) => typeof entry?.domain === 'string' && entry.domain.toLowerCase() === item.claim);
}

/** This peer's ownership proof for the claim verified recently. */
function isOwnershipVerified(peerId: string, results: PeerVerificationResults, item: IdentityHistory, fresh: (time: number) => boolean): boolean {
  if (item.kind === 'github') {
    return results.github.some((result) => result?.verified && result.peerId === peerId
      && typeof result.username === 'string' && result.username.toLowerCase() === item.claim && fresh(result.checkedAtMs));
  }
  return results.domains.some((result) => result?.verified && result.peerId === peerId
    && typeof result.domain === 'string' && result.domain.toLowerCase() === item.claim && fresh(result.checkedAtMs));
}

/** The repository that hosts the ownership proof never counts as a project. */
function isProofRepository(results: PeerVerificationResults, claim: string, name: string): boolean {
  return results.github.some((result) => typeof result?.username === 'string' && result.username.toLowerCase() === claim
    && typeof result.repository === 'string' && result.repository.toLowerCase() === name.toLowerCase());
}

function scoreGithubPortfolio(item: IdentityHistory, results: PeerVerificationResults, years: (time: number) => number): number {
  const projects = Array.isArray(item.projects) ? item.projects.slice(0, MAX_PROJECTS_SCORED) : [];
  const accountCreatedAtMs = item.createdAtMs ?? Infinity;
  const seenIds = new Set<number>();
  let starWeight = 0;
  let projectWeight = 0;
  let oldestYears = 0;
  for (const project of projects) {
    if (!project || !id(project.id) || seenIds.has(project.id)) continue;
    if (!Number.isFinite(project.stars) || project.stars < MIN_PROJECT_STARS) continue;
    if (typeof project.name !== 'string' || typeof project.archived !== 'boolean') continue;
    if (isProofRepository(results, item.claim, project.name)) continue;
    // A project older than the account was transferred in, not built here.
    if (project.createdAtMs < accountCreatedAtMs || years(project.createdAtMs) < MIN_PROJECT_AGE_YEARS) continue;
    seenIds.add(project.id);
    const weight = project.archived ? ARCHIVED_PROJECT_WEIGHT : 1;
    starWeight += Math.log2(1 + Math.min(500, project.stars)) * weight;
    projectWeight += weight;
    oldestYears = Math.max(oldestYears, years(project.createdAtMs) * weight);
  }
  if (projectWeight === 0) return 0;
  const starPoints = 40 * Math.min(1, starWeight / 40);
  const breadthPoints = 20 * Math.min(1, projectWeight / 8);
  const agePoints = 10 * Math.min(1, oldestYears / 3);
  return Math.min(IDENTITY_GITHUB_MAX_POINTS, starPoints + breadthPoints + agePoints);
}
