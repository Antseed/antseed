import type { BuyerPeerView, BuyerSigner } from '@antseed/buyer-core';
import type { SealedWorkerRequest, WorkerE2EClient, WorkerUsage } from '@antseed/buyer-core/worker-e2e';
import { peerIdToAddress } from '@antseed/protocol/peer-id';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../types/http.js';
import { DEVICE_ATTESTATION_MAX_AGE_S, isDeviceAttestation, verifyDeviceAttestation } from './apple-attestation.js';
import {
  isWorkerAttestation,
  MAX_WORKER_RECIPIENTS,
  sealRequest,
  type UsageLike,
  verifyWorkerAttestation,
  verifyWorkerKeyCertificate,
  type WorkerAssignment,
  WORKER_CERTIFICATE_USABILITY_MARGIN_S,
} from './worker-crypto.js';

const MAX_CACHED_ASSIGNMENTS = 1024;
/** Pools re-attest workers every 5 minutes; an older attestation means the pool stopped checking. */
const ATTESTATION_MAX_AGE_S = 900;

/** Workers a request is encrypted for unless the buyer says otherwise. */
export const DEFAULT_WORKER_RECIPIENTS = 2;

export interface NodeWorkerE2EClientOptions {
  /**
   * How many of the pool's top-ranked workers each request is encrypted for
   * (1 to 3, default 2). The pool fails over between them without a round
   * trip; any of them could read the request if the pool forwarded it, so 1
   * keeps every request readable by a single Mac.
   */
  recipients?: number;
  /** Only encrypt to workers whose attestation reports a hardened Mac. */
  requireAttestedWorkers?: boolean;
  /** Only encrypt to workers on a Mac Apple attests (through the pool operator's MDM), as well as hardened. */
  requireAppleVerifiedWorkers?: boolean;
  /** Trust anchors for device attestations; Apple's root unless a test overrides it. */
  deviceAttestationRoots?: string[];
  now?: () => number;
}

/** The address buyers pay a seller: its seller contract when it announces one, else its own. */
export function sellerPayeeAddress(peer: BuyerPeerView): string {
  const contract = peer.metadata?.sellerContract;
  return contract ? `0x${contract.replace(/^0x/, '')}` : peerIdToAddress(peer.peerId);
}

function parseAssignments(response: SerializedHttpResponse): WorkerAssignment[] {
  if (response.statusCode !== 200) {
    throw new Error(`Colony pool could not assign a worker (HTTP ${response.statusCode})`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(response.body)) as { workers?: unknown };
  if (!Array.isArray(parsed.workers) || parsed.workers.length === 0) throw new Error('Colony pool returned a malformed assignment');
  return parsed.workers.map((worker) => parseAssignment(worker));
}

function parseAssignment(raw: unknown): WorkerAssignment {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<WorkerAssignment>;
  if (
    typeof value.worker !== 'string' || typeof value.key !== 'string' || typeof value.expires !== 'number'
    || typeof value.certificate !== 'string' || typeof value.pool !== 'string'
    || (value.attestationKey !== undefined && typeof value.attestationKey !== 'string')
    || (value.attestation !== undefined && !isWorkerAttestation(value.attestation))
    || (value.deviceAttestation !== undefined && !isDeviceAttestation(value.deviceAttestation))
  ) {
    throw new Error('Colony pool returned a malformed assignment');
  }
  return value as WorkerAssignment;
}

function count(value: unknown): bigint {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? BigInt(value) : 0n;
}

/** Token counts from an OpenAI-style (or Anthropic-style) usage object. */
function workerUsage(usage: UsageLike | null): WorkerUsage {
  if (!usage) return { inputTokens: 0n, cachedInputTokens: 0n, outputTokens: 0n };
  const details = usage['prompt_tokens_details'] as { cached_tokens?: unknown } | undefined;
  const cached = count(details?.cached_tokens) + count(usage['cache_read_input_tokens']);
  // Anthropic-style input_tokens excludes cached tokens; prompt_tokens includes them.
  const input = usage['prompt_tokens'] !== undefined ? count(usage['prompt_tokens']) : count(usage['input_tokens']) + cached;
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: count(usage['completion_tokens'] ?? usage['output_tokens']),
  };
}

/**
 * Encrypts requests to a colony pool's workers and keeps one assignment (the
 * pool's top-ranked few workers) per (seller, provider, service), so a
 * buyer's requests stay on the same Macs.
 */
export class NodeWorkerE2EClient implements WorkerE2EClient {
  /** Each assignment with the time its first worker stops being usable (certificate, attestation or Apple attestation). */
  private readonly assignments = new Map<string, { workers: WorkerAssignment[]; usableUntil: number }>();
  private readonly now: () => number;
  private readonly recipients: number;

  constructor(private readonly signer: BuyerSigner, private readonly options: NodeWorkerE2EClientOptions = {}) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    const wanted = options.recipients ?? DEFAULT_WORKER_RECIPIENTS;
    if (!Number.isInteger(wanted) || wanted < 1 || wanted > MAX_WORKER_RECIPIENTS) {
      throw new Error(`colonyPoolRecipients must be 1 to ${MAX_WORKER_RECIPIENTS}`);
    }
    this.recipients = wanted;
  }

  async seal(
    peer: BuyerPeerView,
    request: SerializedHttpRequest,
    service: string,
    assign: (body: Uint8Array) => Promise<SerializedHttpResponse>,
    channelId: string | null,
  ): Promise<SealedWorkerRequest> {
    const provider = Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'x-antseed-provider')?.[1].trim().toLowerCase() ?? '';
    const workers = await this.assignment(peer, provider, service, assign);
    const sealed = await sealRequest({
      body: request.body,
      recipients: workers.map((w) => ({ worker: w.worker, key: w.key })),
      buyer: {
        address: this.signer.address,
        ...(channelId ? { channel: channelId } : {}),
        signMessage: (message) => this.signer.signMessage(message),
      },
    });
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => name.toLowerCase() !== 'content-length'));
    return {
      recipients: workers.map((w) => w.worker),
      get worker() {
        return sealed.opener.worker;
      },
      request: { ...request, headers, body: sealed.body },
      openBody: (body) => sealed.opener.openBody(body),
      pushStream: (chunk) => sealed.opener.pushStream(chunk),
      get verified() {
        return sealed.opener.verified;
      },
      get usageConsistent() {
        const { authenticated, clear } = sealed.opener.usage;
        return clear === null || JSON.stringify(clear) === JSON.stringify(authenticated);
      },
      get usage() {
        return workerUsage(sealed.opener.usage.authenticated);
      },
    };
  }

  forget(peerId: string, service: string): void {
    const peer = `${peerId.toLowerCase()}|`;
    for (const key of this.assignments.keys()) {
      if (key.startsWith(peer) && key.endsWith(`|${service}`)) this.assignments.delete(key);
    }
  }

  private async assignment(
    peer: BuyerPeerView,
    provider: string,
    service: string,
    assign: (body: Uint8Array) => Promise<SerializedHttpResponse>,
  ): Promise<WorkerAssignment[]> {
    // Per provider too: two pools on one seller have different workers.
    const key = `${peer.peerId.toLowerCase()}|${provider}|${service}`;
    const cached = this.assignments.get(key);
    const now = this.now();
    if (cached && now < cached.usableUntil) return cached.workers;

    const offered = parseAssignments(await assign(new TextEncoder().encode(JSON.stringify({ model: service, recipients: this.recipients }))));
    const seen = new Set<string>();
    const workers: WorkerAssignment[] = [];
    let usableUntil = Infinity;
    let refusal = '';
    for (const certificate of offered.slice(0, this.recipients)) {
      if (seen.has(certificate.worker.toLowerCase())) throw new Error('Colony pool assigned the same worker twice');
      seen.add(certificate.worker.toLowerCase());
      try {
        usableUntil = Math.min(usableUntil, this.check(peer, certificate, now));
        workers.push(certificate);
      } catch (err) {
        // A recipient that does not meet this buyer's policy is left out; the others still serve.
        refusal = err instanceof Error ? err.message : String(err);
      }
    }
    if (workers.length === 0) throw new Error(refusal || 'Colony pool assigned no usable worker');
    if (this.assignments.size >= MAX_CACHED_ASSIGNMENTS) {
      const oldest = this.assignments.keys().next().value;
      if (oldest !== undefined) this.assignments.delete(oldest);
    }
    this.assignments.set(key, { workers, usableUntil });
    return workers;
  }

  /** Checks one assigned worker against this buyer's policy; returns when it stops being usable. Throws when it fails. */
  private check(peer: BuyerPeerView, certificate: WorkerAssignment, now: number): number {
    // The key must be certified by its worker for the seller this buyer pays.
    if (!verifyWorkerKeyCertificate(certificate, sellerPayeeAddress(peer), now)) {
      throw new Error('Colony pool returned a worker key that is not certified for this seller');
    }
    // An attestation the pool forwards must be the worker's own and fresh.
    const check = certificate.attestation
      ? verifyWorkerAttestation(certificate.attestation, certificate, { maxAgeS: ATTESTATION_MAX_AGE_S, now })
      : null;
    if (check && !check.valid) throw new Error(`Colony pool returned an invalid worker attestation: ${check.reason}`);
    let usableUntil = certificate.expires - WORKER_CERTIFICATE_USABILITY_MARGIN_S;
    if (certificate.attestation) usableUntil = Math.min(usableUntil, certificate.attestation.issued + ATTESTATION_MAX_AGE_S);
    if ((this.options.requireAttestedWorkers || this.options.requireAppleVerifiedWorkers) && !check?.hardened) {
      throw new Error('Colony pool assigned a worker that is not an attested hardened Mac');
    }
    // Apple's attestation must name the Mac the worker attests it runs on, and this worker's key.
    if (certificate.deviceAttestation) {
      const device = verifyDeviceAttestation(certificate.deviceAttestation, {
        worker: certificate.worker,
        attestationKey: certificate.attestationKey ?? '',
        serialNumber: certificate.attestation?.serial ?? '',
        maxAgeS: DEVICE_ATTESTATION_MAX_AGE_S,
        now,
        ...(this.options.deviceAttestationRoots ? { roots: this.options.deviceAttestationRoots } : {}),
      });
      if (!device.valid) throw new Error(`Colony pool returned an invalid Apple device attestation: ${device.reason}`);
      usableUntil = Math.min(usableUntil, device.validUntil ?? now);
    } else if (this.options.requireAppleVerifiedWorkers) {
      throw new Error('Colony pool assigned a worker whose Mac Apple does not attest');
    }
    return usableUntil;
  }
}
