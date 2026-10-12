import type { DisplaySource } from '../api-types.js';
import type { AntsContext, ResolvedStack } from './context.js';
import { IndexerError, type IndexedStakingEpoch } from './indexer.js';

export interface DisplayPoolEpoch {
  agentId: number;
  epoch: number;
  weight: string;
  activeStake: string;
  usagePoints: string;
  weightedUsagePoints: string;
  settledEmission: string;
  settled: boolean;
  snapshotBlock: number;
  lastBlockNumber: number;
}

export interface DisplaySnapshot {
  chainId: number;
  indexedBlock: number;
  indexedAt: number;
  epochs: IndexedStakingEpoch[];
  pools: DisplayPoolEpoch[];
}

export interface DisplayData {
  snapshot: DisplaySnapshot | null;
  source: DisplaySource;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const MAX_AGE_SECONDS = 120;
type Row = Record<string, unknown>;

function record(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid indexed object');
  return value as Row;
}

function decimal(row: Row, field: string): string {
  const value = row[field];
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(String(value))) throw new Error(`Missing or invalid indexed ${field}`);
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(`Unsafe indexed ${field}`);
  return String(value);
}

function integer(row: Row, field: string): number {
  const value = Number(decimal(row, field));
  if (!Number.isSafeInteger(value)) throw new Error(`Unsafe indexed ${field}`);
  return value;
}

function boolean(row: Row, field: string): boolean {
  if (typeof row[field] !== 'boolean') throw new Error(`Missing indexed ${field}`);
  return row[field] as boolean;
}

function parseEpoch(row: Row): IndexedStakingEpoch {
  return {
    complete: true, epoch: integer(row, 'epoch'), totalPowerWeight: decimal(row, 'totalPowerWeight'), totalActiveStake: decimal(row, 'totalActiveStake'),
    totalSellerPoints: decimal(row, 'totalSellerPoints'), totalWeightedPoolPoints: decimal(row, 'totalWeightedPoolPoints'), totalBuyerPoints: decimal(row, 'totalBuyerPoints'),
    volumeUsdc: decimal(row, 'volumeUsdc'), requests: decimal(row, 'requests'), stakerBudget: decimal(row, 'stakerBudget'),
    snapshotBlock: integer(row, 'snapshotBlock'), lastBlockNumber: integer(row, 'lastBlockNumber'),
  };
}

function parsePool(row: Row): DisplayPoolEpoch {
  return {
    agentId: integer(row, 'agentId'), epoch: integer(row, 'epoch'), weight: decimal(row, 'weight'), activeStake: decimal(row, 'activeStake'),
    usagePoints: decimal(row, 'usagePoints'), weightedUsagePoints: decimal(row, 'weightedUsagePoints'), settledEmission: decimal(row, 'settledEmission'), settled: boolean(row, 'settled'),
    snapshotBlock: integer(row, 'snapshotBlock'), lastBlockNumber: integer(row, 'lastBlockNumber'),
  };
}

const FIELDS = {
  epochs: 'epoch totalPowerWeight totalActiveStake totalSellerPoints totalWeightedPoolPoints totalBuyerPoints volumeUsdc requests stakerBudget snapshotBlock lastBlockNumber',
  pools: 'agentId epoch weight activeStake usagePoints weightedUsagePoints settledEmission settled snapshotBlock lastBlockNumber',
};

export async function fetchDisplaySnapshot(baseUrl: string, fetchImpl: typeof fetch, epoch: number): Promise<DisplaySnapshot> {
  const url = `${baseUrl}/graphql`;
  try {
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('Invalid display snapshot request');
    const periods = [epoch, epoch - 1].filter(value => value >= 0).map(String);
    const datasets = {
      epochs: { table: 'stakingEpochs', filter: `epoch_in:${JSON.stringify(periods)}` },
      pools: { table: 'poolEpochs', filter: `epoch_in:${JSON.stringify(periods)}` },
    };
    type Dataset = keyof typeof datasets;
    const pending = new Map<Dataset, string | null>([['epochs', null], ['pools', null]]);
    const rows: Record<Dataset, Row[]> = { epochs: [], pools: [] };
    const seen = new Map<Dataset, Set<string>>();
    let checkpoint: { chainId: number; indexedBlock: number; indexedAt: number } | null = null;
    for (let page = 0; pending.size > 0; page++) {
      if (page >= MAX_PAGES) throw new Error('Indexed display pagination limit exceeded');
      const query = `{ _meta { status } ${[...pending].map(([name, cursor]) => `${name}: ${datasets[name].table}(where:{${datasets[name].filter}},limit:${PAGE_SIZE}${cursor ? `,after:${JSON.stringify(cursor)}` : ''}) { items { ${FIELDS[name]} } pageInfo { hasNextPage endCursor } }`).join(' ')} }`;
      const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(`Explorer responded with HTTP ${response.status}`);
      const body = record(await response.json());
      if (body.errors) throw new Error('Indexed display query failed');
      const data = record(body.data);
      const chains = Object.values(record(record(data._meta).status));
      if (chains.length !== 1) throw new Error('Ambiguous indexed chain');
      const chain = record(chains[0]);
      const block = record(chain.block);
      const next = { chainId: integer(chain, 'id'), indexedBlock: integer(block, 'number'), indexedAt: integer(block, 'timestamp') };
      if (checkpoint && JSON.stringify(checkpoint) !== JSON.stringify(next)) throw new Error('Indexer checkpoint changed during pagination; retry');
      checkpoint = next;
      for (const [name, cursor] of [...pending]) {
        const result = record(data[name]);
        if (!Array.isArray(result.items)) throw new Error(`Missing indexed ${name}`);
        rows[name].push(...result.items.map(record));
        const info = record(result.pageInfo);
        if (!boolean(info, 'hasNextPage')) pending.delete(name);
        else {
          if (typeof info.endCursor !== 'string' || !info.endCursor || info.endCursor === cursor || seen.get(name)?.has(info.endCursor)) throw new Error('Invalid indexed pagination cursor');
          if (!seen.has(name)) seen.set(name, new Set());
          seen.get(name)!.add(info.endCursor);
          pending.set(name, info.endCursor);
        }
      }
    }
    if (!checkpoint) throw new Error('Missing indexed checkpoint');
    const epochs = rows.epochs.map(parseEpoch);
    const pools = rows.pools.map(parsePool);
    for (const collection of [epochs.map(row => row.epoch), pools.map(row => `${row.agentId}:${row.epoch}`)]) {
      if (new Set<string | number>(collection).size !== collection.length) throw new Error('Duplicate indexed display records');
    }
    if (!epochs.some(row => row.epoch === epoch)) throw new Error('Current indexed epoch is unavailable');
    if ([...epochs, ...pools].some(row => !periods.includes(String(row.epoch)))) throw new Error('Unexpected indexed epoch');
    if ([...epochs, ...pools].some(row => (row.lastBlockNumber ?? 0) > checkpoint.indexedBlock || (row.snapshotBlock ?? 0) > checkpoint.indexedBlock)) throw new Error('Indexed record is ahead of its checkpoint');
    return { ...checkpoint, epochs, pools };
  } catch (error) {
    throw new IndexerError(error instanceof Error ? error.message : String(error), url);
  }
}

export async function displayData(ctx: AntsContext, stack: ResolvedStack): Promise<DisplayData> {
  const indexer = ctx.indexer();
  if (!indexer?.displaySnapshot) return { snapshot: null, source: { source: 'chain' } };
  try {
    const snapshot = await indexer.displaySnapshot(stack.currentEpoch);
    const now = Math.floor(Date.now() / 1000);
    if (snapshot.chainId !== ctx.chain.evmChainId) throw new Error('Antscan chain does not match the dashboard');
    const barrier = ctx.positionReadBarriers?.get(ctx.address.toLowerCase());
    if (barrier && snapshot.indexedBlock < barrier.block) throw new Error('Antscan has not caught up with your transaction');
    if (now - snapshot.indexedAt > MAX_AGE_SECONDS || snapshot.indexedAt > now + 30) throw new Error('Antscan checkpoint is stale');
    if (snapshot.indexedAt < stack.genesis + stack.currentEpoch * stack.epochDuration) throw new Error('Antscan has not reached the current epoch');
    return { snapshot, source: { source: 'indexer', indexedBlock: snapshot.indexedBlock, indexedAt: snapshot.indexedAt } };
  } catch (error) {
    if (!(error instanceof IndexerError) && !(error instanceof Error)) throw error;
    return { snapshot: null, source: { source: 'chain', error: error.message } };
  }
}
