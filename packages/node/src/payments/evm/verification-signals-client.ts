import { Interface, getAddress, type AbstractProvider } from 'ethers';
import { createCachedMulticallReader, type MulticallRequest } from './multicall.js';
import { VERIFICATION_ABI, VERIFIER_VERDICT, serviceHash } from './verifier-client.js';
import { verificationServiceKey } from '../../reputation/model-reputation.js';

/**
 * Reads which advertised services of a batch of sellers have a live DIFF
 * verdict on `AntseedKbfVerification`, in at most two Multicall3 round trips:
 *
 *   round 1: verification.validityEpochs, verification.emissionsGate (first
 *            read only; it is immutable), and per (agentId, service)
 *            verification.serviceStatus
 *   round 2: emissionsGate.currentEpoch
 *
 * `serviceStatus` holds only recorded results. A DIFF is recorded once
 * `requiredReports[DIFF]` (2 on Base) distinct approved auditors report it in
 * the same epoch and report round; a DIFF still waiting for its second auditor
 * stays in the contract's report counts and leaves `serviceStatus` at the
 * previous result, so it never cuts reputation here.
 *
 * A recorded verdict is live exactly as the contract counts it:
 * `currentEpoch < verdict.epoch + validityEpochs`. SAME, UNDETERMINED, NONE
 * and expired verdicts are not DIFF.
 */

export interface VerificationServiceQuery {
  agentId: number;
  /** Advertised service names; matched the way the contract hashes them. */
  services: readonly string[];
}

const VERDICT_DIFF = BigInt(VERIFIER_VERDICT.DIFF);

const VERIFICATION_IFACE = new Interface(VERIFICATION_ABI);
const GATE_IFACE = new Interface(['function currentEpoch() view returns (uint256)']);

function first(result: unknown[] | null | undefined): unknown {
  return result && result.length > 0 ? result[0] : undefined;
}

export class VerificationSignalsClient {
  private readonly _read: (requests: MulticallRequest[]) => Promise<Array<unknown[] | null>>;
  private _emissionsGate: string | undefined;

  constructor(
    provider: AbstractProvider,
    private readonly _verificationAddress: string,
  ) {
    this._read = createCachedMulticallReader(provider);
  }

  /**
   * Live DIFF services per agent id, as verification keys (trimmed,
   * lowercased service names). An agent is missing from the result when any
   * of its reads failed, so a caller can keep its previous answer instead of
   * clearing a penalty on an RPC hiccup. Throws when the epoch or validity
   * window cannot be read at all.
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

    const target = this._verificationAddress;
    const requests: MulticallRequest[] = [{ target, iface: VERIFICATION_IFACE, method: 'validityEpochs' }];
    const needsGate = this._emissionsGate === undefined;
    if (needsGate) requests.push({ target, iface: VERIFICATION_IFACE, method: 'emissionsGate' });
    const statusCalls: Array<{ agentId: number; key: string; index: number }> = [];
    for (const [agentId, keys] of agents) {
      for (const key of keys) {
        statusCalls.push({ agentId, key, index: requests.length });
        requests.push({ target, iface: VERIFICATION_IFACE, method: 'serviceStatus', args: [BigInt(agentId), serviceHash(key)] });
      }
    }
    const results = await this._read(requests);
    const validity = first(results[0]);
    if (typeof validity !== 'bigint') throw new Error('verification validityEpochs read failed');
    if (needsGate) {
      const gate = first(results[1]);
      if (typeof gate !== 'string') throw new Error('verification emissionsGate read failed');
      this._emissionsGate = getAddress(gate);
    }
    const [epochResult] = await this._read([{ target: this._emissionsGate!, iface: GATE_IFACE, method: 'currentEpoch' }]);
    const currentEpoch = first(epochResult);
    if (typeof currentEpoch !== 'bigint') throw new Error('emissions gate currentEpoch read failed');

    const failed = new Set<number>();
    for (const [agentId] of agents) out.set(agentId, []);
    for (const call of statusCalls) {
      const status = first(results[call.index]) as { verdict?: unknown; epoch?: unknown; [index: number]: unknown } | undefined;
      if (!status) {
        failed.add(call.agentId);
        continue;
      }
      const verdict = status.verdict ?? status[1];
      const epoch = status.epoch ?? status[3];
      if (typeof verdict !== 'bigint' || typeof epoch !== 'bigint') {
        failed.add(call.agentId);
        continue;
      }
      if (verdict === VERDICT_DIFF && currentEpoch < epoch + validity) out.get(call.agentId)!.push(call.key);
    }
    for (const agentId of failed) out.delete(agentId);
    for (const keys of out.values()) keys.sort();
    return out;
  }
}
