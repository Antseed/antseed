// Antscan client: the read side of Antseed Points.
//
// Antscan (https://antscan.co) indexes the Antseed contracts on Base and serves
// them with open CORS. Field names mirror the typed client the ants staking
// dashboard already uses (apps/ants/src/service/indexer.ts). All big numbers
// arrive as decimal strings: USDC in 6 decimals, ANTS and pool power in wei,
// weighted points as USDC units × wei power.

export const ANTSCAN_URL = (import.meta.env.VITE_ANTSCAN_URL as string | undefined) ?? 'https://antscan.co';

export interface NetworkEpoch {
  epoch: string;
  totalPowerWeight: string;
  totalActiveStake: string;
  totalWeightedPoolPoints: string;
  totalWeightedBuyerPoints: string;
  volumeUsdc: string;
  requests: string;
  stakerBudget: string;
  lastBlockNumber: number;
}

export interface Pool {
  agentId: string;
  seller: string;
  sellerName: string | null;
  registered: boolean;
  openPositions: number;
  activeStake: string;
  pendingStake: string;
  /** Current-epoch pool power (wei ANTS·epochs) = poolWeightAtEpoch. */
  weight: string;
  lastWeight: string;
  usagePoints: string;
  weightedUsagePoints: string;
  volumeUsdc: string;
  lastVolumeUsdc: string;
  lastEmission: string;
  lastBlockNumber: number;
}

export interface PoolsResponse {
  currentEpoch: string;
  network: { current: NetworkEpoch | null; last: NetworkEpoch | null };
  pools: Pool[];
}

export interface PoolEpoch {
  epoch: string;
  weight: string;
  activeStake: string;
  weightedUsagePoints: string;
  volumeUsdc: string;
  requests: string;
  settledEmission: string;
  settled: boolean;
}

export interface PoolDetail {
  pool: { agentId: string; seller: string; sellerName: string | null; openPositions: number } | null;
  epochs: PoolEpoch[];
  stakers: number;
  activeStake: string;
  pendingStake: string;
}

export interface ParticipantEpoch {
  epoch: string;
  volumeUsdc: string;
  points: string;
  weightedPoints: string;
  requests: string;
  agentId?: string;
}

export interface Participant {
  address: string;
  currentEpoch: string;
  buyer: ParticipantEpoch[];
  seller: ParticipantEpoch[];
}

export interface Position {
  id: string;
  owner: string;
  agentId: string;
  amount: string;
  weightAmount: string;
  stakeStartEpoch: string;
  stakeEndEpoch: string;
  closedAtEpoch: string | null;
  maxLocked: boolean;
  withdrawn: boolean;
  /** 'active' | 'pending' (counts from next epoch) | other Antscan states */
  state?: string;
  /** Current-epoch power, wei ANTS·epochs. */
  power?: string;
  nextPower?: string;
}

export interface PositionsResponse {
  owner: string;
  currentEpoch: string;
  positions: Position[];
  totals: { activeStake: string; pendingStake: string; power: string };
}

export interface MarketSeller {
  address: string;
  name: string | null;
  services: string[];
}

export interface MarketOffering {
  sellerAddress: string;
  service: string;
  serviceDisplayName?: string | null;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${ANTSCAN_URL}${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Antscan ${path} answered ${res.status}`);
  return (await res.json()) as T;
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${ANTSCAN_URL}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Antscan GraphQL answered ${res.status}`);
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(body.errors[0]!.message);
  return body.data as T;
}

export const antscan = {
  pools: () => get<PoolsResponse>('/api/staking/pools'),
  /** Network totals per epoch, newest first (includes the upcoming epoch). */
  epochs: (limit = 12) => get<NetworkEpoch[]>(`/api/staking/epochs?limit=${limit}`),
  pool: (agentId: string, epochs = 8) => get<PoolDetail>(`/api/staking/pools/${encodeURIComponent(agentId)}?epochs=${epochs}`),
  participant: (address: string, epochs = 8) =>
    get<Participant>(`/api/staking/participants/${address.toLowerCase()}?epochs=${epochs}`),
  positions: (owner: string) => get<PositionsResponse>(`/api/staking/positions?owner=${owner.toLowerCase()}`),
  marketplace: async (): Promise<{ sellers: MarketSeller[]; offerings: MarketOffering[] }> => {
    const body = await get<{ sellers?: MarketSeller[]; offerings?: MarketOffering[] }>('/api/marketplace?limit=5000');
    return { sellers: body.sellers ?? [], offerings: body.offerings ?? [] };
  },

  /** How many buyers have earned points in an epoch so far. */
  async buyerCount(epoch: number): Promise<number> {
    const data = await gql<{ buyerEpochs: { totalCount: number } }>(
      `query($e: BigInt!) { buyerEpochs(where: { epoch: $e }, limit: 1) { totalCount } }`,
      { e: String(epoch) },
    );
    return data.buyerEpochs.totalCount;
  },

  async topBuyers(epoch: number, limit = 20) {
    const data = await gql<{ buyerEpochs: { items: { buyer: string; volumeUsdc: string; weightedPoints: string }[] } }>(
      `query($e: BigInt!, $n: Int!) { buyerEpochs(where: { epoch: $e }, orderBy: "weightedPoints", orderDirection: "desc", limit: $n) { items { buyer volumeUsdc weightedPoints } } }`,
      { e: String(epoch), n: limit },
    );
    return data.buyerEpochs.items;
  },

  async topBuyersAllTime(limit = 20) {
    const data = await gql<{ buyers: { items: { address: string; spentUsdc: string; buyerPoints: string }[] } }>(
      `query($n: Int!) { buyers(orderBy: "buyerPoints", orderDirection: "desc", limit: $n) { items { address spentUsdc buyerPoints } } }`,
      { n: limit },
    );
    return data.buyers.items;
  },

  async topSellers(epoch: number, limit = 20) {
    const data = await gql<{ sellerEpochs: { items: { seller: string; agentId: string; volumeUsdc: string; weightedPoints: string }[] } }>(
      `query($e: BigInt!, $n: Int!) { sellerEpochs(where: { epoch: $e }, orderBy: "weightedPoints", orderDirection: "desc", limit: $n) { items { seller agentId volumeUsdc weightedPoints } } }`,
      { e: String(epoch), n: limit },
    );
    return data.sellerEpochs.items;
  },

  /** 1-based rank of a weighted-points total among this epoch's buyers. */
  async buyerRank(epoch: number, weightedPoints: string): Promise<{ rank: number; of: number }> {
    const data = await gql<{ above: { totalCount: number }; all: { totalCount: number } }>(
      `query($e: BigInt!, $w: BigInt!) { above: buyerEpochs(where: { epoch: $e, weightedPoints_gt: $w }, limit: 1) { totalCount } all: buyerEpochs(where: { epoch: $e }, limit: 1) { totalCount } }`,
      { e: String(epoch), w: weightedPoints },
    );
    return { rank: data.above.totalCount + 1, of: data.all.totalCount };
  },

  /** Dollars spent on the network per UTC day, newest first. */
  async dailyVolume(days = 15) {
    const data = await gql<{ dailyMetrics: { items: { day: string; dayStart: number; volumeUsdc: string }[] } }>(
      `query($n: Int!) { dailyMetrics(orderBy: "dayStart", orderDirection: "desc", limit: $n) { items { day dayStart volumeUsdc } } }`,
      { n: days },
    );
    return data.dailyMetrics.items;
  },

  /** The latest settlements on Base, newest first: who paid which provider, and how much. */
  async recentSettlements(limit = 12) {
    const data = await gql<{ settlementVolumes: { items: { txHash: string; buyer: string; seller: string; epoch: string; deltaUsdc: string; timestamp: number }[] } }>(
      `query($n: Int!) { settlementVolumes(orderBy: "timestamp", orderDirection: "desc", limit: $n) { items { txHash buyer seller epoch deltaUsdc timestamp } } }`,
      { n: limit },
    );
    return data.settlementVolumes.items;
  },

  /** Open stake positions, largest first; aggregated by owner in the UI. */
  async openPositions(limit = 500) {
    const data = await gql<{ stakePositions: { items: { owner: string; agentId: string; amount: string; maxLocked: boolean }[] } }>(
      `query($n: Int!) { stakePositions(where: { withdrawn: false }, orderBy: "amount", orderDirection: "desc", limit: $n) { items { owner agentId amount maxLocked } } }`,
      { n: limit },
    );
    return data.stakePositions.items;
  },
};
