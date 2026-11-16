/**
 * The chain's record of a buyer's payment channels, kept in the channel store
 * next to the session status, and the figures every host shows from it.
 *
 * A row's `status` says whether the buyer still uses the session. Retiring a
 * session (the seller answered that the channel is exhausted, or went away)
 * does not close the channel: its reserve stays locked in AntseedDeposits until
 * the seller closes it or the buyer's operator withdraws. So what the channel
 * holds comes only from AntseedChannels' own record, read at a known block and
 * stored (`ChannelStore.recordChainState`), never guessed from the session.
 * Records only move forward by block, so a lagging read cannot undo a newer
 * one, and settled or timed-out channels are never read again.
 */
import { Interface, ZeroAddress, type AbstractProvider } from 'ethers';
import { MULTICALL3_ADDRESS, multicallRead } from './evm/multicall.js';

/** AntseedChannels' `channels(id).status`: 0 no record, 1 active, 2 settled, 3 timed out. */
export const CHAIN_CHANNEL_STATUS = { NONE: 0, ACTIVE: 1, SETTLED: 2, TIMED_OUT: 3 } as const;

/** What `channels(id)` returned. Amounts are USDC base units; `closeRequestedAt` is unix seconds (0: none). */
export interface ChannelChainState {
  status: number;
  deposit: bigint;
  settled: bigint;
  closeRequestedAt: bigint;
}

/** A stored chain record: the state, the block it was read at and when (ms). */
export interface ChannelChainRecord extends ChannelChainState {
  block: number;
  readAt: number;
}

/** What the figures need from a stored buyer channel row. */
export interface BuyerChannelChainRow {
  sessionId: string;
  sellerEvmAddr: string;
  /** The session's status in the store: `active` is the only one the buyer still uses. */
  status: string;
  /** Cumulative amount the buyer signed (base units). */
  authMax: string;
  /** What the store saw settled when the session ended; null when it never saw it. */
  settledAmount: string | null;
  /** Deadline (unix seconds) of the first ReserveAuth the buyer signed for it; 0 when unknown. */
  deadline: number;
  /** Deadline of the latest ReserveAuth, a top-up's included; null when the store has none. */
  latestReserveDeadline?: number | null;
  /** The store's reserve recovery fields; absent on rows stored before they existed. */
  reserveAuthPending?: boolean;
  confirmedReserveAmount?: string | null;
  /** Already retired when the store gained chain records: never read yet, counts nothing until it is. */
  backfill: boolean;
  record: ChannelChainRecord | null;
}

/** The store side the recorder reads and writes. */
export interface ChannelChainRecordStore {
  /**
   * A buyer's paid and one-off channel rows that are not final yet, with
   * their chain record. Final rows count nothing and are never read again,
   * so they are left out however long the history.
   */
  getBuyerChannelChainRows(buyerEvmAddr: string): BuyerChannelChainRow[];
  /** Stores a record unless one from a later block is already there. True when it was stored. */
  recordChainState(sessionId: string, record: ChannelChainRecord): boolean;
  /** Marks rows final (`chainRecordFinal`): left out of `getBuyerChannelChainRows` from then on. */
  markChainFinal(sessionIds: readonly string[]): void;
  /** Whether the buyer has any paid or one-off channel row, final ones included. */
  hasBuyerChannels(buyerEvmAddr: string): boolean;
}

/** Same margin as the buyer's reconcile: a clock running ahead must not rule out a ReserveAuth that can still land. */
export const RESERVE_LANDING_GRACE_SECS = 60 * 60;

/**
 * A row the chain says never opened, though the buyer signed spend on it or
 * the seller confirmed its reserve, is read again this often: such a read may
 * be wrong (a changed channels address, a wrong RPC), and a later one must
 * still be able to correct it.
 */
export const DOUBTFUL_RECORD_REREAD_MS = 10 * 60_000;

/** A buyer with no row left to read still has its reserve read this often, so its figures stay confirmed. */
export const RESERVE_ONLY_READ_MS = 5 * 60_000;

const CHANNELS_READ_IFACE = new Interface([
  'function channels(bytes32 channelId) view returns (address buyer, address seller, uint128 deposit, uint128 settled, bytes32 metadataHash, uint256 deadline, uint256 settledAt, uint256 closeRequestedAt, uint8 status)',
]);
const SELLER_FACADE_IFACE = new Interface(['function channelsAddress() view returns (address)']);
const DEPOSITS_READ_IFACE = new Interface([
  'function getBuyerBalance(address buyer) view returns (uint256 available, uint256 reserved, uint256 lastActivityAt)',
]);

function big(value: string | null | undefined): bigint {
  try {
    return value && /^\d+$/.test(value) ? BigInt(value) : 0n;
  } catch {
    return 0n;
  }
}

async function readChannelsAt(provider: AbstractProvider, address: string, channelIds: string[], states: Map<string, ChannelChainState>, blockTag?: number, multicall: { assumeDeployed?: boolean } = {}): Promise<void> {
  const results = await multicallRead(provider, channelIds.map((channelId) => ({
    target: address,
    iface: CHANNELS_READ_IFACE,
    method: 'channels',
    args: [channelId],
  })), { ...(blockTag !== undefined ? { blockTag } : {}), ...multicall });
  results.forEach((result, index) => {
    if (!result) return;
    states.set(channelIds[index]!, { deposit: result[2] as bigint, settled: result[3] as bigint, closeRequestedAt: result[7] as bigint, status: Number(result[8]) });
  });
}

/**
 * On-chain records for `channelIds` in one Multicall3 read, at `blockTag` when
 * given; ids it could not read are left out. A seller facade forwards
 * `reserve()` to the channels contract the registry names, so a channel
 * normally has its record on `canonical`. One with no record there is looked
 * up on the contract its seller's facade names (`sellers`: channel id →
 * seller address), which differs only when the configured address is not the
 * one the facade uses. When that cannot be checked, the id is left out rather
 * than reported as missing.
 */
export async function readChannelStatesAt(
  provider: AbstractProvider,
  canonical: string,
  channelIds: string[],
  sellers: ReadonlyMap<string, string> = new Map(),
  blockTag?: number,
  multicall: { assumeDeployed?: boolean } = {},
): Promise<Map<string, ChannelChainState>> {
  const states = new Map<string, ChannelChainState>();
  if (!canonical || channelIds.length === 0) return states;
  await readChannelsAt(provider, canonical, channelIds, states, blockTag, multicall);
  const bySeller = new Map<string, string[]>();
  for (const channelId of channelIds) {
    const seller = sellers.get(channelId)?.toLowerCase();
    if (states.get(channelId)?.status !== CHAIN_CHANNEL_STATUS.NONE || !seller || !/^0x[0-9a-f]{40}$/.test(seller)) continue;
    bySeller.set(seller, [...(bySeller.get(seller) ?? []), channelId]);
  }
  if (bySeller.size === 0) return states;
  const facadeSellers = [...bySeller.keys()];
  try {
    // A seller that is not a facade reverts or returns nothing: null here.
    const probes = await multicallRead(provider, facadeSellers.map((seller) => ({ target: seller, iface: SELLER_FACADE_IFACE, method: 'channelsAddress' })), { ...(blockTag !== undefined ? { blockTag } : {}), ...multicall });
    for (const [index, seller] of facadeSellers.entries()) {
      const underlying = probes[index]?.[0];
      if (typeof underlying !== 'string' || underlying === ZeroAddress || underlying.toLowerCase() === canonical.toLowerCase()) continue;
      // The canonical miss says nothing for a facade's channel: only its own contract's answer counts.
      const facadeChannelIds = bySeller.get(seller)!;
      for (const channelId of facadeChannelIds) states.delete(channelId);
      await readChannelsAt(provider, underlying, facadeChannelIds, states, blockTag, multicall);
    }
  } catch {
    for (const ids of bySeller.values()) for (const channelId of ids) states.delete(channelId);
  }
  return states;
}

/** One read of a buyer's channels and its reserve, all at one block. */
export interface ChannelChainRead {
  block: number;
  /** When the read started (ms). */
  readAt: number;
  /** `AntseedDeposits` reserved for the buyer at `block`; null when it could not be read. */
  reserved: bigint | null;
  channels: Map<string, ChannelChainState>;
}

export type ChannelChainReader = (buyer: string, rows: ReadonlyArray<{ channelId: string; seller: string }>) => Promise<ChannelChainRead>;

/**
 * The reader the buyer uses: the head block first, then every call at that
 * block, so the records and the reserve describe the same moment. An endpoint
 * that has not reached the block fails the read, which is tried again later.
 * Whether Multicall3 is deployed is asked once, not on every read.
 */
export function createChannelChainReader(options: { provider: AbstractProvider; channelsAddress: string; depositsAddress: string; now?: () => number }): ChannelChainReader {
  const now = options.now ?? Date.now;
  let deployed: Promise<boolean> | null = null;
  const multicallDeployed = (block: number): Promise<boolean> => {
    deployed ??= options.provider.getCode(MULTICALL3_ADDRESS, block).then((code) => code !== '0x', (err: unknown) => {
      deployed = null;
      throw err;
    });
    return deployed;
  };
  return async (buyer, rows) => {
    const readAt = now();
    const block = await options.provider.getBlockNumber();
    // A chain without it is probed again by each read (local chains only).
    const multicall = { assumeDeployed: await multicallDeployed(block) };
    const sellers = new Map(rows.map((row) => [row.channelId, row.seller]));
    const [channels, balance] = await Promise.all([
      readChannelStatesAt(options.provider, options.channelsAddress, rows.map((row) => row.channelId), sellers, block, multicall),
      multicallRead(options.provider, [{ target: options.depositsAddress, iface: DEPOSITS_READ_IFACE, method: 'getBuyerBalance', args: [buyer] }], { blockTag: block, ...multicall })
        .catch(() => [null]),
    ]);
    const reserved = balance[0]?.[1];
    return { block, readAt, reserved: typeof reserved === 'bigint' ? reserved : null, channels };
  };
}

/**
 * The deadline of the latest ReserveAuth the buyer signed for a row (a
 * top-up's included), as the buyer's reconcile takes it; 0 when unknown.
 */
export function lastReserveDeadline(row: Pick<BuyerChannelChainRow, 'deadline' | 'latestReserveDeadline'>): number {
  return Math.max(row.deadline || 0, row.latestReserveDeadline ?? 0);
}

/** No reserve or top-up the buyer signed for the row can land after `atMs` (an unknown deadline never rules one out). */
function noReserveCanLand(row: Pick<BuyerChannelChainRow, 'deadline' | 'latestReserveDeadline'>, atMs: number): boolean {
  const deadline = lastReserveDeadline(row);
  return deadline > 0 && atMs > (deadline + RESERVE_LANDING_GRACE_SECS) * 1000;
}

/**
 * What the seller can still settle on a channel the chain holds open: signed
 * minus settled, never negative. `settle()` refuses more than the deposit, so
 * once no top-up the buyer signed can raise it (a close was requested, or the
 * latest ReserveAuth's deadline, `deadline`, passed) at most deposit − settled
 * counts. Before that, spend signed past the deposit counts in full: a top-up
 * landing makes it settleable.
 */
export function unsettledOnChain(signed: bigint, state: ChannelChainState, nowSeconds: number, deadline: number | null): bigint {
  if (state.status !== CHAIN_CHANNEL_STATUS.ACTIVE) return 0n;
  const noTopUp = state.closeRequestedAt > 0n || (deadline !== null && deadline > 0 && nowSeconds > deadline + RESERVE_LANDING_GRACE_SECS);
  const claimable = noTopUp && signed > state.deposit ? state.deposit : signed;
  return claimable > state.settled ? claimable - state.settled : 0n;
}

/** What the chain holds for a channel: deposit − settled while it is open. */
export function heldOnChain(state: Pick<ChannelChainState, 'status' | 'deposit' | 'settled'>): bigint {
  return state.status === CHAIN_CHANNEL_STATUS.ACTIVE && state.deposit > state.settled ? state.deposit - state.settled : 0n;
}

/** One channel's figures. Amounts are USDC base units. */
export interface ChannelFigures {
  /** Signed but not settled, and still settleable: no longer the buyer's to spend. */
  pending: bigint;
  /** What the chain holds for it (deposit − settled) while it is open. */
  held: bigint;
  /** No chain record yet. */
  unread: boolean;
}

/**
 * A channel's figures from its stored row and chain record. The record
 * decides whatever the session status says: open, it counts what the seller
 * can still settle; settled or timed out, nothing; never opened, the store's
 * signed spend while a reserve the buyer signed can still land, and after
 * that only while the buyer still uses the session (its reconcile retires
 * one that never opened). A retired row the chain reads as never opened counts
 * nothing, as before the store kept chain records: a session that ran out of
 * reserve is retired with no settled amount, so its signed spend is its
 * lifetime spend, not something the seller can still settle. Without a
 * record (not read yet), the store's word: a session the buyer still uses, or
 * one it gave up on since it gained chain records, counts what it signed
 * minus what the store saw settled (so giving up never makes the balance jump
 * up), while a row retired before records existed counts nothing until read.
 */
export function channelFigures(row: BuyerChannelChainRow, nowSeconds: number): ChannelFigures {
  const signed = big(row.authMax);
  const storeSettled = big(row.settledAmount);
  const fromStore = signed > storeSettled ? signed - storeSettled : 0n;
  const record = row.record;
  if (!record) {
    const counts = row.status === 'active' || !row.backfill;
    return { pending: counts ? fromStore : 0n, held: 0n, unread: true };
  }
  if (record.status === CHAIN_CHANNEL_STATUS.ACTIVE) {
    const deadline = lastReserveDeadline(row);
    return { pending: unsettledOnChain(signed, record, nowSeconds, deadline > 0 ? deadline : null), held: heldOnChain(record), unread: false };
  }
  if (record.status === CHAIN_CHANNEL_STATUS.NONE) {
    const counts = row.status === 'active' || !noReserveCanLand(row, record.readAt);
    return { pending: counts ? fromStore : 0n, held: 0n, unread: false };
  }
  return { pending: 0n, held: 0n, unread: false };
}

/**
 * A retired row read as never opened once no reserve can land, though the
 * buyer signed spend on it or the seller confirmed its reserve: the read may
 * be wrong (a changed channels address, a wrong RPC), so the row is not final
 * and is read again now and then. It counts nothing meanwhile.
 */
function doubtfulNoRecord(row: BuyerChannelChainRow): boolean {
  const record = row.record;
  return record !== null && record.status === CHAIN_CHANNEL_STATUS.NONE && row.status !== 'active' && noReserveCanLand(row, record.readAt)
    && (big(row.authMax) > 0n || big(row.confirmedReserveAmount) > 0n || row.reserveAuthPending === false);
}

/**
 * Whether the chain needs no further read for this row: settled or timed out;
 * given up on and never opened once no reserve can land, with nothing signed
 * on it and no reserve the seller confirmed; or given up on and settled in
 * full once no top-up the buyer signed can land. Only a retired row can be
 * final short of settled or timed out: the buyer signs nothing more on a
 * session it gave up, while one it still uses can re-sign its reserve with a
 * new deadline and open after all, so it is read every pass until reconcile
 * retires it. Every deadline is the latest ReserveAuth's, a top-up's included.
 */
export function chainRecordFinal(row: BuyerChannelChainRow): boolean {
  const record = row.record;
  if (!record) return false;
  if (record.status === CHAIN_CHANNEL_STATUS.SETTLED || record.status === CHAIN_CHANNEL_STATUS.TIMED_OUT) return true;
  if (record.status === CHAIN_CHANNEL_STATUS.NONE) return row.status !== 'active' && noReserveCanLand(row, record.readAt) && !doubtfulNoRecord(row);
  return row.status !== 'active' && heldOnChain(record) === 0n && noReserveCanLand(row, record.readAt);
}

/** Whether a pass at `nowMs` reads this row: every row not final, a doubtful "never opened" only now and then. */
export function chainReadDue(row: BuyerChannelChainRow, nowMs: number): boolean {
  if (chainRecordFinal(row)) return false;
  return !doubtfulNoRecord(row) || nowMs - row.record!.readAt >= DOUBTFUL_RECORD_REREAD_MS;
}

/** A buyer's channel figures. Amounts are USDC base units. */
export interface BuyerChannelTotals {
  pending: bigint;
  held: bigint;
  /**
   * Reserve no stored channel explains (reserved − held), from a read that
   * covered every open channel at the same block as the reserve. Null when it
   * cannot be judged: no such read yet, or rows still unread.
   */
  unaccountedReserved: bigint | null;
  /** Rows with no chain record yet. */
  unread: number;
  /** Block and start time (ms) of the latest read; null before the first. */
  block: number | null;
  readAt: number | null;
  /** Not confirmed by a current read: rows unread, no read since the buyer started, or the last read failed. */
  stale: boolean;
}

/** The latest read that succeeded for a buyer. */
export interface ChannelChainPass {
  block: number;
  readAt: number;
  reserved: bigint | null;
}

/**
 * A buyer's totals. `pass` is the latest read that succeeded; `failed` says
 * a read after it failed, so what the records show may be out of date.
 */
export function buyerChannelTotals(rows: readonly BuyerChannelChainRow[], nowSeconds: number, pass: ChannelChainPass | null, failed = false): BuyerChannelTotals {
  let pending = 0n;
  let held = 0n;
  let unread = 0;
  let judged = pass !== null && !failed && pass.reserved !== null;
  for (const row of rows) {
    const figures = channelFigures(row, nowSeconds);
    pending += figures.pending;
    held += figures.held;
    if (figures.unread) unread += 1;
    // The reserve and an open channel read at different blocks do not add up,
    // nor does a reserve read before a record stored since (e.g. by the CLI's own withdraw).
    if (figures.held > 0n && row.record?.block !== pass?.block) judged = false;
    if (row.record && pass && row.record.block > pass.block) judged = false;
  }
  if (unread > 0) judged = false;
  return {
    pending,
    held,
    unaccountedReserved: judged ? (pass!.reserved! > held ? pass!.reserved! - held : 0n) : null,
    unread,
    block: pass?.block ?? null,
    readAt: pass?.readAt ?? null,
    // With no row left to count, nothing here waits on the chain.
    stale: unread > 0 || failed || (pass === null && rows.length > 0),
  };
}

/** Rows read per pass beyond the open ones, so an upgrade with a long history is read in steps. */
export const CHAIN_BACKFILL_BATCH = 240;

/**
 * Keeps a buyer's stored chain records up to date: each `refresh` reads every
 * row the chain may still change (open, closing, or a reserve still landing),
 * plus up to `batchSize` rows never read, at one block with the buyer's
 * reserve, stores what it read and marks the rows that became final. Per buyer,
 * at most one read runs and one more waits.
 */
export class BuyerChannelChainRecorder {
  private readonly store: ChannelChainRecordStore;
  private readonly read: ChannelChainReader;
  private readonly now: () => number;
  private readonly batchSize: number;
  private readonly passes = new Map<string, ChannelChainPass>();
  /** Buyers whose latest read failed. */
  private readonly failed = new Set<string>();
  private readonly running = new Map<string, Promise<void>>();
  /** The read that starts when the running one ends, for `fresh` callers. */
  private readonly waiting = new Map<string, Promise<void>>();
  /** When the latest read for each buyer started (ms). */
  private readonly started = new Map<string, number>();

  constructor(options: { store: ChannelChainRecordStore; read: ChannelChainReader; now?: () => number; batchSize?: number }) {
    this.store = options.store;
    this.read = options.read;
    this.now = options.now ?? Date.now;
    this.batchSize = Math.max(1, options.batchSize ?? CHAIN_BACKFILL_BATCH);
  }

  /**
   * Reads the chain for a buyer. Joins a read already running; with `fresh`
   * (the caller knows something changed) it waits for a read that starts
   * after the running one, which every later `fresh` caller joins too, so
   * callers asking in a loop never queue more than one read. With `floorMs`,
   * a fresh read is not started when the latest read for the buyer started
   * less than that long ago: the caller joins it if it still runs, else the
   * stored records answer. A failed read keeps the stored records and marks
   * the figures stale.
   */
  refresh(buyer: string, options: { fresh?: boolean; floorMs?: number } = {}): Promise<void> {
    const key = buyer.toLowerCase();
    const running = this.running.get(key);
    const started = this.started.get(key);
    if (options.fresh && options.floorMs !== undefined && started !== undefined && this.now() - started < options.floorMs) {
      return running ?? Promise.resolve();
    }
    if (!running) return this.start(buyer, key);
    if (!options.fresh) return running;
    const waiting = this.waiting.get(key);
    if (waiting) return waiting;
    const next = running.catch(() => undefined).then(() => {
      this.waiting.delete(key);
      return this.start(buyer, key);
    });
    this.waiting.set(key, next);
    return next;
  }

  private start(buyer: string, key: string): Promise<void> {
    this.started.set(key, this.now());
    const pass: Promise<void> = this.pass(buyer).finally(() => {
      if (this.running.get(key) === pass) this.running.delete(key);
    });
    this.running.set(key, pass);
    return pass;
  }

  /** The buyer's figures from the stored records, now; never waits for the chain. */
  totals(buyer: string): BuyerChannelTotals {
    const key = buyer.toLowerCase();
    return buyerChannelTotals(this.store.getBuyerChannelChainRows(buyer), Math.floor(this.now() / 1000), this.passes.get(key) ?? null, this.failed.has(key));
  }

  /** Stores a read the buyer made itself (e.g. at the block of its own requestClose), like a pass would. */
  record(sessionId: string, record: ChannelChainRecord): boolean {
    return this.store.recordChainState(sessionId, record);
  }

  /**
   * Reads these channels of the buyer now, at the head block, and stores what
   * the chain says, e.g. once a seller closed one. The reserve read with them
   * becomes the one the figures are judged against: an open channel read at
   * an earlier block then leaves the unaccounted reserve unjudged until the
   * next pass, rather than judged against a reserve from before the change.
   */
  async readChannels(buyer: string, channelIds: readonly string[]): Promise<void> {
    const ids = new Set(channelIds.map((id) => id.toLowerCase()));
    const rows = this.store.getBuyerChannelChainRows(buyer).filter((row) => ids.has(row.sessionId.toLowerCase()));
    if (rows.length === 0) return;
    const result = await this.read(buyer, rows.map((row) => ({ channelId: row.sessionId, seller: row.sellerEvmAddr })));
    this.keep(buyer, result);
    const pass = this.passes.get(buyer.toLowerCase());
    if (!pass || pass.block <= result.block) this.passes.set(buyer.toLowerCase(), { block: result.block, readAt: result.readAt, reserved: result.reserved });
  }

  /**
   * Whether a periodic pass has anything to do for the buyer: a row due for a
   * read; else its reserve, read once after the buyer starts and then every
   * `RESERVE_ONLY_READ_MS`. A buyer with no channel row at all (a new data
   * directory, a lost store) is read again only while its reserve is above
   * zero: that reserve is held by channels it has no row for, and is reported
   * as unaccounted until they are closed. One with no reserve costs one read
   * per start.
   */
  due(buyer: string): boolean {
    const nowMs = this.now();
    if (this.store.getBuyerChannelChainRows(buyer).some((row) => chainReadDue(row, nowMs))) return true;
    const key = buyer.toLowerCase();
    const pass = this.passes.get(key);
    if (!pass || this.failed.has(key)) return true;
    if (nowMs - pass.readAt < RESERVE_ONLY_READ_MS) return false;
    return this.store.hasBuyerChannels(buyer) || pass.reserved === null || pass.reserved > 0n;
  }

  /**
   * Reads every buyer `buyers()` names once per `intervalMs` while it is due,
   * spread over the interval rather than all at once. Returns the stop.
   */
  schedule(buyers: () => readonly string[], intervalMs: number): () => void {
    let stopped = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (run: () => void, ms: number): void => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!stopped) run();
      }, ms);
      (timer as { unref?: () => void }).unref?.();
      timers.add(timer);
    };
    const cycle = (): void => {
      const list = buyers();
      list.forEach((buyer, index) => later(() => {
        if (this.due(buyer)) void this.refresh(buyer).catch(() => undefined);
      }, Math.floor((index * intervalMs) / list.length)));
      later(cycle, intervalMs);
    };
    cycle();
    return () => {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  }

  /** `buyer` as the store keeps it (the identity's address); the maps key on its lowercase form. */
  private async pass(buyer: string): Promise<void> {
    const key = buyer.toLowerCase();
    const nowMs = this.now();
    const due = this.store.getBuyerChannelChainRows(buyer).filter((row) => chainReadDue(row, nowMs));
    const known = due.filter((row) => row.record !== null && !doubtfulNoRecord(row));
    // Beyond the rows that can change, a bounded batch: rows that count now
    // first (a session in use, or one given up since records existed), then
    // doubtful "never opened" reads, then rows an upgrade left unread.
    const rest = [
      ...due.filter((row) => row.record === null && !row.backfill),
      ...due.filter((row) => doubtfulNoRecord(row)),
      ...due.filter((row) => row.record === null && row.backfill),
    ];
    const batch = [...known, ...rest.slice(0, this.batchSize)].map((row) => ({ channelId: row.sessionId, seller: row.sellerEvmAddr }));
    let result: ChannelChainRead;
    try {
      result = await this.read(buyer, batch);
    } catch (err) {
      this.failed.add(key);
      throw err;
    }
    this.keep(buyer, result);
    // A read at a later block (a close the buyer just read) keeps its reserve.
    const previous = this.passes.get(key);
    if (!previous || previous.block <= result.block) this.passes.set(key, { block: result.block, readAt: result.readAt, reserved: result.reserved });
    this.failed.delete(key);
  }

  /** Stores what a read returned and marks the rows it made final. */
  private keep(buyer: string, result: ChannelChainRead): void {
    for (const [channelId, state] of result.channels) {
      this.store.recordChainState(channelId, { ...state, block: result.block, readAt: result.readAt });
    }
    const final = this.store.getBuyerChannelChainRows(buyer).filter(chainRecordFinal).map((row) => row.sessionId);
    if (final.length > 0) this.store.markChainFinal(final);
  }
}
