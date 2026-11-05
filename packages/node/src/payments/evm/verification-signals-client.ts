import { Interface, getAddress, type AbstractProvider } from 'ethers';
import { createCachedMulticallReader, type MulticallRequest } from './multicall.js';
import { KBF_AUDITS_ABI, VERIFICATION_RESULTS_ABI, VERIFIER_VERDICT, serviceHash } from './verifier-client.js';
import { verificationServiceKey } from '../../reputation/model-reputation.js';

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

const RESULTS_IFACE = new Interface(VERIFICATION_RESULTS_ABI);
const KBF_IFACE = new Interface(KBF_AUDITS_ABI);
const GATE_IFACE = new Interface(['function currentEpoch() view returns (uint256)']);

function first(result: unknown[] | null | undefined): unknown {
  return result && result.length > 0 ? result[0] : undefined;
}

export class VerificationSignalsClient {
  private readonly _read: (requests: MulticallRequest[]) => Promise<Array<unknown[] | null>>;
  private _emissionsGate: string | undefined;
  private _resultsAddress: string | undefined;

  /**
   * @param _verificationAddress The KBF audits contract (`verificationContractAddress`).
   * @param resultsAddress The results layer; read from `kbf.results()` on first use when absent.
   */
  constructor(
    provider: AbstractProvider,
    private readonly _verificationAddress: string,
    resultsAddress?: string,
  ) {
    this._read = createCachedMulticallReader(provider);
    if (resultsAddress) this._resultsAddress = getAddress(resultsAddress);
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
    const out = new Map<number, string[]>();
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
    for (const [agentId, keys] of agents) {
      for (const key of keys) {
        statusCalls.push({ agentId, key, index: requests.length });
        requests.push({ target, iface: RESULTS_IFACE, method: 'serviceStatus', args: [BigInt(agentId), serviceHash(key)] });
      }
    }
    const results = await this._read(requests);
    if (needsGate) {
      const gate = first(results[0]);
      if (typeof gate !== 'string') throw new Error('verification emissionsGate read failed');
      this._emissionsGate = getAddress(gate);
    }
    const [epochResult] = await this._read([{ target: this._emissionsGate!, iface: GATE_IFACE, method: 'currentEpoch' }]);
    const currentEpoch = first(epochResult);
    if (typeof currentEpoch !== 'bigint') throw new Error('emissions gate currentEpoch read failed');

    const failed = new Set<number>();
    for (const [agentId] of agents) out.set(agentId, []);
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
      if (verdict === VERDICT_DIFF && currentEpoch < validUntil) out.get(call.agentId)!.push(call.key);
    }
    for (const agentId of failed) out.delete(agentId);
    for (const keys of out.values()) keys.sort();
    return out;
  }
}
