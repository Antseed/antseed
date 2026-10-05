import { Interface, type AbstractProvider } from 'ethers';
import { multicallRead, MULTICALL3_ADDRESS, type MulticallRequest } from './multicall.js';

/**
 * Reads every on-chain input of the buyer trust score for a batch of sellers
 * in two Multicall3 round trips, regardless of batch size:
 *
 *   round 1: usage.currentEpoch, and per seller
 *            registry.getAgentId, wash.isProvenWashTrader, wash.provenWashShareBps
 *   round 2: pools.totalPowerWeightAtEpoch, usage.totalPoolPointsByEpoch(last),
 *            and per seller channels.getAgentStats, pools.poolWeightAtEpoch,
 *            pools.poolActiveStakeAtEpoch, usage.sellerPointsByEpoch(last)
 *
 * Each round is chunked at 80 calls per `eth_call`. Contracts that are not
 * configured (older chains without the recognized-usage stack) are skipped
 * and their signals come back `undefined`.
 */

export interface TrustSignalsAddresses {
  /** `AntseedSellerRegistry` (or legacy `AntseedStaking`): `getAgentId`. */
  sellerRegistry: string;
  /** `AntseedChannels`: `getAgentStats`. */
  channels: string;
  /** `AntseedSellerPools`: pool power and active stake. */
  sellerPools?: string;
  /** `AntseedUsageAccounting`: epoch and recognized seller points. */
  usageAccounting?: string;
  /** `AntseedWashTradingRegistry`: proven wash-trader verdicts. */
  washTradingRegistry?: string;
}

export interface TrustSignals {
  agentId: number;
  channelCount?: number;
  ghostCount?: number;
  totalVolumeUsdcMicros?: number;
  lastSettledAtSec?: number;
  usageEpoch?: number;
  usageShareBps?: number;
  usageLastEpochUsdcMicros?: number;
  poolStakeAnts?: number;
  poolPowerShareBps?: number;
  washFlagged?: boolean;
  washShareBps?: number;
}

const REGISTRY_IFACE = new Interface(['function getAgentId(address seller) view returns (uint256)']);
const CHANNELS_IFACE = new Interface(['function getAgentStats(uint256 agentId) view returns (uint64 channelCount, uint64 ghostCount, uint256 totalVolumeUsdc, uint64 lastSettledAt)']);
const POOLS_IFACE = new Interface([
  'function poolWeightAtEpoch(uint256 agentId, uint256 epoch) view returns (uint256)',
  'function poolActiveStakeAtEpoch(uint256 agentId, uint256 epoch) view returns (uint256)',
  'function totalPowerWeightAtEpoch(uint256 epoch) view returns (uint256)',
]);
const USAGE_IFACE = new Interface([
  'function currentEpoch() view returns (uint256)',
  'function sellerPointsByEpoch(uint256 epoch, address seller) view returns (uint256)',
  'function totalPoolPointsByEpoch(uint256 epoch) view returns (uint256)',
]);
const WASH_IFACE = new Interface([
  'function isProvenWashTrader(address seller) view returns (bool)',
  'function provenWashShareBps(address seller) view returns (uint256)',
]);

const ANTS_WEI = 10n ** 18n;

function toSafeNumber(value: unknown): number | undefined {
  if (typeof value !== 'bigint') return undefined;
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : Number.MAX_SAFE_INTEGER;
}

function shareBps(part: bigint, total: bigint): number {
  return total > 0n ? Number((part * 10_000n) / total) : 0;
}

function weiToAnts(wei: bigint): number {
  return Number(wei / ANTS_WEI) + Number(wei % ANTS_WEI) / 1e18;
}

/**
 * Collects the calls of one round and hands back a lookup for their results,
 * so callers address results by the handle they got when queueing instead of
 * by computed offsets.
 */
class Round {
  readonly requests: MulticallRequest[] = [];
  private results: Array<unknown[] | null> = [];

  add(target: string, iface: Interface, method: string, args: unknown[] = []): number {
    this.requests.push({ target, iface, method, args });
    return this.requests.length - 1;
  }

  async run(read: (requests: MulticallRequest[]) => Promise<Array<unknown[] | null>>): Promise<void> {
    this.results = this.requests.length > 0 ? await read(this.requests) : [];
  }

  /** First decoded return value of a call, or `undefined` when it failed or was not queued. */
  value(handle: number | undefined): unknown {
    if (handle === undefined) return undefined;
    const result = this.results[handle];
    return result && result.length > 0 ? result[0] : undefined;
  }

  /** All decoded return values of a call, or `undefined` when it failed. */
  values(handle: number): unknown[] | undefined {
    return this.results[handle] ?? undefined;
  }
}

export class TrustSignalsClient {
  private _multicallAvailable: Promise<boolean> | undefined;

  constructor(
    private readonly _provider: AbstractProvider,
    private readonly _addresses: TrustSignalsAddresses,
  ) {}

  private async _read(requests: MulticallRequest[]): Promise<Array<unknown[] | null>> {
    // `multicallRead` probes for Multicall3 with `eth_getCode` on every call;
    // remember the answer so a discovery cycle costs only the batched reads.
    this._multicallAvailable ??= this._provider.getCode(MULTICALL3_ADDRESS).then((code) => code !== '0x').catch(() => false);
    if (await this._multicallAvailable) return multicallRead(this._provider, requests, { assumeDeployed: true });
    return Promise.all(requests.map(async (request) => {
      try {
        const data = await this._provider.call({ to: request.target, data: request.iface.encodeFunctionData(request.method, request.args ?? []) });
        return [...request.iface.decodeFunctionResult(request.method, data)];
      } catch {
        return null;
      }
    }));
  }

  /**
   * Read trust signals for `sellers` (EVM addresses). Sellers without an agent
   * id are omitted from the result.
   */
  async read(sellers: readonly string[]): Promise<Map<string, TrustSignals>> {
    const out = new Map<string, TrustSignals>();
    if (sellers.length === 0) return out;
    const { sellerRegistry, channels, sellerPools, usageAccounting, washTradingRegistry } = this._addresses;

    // Round 1: agent ids, wash verdicts, current epoch.
    const round1 = new Round();
    const epochCall = usageAccounting ? round1.add(usageAccounting, USAGE_IFACE, 'currentEpoch') : undefined;
    const round1Calls = sellers.map((seller) => ({
      seller,
      agentId: round1.add(sellerRegistry, REGISTRY_IFACE, 'getAgentId', [seller]),
      washFlagged: washTradingRegistry ? round1.add(washTradingRegistry, WASH_IFACE, 'isProvenWashTrader', [seller]) : undefined,
      washShare: washTradingRegistry ? round1.add(washTradingRegistry, WASH_IFACE, 'provenWashShareBps', [seller]) : undefined,
    }));
    await round1.run((requests) => this._read(requests));

    const epoch = toSafeNumber(round1.value(epochCall));
    const agentIds = new Map<string, number>();
    for (const call of round1Calls) {
      const agentId = toSafeNumber(round1.value(call.agentId));
      if (!agentId || agentId <= 0) continue;
      agentIds.set(call.seller, agentId);
      const signals: TrustSignals = { agentId };
      const flagged = round1.value(call.washFlagged);
      if (typeof flagged === 'boolean') signals.washFlagged = flagged;
      const share = toSafeNumber(round1.value(call.washShare));
      if (share !== undefined) signals.washShareBps = share;
      out.set(call.seller, signals);
    }
    if (agentIds.size === 0) return out;

    // Round 2: channel stats, pool power, last epoch's recognized usage.
    const poolsEnabled = Boolean(sellerPools) && epoch !== undefined;
    const usageEnabled = Boolean(usageAccounting) && epoch !== undefined;
    const lastEpoch = epoch === undefined ? 0 : Math.max(0, epoch - 1);
    const round2 = new Round();
    const totalPowerCall = poolsEnabled ? round2.add(sellerPools!, POOLS_IFACE, 'totalPowerWeightAtEpoch', [epoch]) : undefined;
    const totalPointsCall = usageEnabled ? round2.add(usageAccounting!, USAGE_IFACE, 'totalPoolPointsByEpoch', [lastEpoch]) : undefined;
    const round2Calls = [...agentIds].map(([seller, agentId]) => ({
      seller,
      stats: round2.add(channels, CHANNELS_IFACE, 'getAgentStats', [agentId]),
      power: poolsEnabled ? round2.add(sellerPools!, POOLS_IFACE, 'poolWeightAtEpoch', [agentId, epoch]) : undefined,
      stake: poolsEnabled ? round2.add(sellerPools!, POOLS_IFACE, 'poolActiveStakeAtEpoch', [agentId, epoch]) : undefined,
      points: usageEnabled ? round2.add(usageAccounting!, USAGE_IFACE, 'sellerPointsByEpoch', [lastEpoch, seller]) : undefined,
    }));
    await round2.run((requests) => this._read(requests));

    const totalPower = round2.value(totalPowerCall);
    const totalPoints = round2.value(totalPointsCall);
    for (const call of round2Calls) {
      const signals = out.get(call.seller)!;
      const stats = round2.values(call.stats);
      if (stats && stats.length >= 4) {
        signals.channelCount = toSafeNumber(stats[0]);
        signals.ghostCount = toSafeNumber(stats[1]);
        signals.totalVolumeUsdcMicros = toSafeNumber(stats[2]);
        signals.lastSettledAtSec = toSafeNumber(stats[3]);
      }
      const power = round2.value(call.power);
      if (typeof power === 'bigint' && typeof totalPower === 'bigint') signals.poolPowerShareBps = shareBps(power, totalPower);
      const stake = round2.value(call.stake);
      if (typeof stake === 'bigint') signals.poolStakeAnts = weiToAnts(stake);
      const points = round2.value(call.points);
      if (typeof points === 'bigint' && typeof totalPoints === 'bigint' && epoch !== undefined) {
        signals.usageEpoch = epoch;
        // Epoch 0 has no previous epoch to score.
        signals.usageLastEpochUsdcMicros = epoch === 0 ? 0 : toSafeNumber(points);
        signals.usageShareBps = epoch === 0 ? 0 : shareBps(points, totalPoints);
      }
    }
    return out;
  }
}
