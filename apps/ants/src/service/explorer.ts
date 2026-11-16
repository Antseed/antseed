import type { SellerProfile } from '../api-types.js';

const PROFILE_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;
const cache = new Map<string, { at: number; byAddress: Map<string, SellerProfile>; byAgent: Map<number, string> }>();

interface ExplorerSeller {
  address: string; agentId?: string | number | null; sellerName?: string | null; sellerProviders?: string[] | null;
  modelsServed?: number | null; uniqueBuyers?: number | null; requestCount?: string | null; earnedUsdc?: string | null;
  ghostRate?: number | null; lastSettledAt?: number | null;
}

export interface ExplorerSellers {
  /** Profiles keyed by lowercase seller address. */
  byAddress: Map<string, SellerProfile>;
  /** Seller address per agent id (covers legacy sellers with no registry binding). */
  byAgent: Map<number, string>;
}

/** Fetch the explorer's seller directory (names, lifetime stats). Failure-tolerant: returns empty maps when unreachable. */
export async function explorerSellers(baseUrl: string | undefined, fetchImpl: typeof fetch = fetch): Promise<ExplorerSellers> {
  if (!baseUrl) return { byAddress: new Map(), byAgent: new Map() };
  const cached = cache.get(baseUrl);
  if (cached && Date.now() - cached.at < PROFILE_TTL_MS) return cached;
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/sellers`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`explorer ${response.status}`);
    const sellers = await response.json() as ExplorerSeller[];
    const byAddress = new Map<string, SellerProfile>();
    const byAgent = new Map<number, string>();
    for (const seller of sellers) {
      if (typeof seller.address !== 'string') continue;
      const address = seller.address.toLowerCase();
      byAddress.set(address, {
        fetchedAt: Date.now(), stale: false,
        name: seller.sellerName ?? null,
        providers: Array.isArray(seller.sellerProviders) ? seller.sellerProviders : [],
        modelsServed: seller.modelsServed ?? null,
        uniqueBuyers: seller.uniqueBuyers ?? null,
        requestCount: seller.requestCount ?? null,
        lifetimeVolumeUsdc: seller.earnedUsdc ?? null,
        ghostRate: seller.ghostRate ?? null,
        lastSettledAt: seller.lastSettledAt ?? null,
      });
      const agentId = Number(seller.agentId);
      if (Number.isSafeInteger(agentId) && agentId > 0 && !byAgent.has(agentId)) byAgent.set(agentId, address);
    }
    const entry = { at: Date.now(), byAddress, byAgent };
    cache.set(baseUrl, entry);
    return entry;
  } catch {
    return cached ? { ...cached, byAddress: new Map([...cached.byAddress].map(([address, profile]) => [address, { ...profile, stale: true }])) } : { byAddress: new Map(), byAgent: new Map() };
  }
}
