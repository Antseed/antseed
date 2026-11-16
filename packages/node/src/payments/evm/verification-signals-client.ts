import { Interface, getAddress, type AbstractProvider } from 'ethers';
import { createCachedMulticallReader, type MulticallRequest } from './multicall.js';
import { KBF_AUDITS_ABI, VERIFICATION_RESULTS_ABI, VERIFIER_VERDICT, serviceHash } from './verifier-client.js';
import { verificationServiceKey } from '../../reputation/model-reputation.js';
import { verificationPointsMultiplierBps, type VerificationPointsRates } from '../../reputation/verification-points.js';

/**
 * Reads which advertised services of a batch of sellers have a live DIFF
 * verdict on `AntseedVerificationResults`, the verification results layer,
 * whatever verification method (audit) recorded it. Two Multicall3 round
 * trips per read, plus one on the first read when the results address has to
 * be discovered from the KBF audits contract (`kbf.results()`, cached):
 *
 *   round 1: results.emissionsGate (first read only; it is immutable), and per
 *            (agentId, service) results.serviceStatus
 *   round 2: emissionsGate.currentEpoch
 *
 * `serviceStatus` holds only recorded results. KBF records a DIFF once
 * `requiredReports[DIFF]` (2 on Base) distinct approved auditors report it in
 * the same epoch and report round; a DIFF still waiting for its second auditor
 * stays in the KBF contract's report counts and leaves `serviceStatus` at the
 * previous result, so it never cuts reputation here.
 *
 * A recorded verdict is live exactly as the contract counts it:
 * `currentEpoch < verdict.validUntilEpoch`, the expiry the recording audit
 * chose. SAME, UNDETERMINED, NONE and expired verdicts are not DIFF.
 */

export interface VerificationServiceQuery {
  agentId: number;
  /** Advertised service names; matched the way the contract hashes them. */
  services: readonly string[];
}

const VERDICT_DIFF = BigInt(VERIFIER_VERDICT.DIFF);
const VERDICT_SAME = BigInt(VERIFIER_VERDICT.SAME);

/** Live verdicts of one agent's advertised services, as verification keys. */
export interface ServiceVerdicts {
  diff: string[];
  same: string[];
  /**
   * The agent's whole on-chain status (every service with a live verdict, advertised or not)
   * and the points multiplier the verification policy gives it; absent when unread.
   */
  agent?: { sameCount: number; diffCount: number; pointsMultiplierBps: number | null };
}

/** How long the policy's rates are reused; they change only by an owner transaction. */
export const VERIFICATION_RATES_TTL_MS = 60 * 60_000;

const RESULTS_IFACE = new Interface(VERIFICATION_RESULTS_ABI);
const KBF_IFACE = new Interface(KBF_AUDITS_ABI);
const GATE_IFACE = new Interface(['function currentEpoch() view returns (uint256)']);
const POLICY_IFACE = new Interface(['function bonusBps() view returns (uint256)', 'function penaltyBps() view returns (uint256)']);

function first(result: unknown[] | null | undefined): unknown {
  return result && result.length > 0 ? result[0] : undefined;
}

export class VerificationSignalsClient {
  private readonly _read: (requests: MulticallRequest[]) => Promise<Array<unknown[] | null>>;
  private _emissionsGate: string | undefined;
  private _resultsAddress: string | undefined;
  private readonly _policyAddress: string | undefined;
  private _rates: { value: VerificationPointsRates; readAt: number } | undefined;

  /**
   * @param _verificationAddress The KBF audits contract (`verificationContractAddress`).
   * @param resultsAddress The results layer; read from `kbf.results()` on first use when absent.
   * @param policyAddress The verification points policy; without it no multiplier is read.
   */
  constructor(
    provider: AbstractProvider,
    private readonly _verificationAddress: string,
    resultsAddress?: string,
    policyAddress?: string,
    private readonly _now: () => number = Date.now,
  ) {
    this._read = createCachedMulticallReader(provider);
    if (resultsAddress) this._resultsAddress = getAddress(resultsAddress);
    if (policyAddress) this._policyAddress = getAddress(policyAddress);
  }

  /** The results layer address, discovered once from the KBF contract when not configured. */
  private async _results(): Promise<string> {
    if (this._resultsAddress) return this._resultsAddress;
    const [result] = await this._read([{ target: this._verificationAddress, iface: KBF_IFACE, method: 'results' }]);
    const address = first(result);
    if (typeof address !== 'string') throw new Error('verification results() read failed');
    this._resultsAddress = getAddress(address);
    return this._resultsAddress;
  }

  /**
   * Live DIFF services per agent id, as verification keys (trimmed,
   * lowercased service names). An agent is missing from the result when any
   * of its reads failed, so a caller can keep its previous answer instead of
   * clearing a penalty on an RPC hiccup. Throws when the current epoch
   * cannot be read at all.
   */
  async readDiffServices(queries: readonly VerificationServiceQuery[]): Promise<Map<number, string[]>> {
    const verdicts = await this.readServiceVerdicts(queries);
    return new Map([...verdicts].map(([agentId, entry]) => [agentId, entry.diff]));
  }

  /**
   * Live DIFF and SAME services per agent id, from the same reads as
   * `readDiffServices`. The same failure rules apply.
   */
  async readServiceVerdicts(queries: readonly VerificationServiceQuery[]): Promise<Map<number, ServiceVerdicts>> {
    const out = new Map<number, ServiceVerdicts>();
    const agents = new Map<number, string[]>();
    for (const query of queries) {
      if (!Number.isSafeInteger(query.agentId) || query.agentId <= 0) continue;
      const keys = agents.get(query.agentId) ?? [];
      for (const service of query.services) {
        const key = verificationServiceKey(service);
        if (key.length > 0 && !keys.includes(key)) keys.push(key);
      }
      agents.set(query.agentId, keys);
    }
    if (agents.size === 0) return out;

    const target = await this._results();
    const requests: MulticallRequest[] = [];
    const needsGate = this._emissionsGate === undefined;
    if (needsGate) requests.push({ target, iface: RESULTS_IFACE, method: 'emissionsGate' });
    const statusCalls: Array<{ agentId: number; key: string; index: number }> = [];
    const agentCalls = new Map<number, number>();
    for (const [agentId, keys] of agents) {
      for (const key of keys) {
        statusCalls.push({ agentId, key, index: requests.length });
        requests.push({ target, iface: RESULTS_IFACE, method: 'serviceStatus', args: [BigInt(agentId), serviceHash(key)] });
      }
      agentCalls.set(agentId, requests.length);
      requests.push({ target, iface: RESULTS_IFACE, method: 'agentStatus', args: [BigInt(agentId)] });
    }
    // The policy's rates ride along at most once an hour.
    const needsRates = this._policyAddress !== undefined
      && (this._rates === undefined || this._now() - this._rates.readAt >= VERIFICATION_RATES_TTL_MS);
    const ratesIndex = requests.length;
    if (needsRates) {
      requests.push({ target: this._policyAddress!, iface: POLICY_IFACE, method: 'bonusBps' });
      requests.push({ target: this._policyAddress!, iface: POLICY_IFACE, method: 'penaltyBps' });
    }
    const results = await this._read(requests);
    if (needsRates) {
      const bonus = first(results[ratesIndex]);
      const penalty = first(results[ratesIndex + 1]);
      // A failed read keeps the last good rates.
      if (typeof bonus === 'bigint' && typeof penalty === 'bigint') {
        this._rates = { value: { bonusBps: bonus, penaltyBps: penalty }, readAt: this._now() };
      }
    }
    if (needsGate) {
      const gate = first(results[0]);
      if (typeof gate !== 'string') throw new Error('verification emissionsGate read failed');
      this._emissionsGate = getAddress(gate);
    }
    const [epochResult] = await this._read([{ target: this._emissionsGate!, iface: GATE_IFACE, method: 'currentEpoch' }]);
    const currentEpoch = first(epochResult);
    if (typeof currentEpoch !== 'bigint') throw new Error('emissions gate currentEpoch read failed');

    const failed = new Set<number>();
    for (const [agentId] of agents) out.set(agentId, { diff: [], same: [] });
    for (const call of statusCalls) {
      const status = first(results[call.index]) as { verdict?: unknown; validUntilEpoch?: unknown; [index: number]: unknown } | undefined;
      if (!status) {
        failed.add(call.agentId);
        continue;
      }
      const verdict = status.verdict ?? status[1];
      const validUntil = status.validUntilEpoch ?? status[5];
      if (typeof verdict !== 'bigint' || typeof validUntil !== 'bigint') {
        failed.add(call.agentId);
        continue;
      }
      if (currentEpoch >= validUntil) continue;
      if (verdict === VERDICT_DIFF) out.get(call.agentId)!.diff.push(call.key);
      else if (verdict === VERDICT_SAME) out.get(call.agentId)!.same.push(call.key);
    }
    for (const [agentId, index] of agentCalls) {
      const entry = out.get(agentId);
      const status = first(results[index]) as { verifiedCount?: unknown; diffCount?: unknown; [index: number]: unknown } | undefined;
      const sameCount = status?.verifiedCount ?? status?.[0];
      const diffCount = status?.diffCount ?? status?.[1];
      if (!entry) continue;
      // Without the agent's status the result is partial: drop the agent, so the caller keeps
      // its last good answer (penalty included) instead of clearing it.
      if ((typeof sameCount !== 'bigint' && typeof sameCount !== 'number') || (typeof diffCount !== 'bigint' && typeof diffCount !== 'number')) {
        failed.add(agentId);
        continue;
      }
      const same = Number(sameCount);
      const diff = Number(diffCount);
      entry.agent = {
        sameCount: same,
        diffCount: diff,
        pointsMultiplierBps: this._rates ? verificationPointsMultiplierBps(same, diff, this._rates.value) : null,
      };
    }
    for (const agentId of failed) out.delete(agentId);
    for (const entry of out.values()) {
      entry.diff.sort();
      entry.same.sort();
    }
    return out;
  }
}
