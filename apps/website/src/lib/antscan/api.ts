/**
 * The public APIs the site reads its live figures from, and the fields it uses of each. All answer with `access-control-allow-origin: *`.
 *
 * Antscan (https://antscan.co, the Antseed explorer):
 * - `GET /api/totals` — lifetime counters: `buyerCount`, `sellerCount`, `totalRequests`, `totalInputTokens`, `totalOutputTokens`,
 *   `totalVolumeUsdc` (USDC base units), and the buyer-reported free usage `freeRequests`, `freeInputTokens`, `freeOutputTokens`.
 *   Big counters are decimal strings.
 * - `GET /api/marketplace?limit=5000` — every live offering seen on the DHT (no paging: `limit` caps the list, 5000 at most) and
 *   `totals.uniqueServices`. Also takes `q`, `provider` and `seller` filters. Text prices are USD per million tokens; the media
 *   price fields below are optional until Antscan publishes them.
 * - `GET /api/emissions` — the ANTS emission clock and supply: `currentEpoch`, `epochDuration`, `epochProgress.endsAt` (unix
 *   seconds), `mintedSupply` and `maxSupply` (18-decimal base units, decimal strings).
 * - `POST /graphql` — the indexer's tables (networkSnapshot, epochMetrics, …); the REST routes above cover what the site shows.
 *
 * Elsewhere, for what Antscan does not carry:
 * - OpenRouter `GET /api/v1/models` — makers' list prices (`pricing.prompt`, USD per token), for the text savings.
 * - Base `eth_call` balanceOf(0x…dEaD) on the ANTS token — burned ANTS; Antscan indexes no burns.
 */

export const ANTSCAN = 'https://antscan.co';

export const ENDPOINTS = {
  totals: `${ANTSCAN}/api/totals`,
  marketplace: `${ANTSCAN}/api/marketplace?limit=5000`,
  emissions: `${ANTSCAN}/api/emissions`,
  listPrices: 'https://openrouter.ai/api/v1/models',
  baseRpc: 'https://mainnet.base.org',
} as const;

export type TotalsResponse = {
  totalVolumeUsdc: string;
  totalRequests: string;
  totalInputTokens: string;
  totalOutputTokens: string;
  freeRequests: string;
  freeInputTokens: string;
  freeOutputTokens: string;
  sellerCount: number;
  buyerCount: number;
};

export type Offering = {
  service: string;
  serviceDisplayName?: string;
  sellerAddress: string;
  sellerOnChainReputationScore: number | null;
  protocols: string[];
  inputUsdPerMillion: number | null;
  /** Prices per billing unit as the seller publishes them, USD, keyed by unit (absent or empty for token-priced services). */
  unitPrices?: Partial<Record<BillingUnit, UnitPrice>>;
};

/** Billing units sellers publish for non-token services. */
export type BillingUnit = 'output_images' | 'video_seconds' | 'video_generations' | 'input_characters' | 'completed_requests';
export type UnitPrice = {minUsd: number; maxUsd: number};

export type MarketplaceResponse = {
  totals: {uniqueServices: number};
  offerings: Offering[];
};

export type EmissionsResponse = {
  currentEpoch: string;
  epochDuration: string;
  mintedSupply: string;
  maxSupply: string;
  epochProgress: {startedAt: string; endsAt: string};
};

export type ListPricesResponse = {
  data: Array<{id: string; name?: string; pricing?: {prompt?: string}}>;
};
