import type { BuyerPeerView, BuyerSigner } from '@antseed/buyer-core';
import type { SealedWorkerRequest, WorkerE2EClient, WorkerSealOptions } from '@antseed/buyer-core/worker-e2e';
import { peerIdToAddress } from '@antseed/protocol/peer-id';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../types/http.js';
import { DEVICE_ATTESTATION_MAX_AGE_S, isDeviceAttestation, verifyDeviceAttestation } from './apple-attestation.js';
import {
  isWorkerAttestation,
  MAX_WORKER_RECIPIENTS,
  sealRequest,
  verifyWorkerAttestation,
  verifyWorkerKeyCertificate,
  type WorkerAssignment,
  WORKER_CERTIFICATE_USABILITY_MARGIN_S,
} from './worker-crypto.js';
import { usageCounts } from './worker-payment.js';

/** Error code of a request no assigned worker could be encrypted for: the channel's worker slots are taken. */
export const WORKER_SLOTS_FULL = 'worker_slots_full';

const MAX_CACHED_ASSIGNMENTS = 1024;
/** Pools re-attest workers every 5 minutes; an older attestation means the pool stopped checking. */
const ATTESTATION_MAX_AGE_S = 900;

/** Workers a request is encrypted for unless the buyer says otherwise. */
export const DEFAULT_WORKER_RECIPIENTS = 1;

export interface NodeWorkerE2EClientOptions {
  /**
   * How many of the pool's top-ranked workers each request is encrypted for
   * (1 to 3, default 1). With 1, every request is readable by a single Mac and
   * is never sent to another (see `failover`). With more, the pool fails over
   * between them without a round trip, and any of them could read the request.
   */
  recipients?: number;
  /**
   * Only encrypt to workers on a Mac Apple attests (through the pool
   * operator's MDM). A worker's hardening report is signed by a key the worker
   * chose, so it is never a requirement.
   */
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

/** How long a buyer stays on its workers before it asks the pool again, so work spreads to workers that joined since. */
export const ASSIGNMENT_REFRESH_S = 120;
/** Assign calls a buyer makes per minute and service after `worker_unavailable`: well under a seller's limit of 30. */
const REASSIGN_BUDGET = 10;
const REASSIGN_WINDOW_S = 60;

interface HeldAssignment {
  workers: WorkerAssignment[];
  /** When its first worker stops being usable (certificate, attestation or Apple attestation). */
  usableUntil: number;
  assignedAt: number;
  /** Its workers could not take a request: replaced as soon as the reassign budget allows. */
  forgotten: boolean;
  /** The assignment a refresh replaced, kept for a channel that can't credit the new workers. */
  previous?: HeldAssignment | undefined;
}

function assignmentKey(peerId: string, provider: string, service: string): string {
  return `${peerId.toLowerCase()}|${provider}|${service}`;
}

/**
 * Encrypts requests to a colony pool's workers and keeps one assignment (the
 * pool's top-ranked few workers) per (seller, provider, service). It asks again
 * every ASSIGNMENT_REFRESH_S, so a worker that joins later gets work from
 * buyers that already had one, and after `forget`, within a budget: a busy
 * pool must not use up the seller's assign rate limit and lock the buyer out.
 * While an assignment is usable, a refresh that fails keeps it.
 */
export class NodeWorkerE2EClient implements WorkerE2EClient {
  private readonly assignments = new Map<string, HeldAssignment>();
  /** Assign calls in flight, shared by the requests that need them. */
  private readonly pending = new Map<string, Promise<HeldAssignment>>();
  /** When each key was recently assigned (seconds), for the reassign budget. */
  private readonly recentAssigns = new Map<string, number[]>();
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
    options: WorkerSealOptions = {},
  ): Promise<SealedWorkerRequest> {
    const provider = Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'x-antseed-provider')?.[1].trim().toLowerCase() ?? '';
    const held = await this.assignment(peer, provider, service, assign);
    const creditable = (assigned: WorkerAssignment[]): WorkerAssignment[] => {
      if (!options.chooseRecipients) return assigned;
      const chosen = new Set(options.chooseRecipients(assigned.map((w) => w.worker)).map((w) => w.toLowerCase()));
      return assigned.filter((w) => chosen.has(w.worker.toLowerCase()));
    };
    let workers = creditable(held.workers);
    if (workers.length === 0 && held.previous && this.now() < held.previous.usableUntil) {
      // A refresh only spreads work: the channel can't credit the new workers, so it stays with the ones it had.
      workers = creditable(held.previous.workers);
      if (workers.length > 0) this.keep(assignmentKey(peer.peerId, provider, service), held, { ...held.previous, assignedAt: this.now() });
    }
    if (workers.length === 0) {
      // Assigned again next time: the pool may then rank a worker this channel can credit.
      this.forget(peer.peerId, service);
      throw Object.assign(
        new Error('This channel already credits the most workers one channel can, and the pool assigned none of them; retry once it settles'),
        { code: WORKER_SLOTS_FULL },
      );
    }
    const payment = options.payment;
    const sealed = await sealRequest({
      body: request.body,
      recipients: workers.map((w) => ({ worker: w.worker, key: w.key })),
      buyer: {
        address: this.signer.address,
        ...(channelId ? { channel: channelId } : {}),
        ...(channelId && payment ? { payment } : {}),
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
        if (clear === null) return true;
        // Token counts only: the seller adds its own fields to the clear usage
        // (estimated_cost), which the worker never authenticated.
        const a = usageCounts(authenticated);
        const c = usageCounts(clear);
        return a.inputTokens === c.inputTokens && a.cachedInputTokens === c.cachedInputTokens && a.outputTokens === c.outputTokens;
      },
      get usage() {
        return usageCounts(sealed.opener.usage.authenticated);
      },
    };
  }

  /** A request none of its workers could take is sent again to new workers only when it was already readable by more than one. */
  get failover(): boolean {
    return this.recipients > 1;
  }

  forget(peerId: string, service: string): void {
    const peer = `${peerId.toLowerCase()}|`;
    for (const key of this.assignments.keys()) {
      if (key.startsWith(peer) && key.endsWith(`|${service}`)) this.assignments.get(key)!.forgotten = true;
    }
  }

  private async assignment(
    peer: BuyerPeerView,
    provider: string,
    service: string,
    assign: (body: Uint8Array) => Promise<SerializedHttpResponse>,
  ): Promise<HeldAssignment> {
    // Per provider too: two pools on one seller have different workers.
    const key = assignmentKey(peer.peerId, provider, service);
    const cached = this.assignments.get(key);
    const now = this.now();
    const usable = cached !== undefined && now < cached.usableUntil;
    if (usable) {
      const due = cached.forgotten ? this.mayReassign(key, now) : now - cached.assignedAt >= ASSIGNMENT_REFRESH_S;
      if (!due) return cached;
    }
    let request = this.pending.get(key);
    if (!request) {
      this.noteAssign(key, now);
      request = this.requestAssignment(peer, key, service, assign, usable && !cached.forgotten ? cached : undefined, now)
        .finally(() => this.pending.delete(key));
      this.pending.set(key, request);
    }
    try {
      return await request;
    } catch (err) {
      if (!usable) throw err;
      // Busy or rate limited: what it has still works, and is asked about again later.
      cached.assignedAt = now;
      return cached;
    }
  }

  /** Whether a forgotten assignment may be replaced now: at most REASSIGN_BUDGET assign calls a minute. */
  private mayReassign(key: string, now: number): boolean {
    return (this.recentAssigns.get(key) ?? []).filter((at) => now - at < REASSIGN_WINDOW_S).length < REASSIGN_BUDGET;
  }

  private noteAssign(key: string, now: number): void {
    const recent = (this.recentAssigns.get(key) ?? []).filter((at) => now - at < REASSIGN_WINDOW_S);
    // Re-inserted, so the key asked about longest ago is the first dropped.
    this.recentAssigns.delete(key);
    this.recentAssigns.set(key, [...recent, now]);
    if (this.recentAssigns.size > MAX_CACHED_ASSIGNMENTS) this.recentAssigns.delete(this.recentAssigns.keys().next().value!);
  }

  /** Put `next` back unless a newer assignment replaced `held` meanwhile. */
  private keep(key: string, held: HeldAssignment, next: HeldAssignment): void {
    if (this.assignments.get(key) === held) this.assignments.set(key, next);
  }

  private async requestAssignment(
    peer: BuyerPeerView,
    key: string,
    service: string,
    assign: (body: Uint8Array) => Promise<SerializedHttpResponse>,
    previous: HeldAssignment | undefined,
    now: number,
  ): Promise<HeldAssignment> {
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
    const held: HeldAssignment = {
      workers,
      usableUntil,
      assignedAt: now,
      forgotten: false,
      ...(previous ? { previous: { ...previous, previous: undefined } } : {}),
    };
    this.assignments.set(key, held);
    return held;
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
