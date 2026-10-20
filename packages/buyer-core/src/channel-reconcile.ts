import {
  CHANNEL_KIND,
  CHANNEL_ROLE,
  CHANNEL_STATUS,
  type BuyerChannelStore,
  type StoredChannel,
} from './channel-store-types.js';
import type { ChannelsClient } from './channels-client.js';
import { classifyOnChainChannel, type OnChainChannelState } from './channel-session-state.js';
import { debugWarn } from './debug.js';

/**
 * reserve() reverts once block time passes its ReserveAuth deadline. Past the
 * latest deadline the buyer signed, plus this margin, a channel the chain does
 * not know can never open. The margin is an hour, not minutes, because the
 * deadline is checked against chain time and the read time comes from this
 * machine's clock: a clock running ahead must not ghost a reserve that can
 * still land.
 */
const RESERVE_LANDING_GRACE_SECS = 60 * 60;

/** How the chain says a stored channel ended. A closed or withdrawn channel carries what the seller was paid; a never-opened one has nothing. */
export type ChannelClosure =
  | { status: typeof CHANNEL_STATUS.SETTLED | typeof CHANNEL_STATUS.TIMEOUT; settledAmount: bigint }
  | { status: typeof CHANNEL_STATUS.GHOST };

/** One chain read and when it was taken. A read from before a deadline proves nothing, however late it is applied. */
interface ChainReading {
  state: OnChainChannelState;
  readAtSec: number;
}

/**
 * What a process holding live buyer sessions tells the reconcile. Without it
 * the reconcile assumes this process holds no session (the CLI).
 */
export interface LivePaymentSessions {
  /** May this seller's current session row be retired now, with this outcome? */
  mayEndSession(peerId: string, closure: ChannelClosure): boolean;
  /** The seller's current row was retired and it has no active row left: drop its in-memory state. */
  sessionEnded(peerId: string): void;
  /** A one-off row was retired: drop its in-memory state. */
  oneOffEnded(channelId: string): void;
}

export interface ReconcileStoredChannelsOptions {
  store: Pick<BuyerChannelStore, 'getActiveChannelsByBuyer' | 'getActiveChannelByPeerAndBuyer' | 'updateChannelStatus'>;
  /** Null when the chain cannot be read now: nothing is read or retired, and every row counts as unchecked. */
  channels: Pick<ChannelsClient, 'getSession'> | null;
  buyerEvmAddr: string;
  sessions?: LivePaymentSessions;
}

export interface ChannelReconcileResult {
  retired: ReadonlyArray<{ channelId: string; peerId: string; status: ChannelClosure['status'] }>;
  /** Active rows this pass did not read or could not trust. They stay active. */
  unchecked: number;
  /** Why a chain read failed. The pass stopped reading there. */
  readError?: string;
}

/**
 * Retire this buyer's active paid and one-off rows that the chain shows can
 * never move money again. Reads every row, oldest first, and stops at the
 * first failed read. Idempotent: a second run finds nothing to retire.
 * Never leaves a seller with a different active channel than it had.
 */
export async function reconcileStoredChannels(options: ReconcileStoredChannelsOptions): Promise<ChannelReconcileResult> {
  const { readings, readError } = await readChain(options);
  const result = applyReadings(options, readings);
  return readError === undefined ? result : { ...result, readError };
}

function activeRows(o: ReconcileStoredChannelsOptions, kind: typeof CHANNEL_KIND.PAID | typeof CHANNEL_KIND.ONE_OFF): StoredChannel[] {
  return o.store.getActiveChannelsByBuyer(CHANNEL_ROLE.BUYER, o.buyerEvmAddr, kind);
}

async function readChain(o: ReconcileStoredChannelsOptions): Promise<{ readings: Map<string, ChainReading>; readError?: string }> {
  const readings = new Map<string, ChainReading>();
  if (!o.channels) return { readings };
  const rows = [...activeRows(o, CHANNEL_KIND.PAID), ...activeRows(o, CHANNEL_KIND.ONE_OFF)]
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const row of rows) {
    const readAtSec = Math.floor(Date.now() / 1000);
    let state: OnChainChannelState;
    try {
      state = classifyOnChainChannel(await o.channels.getSession(row.sessionId));
    } catch (err) {
      const readError = err instanceof Error ? err.message : String(err);
      debugWarn(`[ChannelReconcile] Failed to read channel ${row.sessionId.slice(0, 18)}...: ${readError}`);
      return { readings, readError };
    }
    if (state.exists && state.channel.buyer.toLowerCase() !== o.buyerEvmAddr.toLowerCase()) {
      debugWarn(`[ChannelReconcile] Channel ${row.sessionId.slice(0, 18)}... belongs to buyer ${state.channel.buyer} on-chain; left as it is`);
      continue;
    }
    readings.set(row.sessionId, { state, readAtSec });
  }
  return { readings };
}

function applyReadings(o: ReconcileStoredChannelsOptions, readings: Map<string, ChainReading>): ChannelReconcileResult {
  const retired: Array<ChannelReconcileResult['retired'][number]> = [];
  let unchecked = 0;
  const closureOf = (row: StoredChannel): ChannelClosure | null => {
    const reading = readings.get(row.sessionId);
    if (!reading) {
      unchecked += 1;
      return null;
    }
    return closureFromChain(row, reading);
  };
  const retire = (row: StoredChannel, closure: ChannelClosure): void => {
    o.store.updateChannelStatus(
      row.sessionId,
      closure.status,
      closure.status === CHANNEL_STATUS.GHOST ? undefined : closure.settledAmount.toString(),
    );
    retired.push({ channelId: row.sessionId, peerId: row.peerId, status: closure.status });
  };

  for (const row of activeRows(o, CHANNEL_KIND.ONE_OFF)) {
    const closure = closureOf(row);
    if (!closure) continue;
    retire(row, closure);
    o.sessions?.oneOffEnded(row.sessionId);
  }

  const paidByPeer = new Map<string, StoredChannel[]>();
  for (const row of activeRows(o, CHANNEL_KIND.PAID)) {
    paidByPeer.set(row.peerId, [...(paidByPeer.get(row.peerId) ?? []), row]);
  }
  for (const [peerId, rows] of paidByPeer) {
    const currentId = o.store.getActiveChannelByPeerAndBuyer(peerId, CHANNEL_ROLE.BUYER, o.buyerEvmAddr)?.sessionId;
    let current: StoredChannel | null = null;
    let olderSurvives = false;
    for (const row of rows) {
      if (row.sessionId === currentId) {
        current = row;
        continue;
      }
      const closure = closureOf(row);
      if (closure) retire(row, closure);
      else olderSurvives = true;
    }
    if (!current) continue;
    const closure = closureOf(current);
    // I1: with an older active row left, retiring the current one would make
    // that row "the session" while per-peer memory still describes the retired
    // channel, so the next SpendingAuth would carry one channel's cumulative on another.
    if (!closure || olderSurvives) continue;
    if (o.sessions && !o.sessions.mayEndSession(peerId, closure)) continue;
    retire(current, closure);
    o.sessions?.sessionEnded(peerId);
  }

  return { retired, unchecked };
}

/**
 * I2: only a channel that can never move money again is retired. Every
 * contract mutator reverts on Settled and TimedOut. A channel the chain does
 * not know is dead only once no ReserveAuth the buyer signed can open it.
 */
function closureFromChain(row: StoredChannel, reading: ChainReading): ChannelClosure | null {
  const { state } = reading;
  switch (state.status) {
    case CHANNEL_STATUS.SETTLED:
    case CHANNEL_STATUS.TIMEOUT:
      return { status: state.status, settledAmount: state.channel.settled };
    case 'missing':
      return reserveCanNeverLand(row, reading.readAtSec) ? { status: CHANNEL_STATUS.GHOST } : null;
    case CHANNEL_STATUS.ACTIVE:
    case 'unknown':
      return null;
  }
}

/**
 * A reserve the seller once confirmed (or a row without recovery fields) that
 * reads missing means the read is wrong, for example a changed channels
 * address, so it never counts.
 */
function reserveCanNeverLand(row: StoredChannel, readAtSec: number): boolean {
  const neverConfirmed = row.reserveAuthPending === true && BigInt(row.confirmedReserveAmount ?? '0') === 0n;
  const lastDeadline = Math.max(row.deadline, row.latestReserveDeadline ?? 0);
  return neverConfirmed && readAtSec > lastDeadline + RESERVE_LANDING_GRACE_SECS;
}
