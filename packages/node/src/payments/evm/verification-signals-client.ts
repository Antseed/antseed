import { Interface, getAddress, keccak256, toUtf8Bytes, type AbstractProvider } from 'ethers';
import { multicallRead, MULTICALL3_ADDRESS, type MulticallRequest } from './multicall.js';
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
 * A verdict is live exactly as the contract counts it:
 * `currentEpoch < verdict.epoch + validityEpochs`. SAME, UNDETERMINED, NONE
 * and expired verdicts are not DIFF.
 */

export interface VerificationServiceQuery {
  agentId: number;
  /** Advertised service names; matched the way the contract hashes them. */
  services: readonly string[];
}

/** Mirrors IAntseedKbfVerification.Verdict.DIFF. */
const VERDICT_DIFF = 2n;

const VERIFICATION_IFACE = new Interface([
  'function serviceStatus(uint256 agentId,bytes32 serviceHash) view returns ((bytes32 modelHash,uint8 verdict,uint64 updatedAt,uint64 epoch))',
  'function validityEpochs() view returns (uint8)',
  'function emissionsGate() view returns (address)',
]);
const GATE_IFACE = new Interface(['function currentEpoch() view returns (uint256)']);

function hashServiceKey(key: string): string {
  return keccak256(toUtf8Bytes(key));
}

function first(result: unknown[] | null | undefined): unknown {
  return result && result.length > 0 ? result[0] : undefined;
}

export class VerificationSignalsClient {
  private _multicallAvailable: Promise<boolean> | undefined;
  private _emissionsGate: string | undefined;

  constructor(
    private readonly _provider: AbstractProvider,
    private readonly _verificationAddress: string,
  ) {}

  private async _read(requests: MulticallRequest[]): Promise<Array<unknown[] | null>> {
    if (requests.length === 0) return [];
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
        requests.push({ target, iface: VERIFICATION_IFACE, method: 'serviceStatus', args: [BigInt(agentId), hashServiceKey(key)] });
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
