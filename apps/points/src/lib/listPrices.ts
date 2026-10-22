import { useQuery } from '@tanstack/react-query';

// Official list prices, matched the same way as the website's pricing card
// (apps/website/src/lib/useMarketplacePrices.ts): OpenRouter's public model catalog
// (CORS open, no key), keyed by the model id after the vendor, normalized.
const OPENROUTER_MODELS_API = 'https://openrouter.ai/api/v1/models';

/** Model makers whose OpenRouter entry is their own list price (same set as the website). */
const VENDORS = new Set(['anthropic', 'openai', 'google', 'deepseek', 'meta-llama', 'qwen', 'mistralai', 'moonshotai', 'z-ai', 'minimax', 'cohere', 'nousresearch', 'xiaomi', 'tencent', 'stepfun', 'nvidia', 'x-ai']);

export const normalizeModel = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

interface RawModel { id?: string; pricing?: { prompt?: string } }

/** Normalized model id → official input price in $ per million tokens. */
export function useListPrices() {
  return useQuery({
    queryKey: ['list-prices'],
    staleTime: 60 * 60_000,
    retry: 1,
    queryFn: async (): Promise<Map<string, number>> => {
      const res = await fetch(OPENROUTER_MODELS_API);
      if (!res.ok) throw new Error(`OpenRouter answered ${res.status}`);
      const body = (await res.json()) as { data?: RawModel[] };
      const out = new Map<string, number>();
      for (const m of body.data ?? []) {
        // ":free" / ":batch" variants aren't the list price.
        if (!m.id || m.id.includes(':')) continue;
        const [vendor, model] = m.id.split('/');
        if (!vendor || !model || !VENDORS.has(vendor)) continue;
        const perToken = Number(m.pricing?.prompt);
        if (!Number.isFinite(perToken) || perToken <= 0) continue;
        out.set(normalizeModel(model), perToken * 1e6);
      }
      return out;
    },
  });
}

/**
 * Whole-percent saving of `inputUsd` against the list price, or null when there's no match or no saving.
 * Providers name models loosely ("sonnet-5"), so the display name ("Claude Sonnet 5") is tried too.
 */
export function discountPct(serviceId: string, displayName: string, inputUsd: number, list: Map<string, number> | undefined): number | null {
  const official = list?.get(normalizeModel(serviceId)) ?? list?.get(normalizeModel(displayName));
  if (!official || inputUsd <= 0 || inputUsd >= official) return null;
  return Math.min(99, Math.max(1, Math.round((1 - inputUsd / official) * 100)));
}
