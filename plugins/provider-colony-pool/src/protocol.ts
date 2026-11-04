import { isWorkerAttestation, type WorkerAttestation } from '@antseed/node/worker-e2e';

/**
 * Colony pool wire protocol (v1).
 *
 * Workers dial the pool over a WebSocket and exchange JSON text frames.
 * Bodies travel base64-encoded so any client (Node, Swift) can speak the
 * protocol with a stock JSON codec. The pool opens with a challenge, the
 * worker answers with an EIP-191 signature over `workerAuthMessage`, and from
 * then on the pool tunnels buyer requests to the worker.
 */

export const COLONY_POOL_PROTOCOL_VERSION = 1;

/** Message a worker signs (EIP-191 personal_sign) to prove its address. */
export function workerAuthMessage(poolId: string, nonce: string): string {
  return `antseed-colony-pool/v${COLONY_POOL_PROTOCOL_VERSION}\npool:${poolId}\nnonce:${nonce}`;
}

// ── pool → worker ──

export interface ChallengeFrame {
  t: 'challenge';
  version: number;
  pool: string;
  nonce: string;
  /** Address buyers pay (the AntseedColonyPool contract); workers certify their encryption key for it. */
  seller: string;
}

export interface WelcomeFrame {
  t: 'welcome';
  workerId: string;
  /** Services the pool will route to this worker (its catalog ∩ the worker's). */
  accepted: string[];
  /** Services the worker offered that the pool does not sell. */
  rejected: string[];
  /** Worker's share of what buyers pay for its requests, in basis points. */
  workerShareBps: number;
}

export interface RequestFrame {
  t: 'request';
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface CancelFrame {
  t: 'cancel';
  id: string;
}

export interface StatsFrame {
  t: 'stats';
  id: string;
  stats: WorkerStats;
}

export interface ErrorFrame {
  t: 'error';
  message: string;
}

/** Asks an attested worker for a fresh attestation answering `nonce` (every few minutes). */
export interface AttestFrame {
  t: 'attest';
  nonce: string;
}

// ── worker → pool ──

export interface HelloFrame {
  t: 'hello';
  address: string;
  signature: string;
  services: string[];
  maxConcurrency: number;
  /** The worker's encryption key, certified for the challenge's seller (see @antseed/node/worker-e2e). */
  encryption: WorkerEncryption;
  /** Signed by `encryption.attestationKey`, answering the challenge nonce. Absent for unattested workers. */
  attestation?: WorkerAttestation;
  /** Free-form client name and version, e.g. `antseed-mac/0.1.0`. */
  agent?: string;
}

export interface WorkerEncryption {
  /** Uncompressed P-256 public key, lowercase hex. */
  key: string;
  /** Unix seconds. */
  expires: number;
  /** EIP-191 signature over workerKeyCertificateMessage(seller, key, expires, attestationKey). */
  certificate: string;
  /** P-256 key the worker signs attestations with (Secure Enclave on a Mac), lowercase hex. */
  attestationKey?: string;
}

/** Answers an `attest` frame. */
export interface AttestationFrame {
  t: 'attestation';
  attestation: WorkerAttestation;
}

/** Replaces the services the worker serves (model loaded/unloaded, owner paused it). */
export interface ServicesFrame {
  t: 'services';
  services: string[];
}

export interface ResponseStartFrame {
  t: 'response-start';
  id: string;
  status: number;
  headers: Record<string, string>;
}

export interface ResponseChunkFrame {
  t: 'response-chunk';
  id: string;
  data: string;
}

export interface ResponseEndFrame {
  t: 'response-end';
  id: string;
}

export interface ResponseErrorFrame {
  t: 'response-error';
  id: string;
  message: string;
}

export interface StatsRequestFrame {
  t: 'stats-request';
  id: string;
}

export type PoolFrame = ChallengeFrame | WelcomeFrame | RequestFrame | CancelFrame | StatsFrame | ErrorFrame | AttestFrame;
export type WorkerFrame =
  | HelloFrame
  | ServicesFrame
  | ResponseStartFrame
  | ResponseChunkFrame
  | ResponseEndFrame
  | ResponseErrorFrame
  | StatsRequestFrame
  | AttestationFrame;

/** A worker's earnings as the pool's ledger records them. Amounts are USDC base units (6 decimals) as strings. */
export interface WorkerStats {
  address: string;
  earnedToday: string;
  earnedLast7Days: string;
  earnedTotal: string;
  paidTotal: string;
  /** earnedTotal − paidTotal. */
  pending: string;
  requestsTotal: number;
  inputTokensTotal: number;
  outputTokensTotal: number;
  /** Seconds connected to the pool in the last 7 days. */
  connectedSecondsLast7Days: number;
}

export function encodeBody(body: Uint8Array): string {
  return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('base64');
}

export function decodeBody(body: string): Uint8Array {
  return new Uint8Array(Buffer.from(body, 'base64'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === 'string');
}

function isEncryption(value: unknown): value is WorkerEncryption {
  return isRecord(value) && typeof value['key'] === 'string' && typeof value['expires'] === 'number'
    && typeof value['certificate'] === 'string'
    && (value['attestationKey'] === undefined || typeof value['attestationKey'] === 'string');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** Parse and validate a frame sent by a worker. Returns null for anything malformed. */
export function parseWorkerFrame(raw: string): WorkerFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value['t'] !== 'string') return null;
  const id = value['id'];
  switch (value['t']) {
    case 'hello':
      return typeof value['address'] === 'string' && typeof value['signature'] === 'string'
        && isStringArray(value['services']) && typeof value['maxConcurrency'] === 'number'
        && isEncryption(value['encryption'])
        && (value['attestation'] === undefined || isWorkerAttestation(value['attestation']))
        && (value['agent'] === undefined || typeof value['agent'] === 'string')
        ? value as unknown as HelloFrame : null;
    case 'services':
      return isStringArray(value['services']) ? value as unknown as ServicesFrame : null;
    case 'response-start':
      return typeof id === 'string' && typeof value['status'] === 'number' && isStringRecord(value['headers'])
        ? value as unknown as ResponseStartFrame : null;
    case 'response-chunk':
      return typeof id === 'string' && typeof value['data'] === 'string' ? value as unknown as ResponseChunkFrame : null;
    case 'response-end':
      return typeof id === 'string' ? value as unknown as ResponseEndFrame : null;
    case 'response-error':
      return typeof id === 'string' && typeof value['message'] === 'string' ? value as unknown as ResponseErrorFrame : null;
    case 'stats-request':
      return typeof id === 'string' ? value as unknown as StatsRequestFrame : null;
    case 'attestation':
      return isWorkerAttestation(value['attestation']) ? value as unknown as AttestationFrame : null;
    default:
      return null;
  }
}

/** Parse and validate a frame sent by the pool. Returns null for anything malformed. */
export function parsePoolFrame(raw: string): PoolFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value['t'] !== 'string') return null;
  const id = value['id'];
  switch (value['t']) {
    case 'challenge':
      return typeof value['version'] === 'number' && typeof value['pool'] === 'string' && typeof value['nonce'] === 'string'
        && typeof value['seller'] === 'string'
        ? value as unknown as ChallengeFrame : null;
    case 'welcome':
      return typeof value['workerId'] === 'string' && isStringArray(value['accepted']) && isStringArray(value['rejected'])
        && typeof value['workerShareBps'] === 'number'
        ? value as unknown as WelcomeFrame : null;
    case 'request':
      return typeof id === 'string' && typeof value['method'] === 'string' && typeof value['path'] === 'string'
        && isStringRecord(value['headers']) && typeof value['body'] === 'string'
        ? value as unknown as RequestFrame : null;
    case 'cancel':
      return typeof id === 'string' ? value as unknown as CancelFrame : null;
    case 'stats':
      return typeof id === 'string' && isRecord(value['stats']) ? value as unknown as StatsFrame : null;
    case 'error':
      return typeof value['message'] === 'string' ? value as unknown as ErrorFrame : null;
    case 'attest':
      return typeof value['nonce'] === 'string' ? value as unknown as AttestFrame : null;
    default:
      return null;
  }
}
