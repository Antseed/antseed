import { useQuery } from '@tanstack/react-query';

// The last lANTS sale on antseedmarkets (CORS open). lANTS are locked ANTS positions sold for USDC,
// so price ÷ ANTS in the position gives a rough USD value for ANTS. It's a thin market of locked
// positions, so the site shows it only as a hint next to ANTS amounts, never instead of them.
const TRADES_API = 'https://antseedmarkets.com/api/lants/trades';
export const LANTS_SALES_URL = 'https://antseedmarkets.com/markets/lants/sales';

interface RawTrade { priceWei?: string; currency?: string; amount?: number; createdAt?: number }

export interface AntsPrice { usdPerAnts: number; at: number; ants: number; usd: number }

export function useAntsPrice() {
  return useQuery({
    queryKey: ['ants-price'],
    staleTime: 10 * 60_000,
    retry: 1,
    queryFn: async (): Promise<AntsPrice | null> => {
      const res = await fetch(TRADES_API);
      if (!res.ok) throw new Error(`antseedmarkets answered ${res.status}`);
      const body = (await res.json()) as { trades?: RawTrade[] };
      // Newest USDC sale with a real position behind it (test trades in other currencies are skipped).
      const last = (body.trades ?? [])
        .filter((t) => t.currency === 'USDC' && Number(t.amount) > 0 && Number(t.priceWei) > 0)
        .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))[0];
      if (!last) return null;
      const usd = Number(last.priceWei) / 1e6;
      return { usdPerAnts: usd / Number(last.amount), at: Number(last.createdAt), ants: Number(last.amount), usd };
    },
  });
}
