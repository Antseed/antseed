import { isWorkerAttestation, type WorkerAttestation, type WorkerKeyCertificate } from '@antseed/node/worker-e2e';
import type { ServicePricing } from '@antseed/node';

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
  /**
   * What buyers pay for each accepted service, USD per million tokens: the
   * worker serves a channel only while the buyer's signed payments cover its
   * earlier answers there at these prices.
   */
  prices: Record<string, ServicePrice>;
  /**
   * The model each pinned service must run (`COLONY_POOL_MODELS`): service →
   * `repo@revision`, with `#<sha256>` when the pool pins the files' digest. A
   * worker that has no model yet (Antseed Colony on first join) offers these
   * to its owner and runs the one picked. Absent when the pool pins none.
   */
  models?: Record<string, string>;
}

/** A service's token prices, as buyers pay them. */
export type ServicePrice = ServicePricing;

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
  /** Service → the model it runs, `repo@revision` (self-reported; a pool with COLONY_POOL_MODELS refuses a mismatch). */
  models?: Record<string, string>;
}

/** The worker's certificate as it sends it: the pool already knows the worker and itself. */
export type WorkerEncryption = Omit<WorkerKeyCertificate, 'worker' | 'pool'>;

/** Answers an `attest` frame. */
export interface AttestationFrame {
  t: 'attestation';
  attestation: WorkerAttestation;
}

/** Replaces the services the worker serves (model loaded/unloaded, owner paused it). */
export interface ServicesFrame {
  t: 'services';
  services: string[];
  /** As in `hello`; replaces the models the worker reported, when present. */
  models?: Record<string, string>;
}

/**
 * The worker took the request and is running it: sent as soon as it admitted
 * the request and its channel check passed, before inference, so the pool
 * fails over from a worker that never picks a request up without waiting for
 * a slow first byte.
 */
export interface AcceptedFrame {
  t: 'accepted';
  id: string;
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

/** Answers the challenge instead of `hello`: a read-only stats query that never joins or replaces the serving connection. */
export interface StatsHelloFrame {
  t: 'stats-hello';
  address: string;
  signature: string;
}

export type PoolFrame = ChallengeFrame | WelcomeFrame | RequestFrame | CancelFrame | StatsFrame | ErrorFrame | AttestFrame;
export type WorkerFrame =
  | HelloFrame
  | ServicesFrame
  | AcceptedFrame
  | ResponseStartFrame
  | ResponseChunkFrame
  | ResponseEndFrame
  | ResponseErrorFrame
  | StatsRequestFrame
  | StatsHelloFrame
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

type FieldCheck = (value: unknown) => boolean;
const isString: FieldCheck = (value) => typeof value === 'string';
const isNumber: FieldCheck = (value) => typeof value === 'number';
const optional = (check: FieldCheck): FieldCheck => (value) => value === undefined || check(value);
const isPrice = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  const finite = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  return finite(value['inputUsdPerMillion']) && finite(value['outputUsdPerMillion'])
    && (value['cachedInputUsdPerMillion'] === undefined || finite(value['cachedInputUsdPerMillion']));
};
const isPrices: FieldCheck = (value) => isRecord(value) && Object.values(value).every(isPrice);

/** Each frame's fields (every field of its interface but `t`) and the check each must pass. */
type FrameShapes<F extends { t: string }> = {
  [T in F['t']]: { [K in Exclude<keyof Extract<F, { t: T }>, 't'>]-?: FieldCheck };
};

const WORKER_FRAMES: FrameShapes<WorkerFrame> = {
  hello: {
    address: isString, signature: isString, services: isStringArray, maxConcurrency: isNumber, encryption: isEncryption,
    attestation: optional(isWorkerAttestation), agent: optional(isString), models: optional(isStringRecord),
  },
  services: { services: isStringArray, models: optional(isStringRecord) },
  accepted: { id: isString },
  'response-start': { id: isString, status: isNumber, headers: isStringRecord },
  'response-chunk': { id: isString, data: isString },
  'response-end': { id: isString },
  'response-error': { id: isString, message: isString },
  'stats-request': { id: isString },
  'stats-hello': { address: isString, signature: isString },
  attestation: { attestation: isWorkerAttestation },
};

const POOL_FRAMES: FrameShapes<PoolFrame> = {
  challenge: { version: isNumber, pool: isString, nonce: isString, seller: isString },
  welcome: { workerId: isString, accepted: isStringArray, rejected: isStringArray, workerShareBps: isNumber, prices: isPrices, models: optional(isStringRecord) },
  request: { id: isString, method: isString, path: isString, headers: isStringRecord, body: isString },
  cancel: { id: isString },
  stats: { id: isString, stats: isRecord },
  error: { message: isString },
  attest: { nonce: isString },
};

function parseFrame<F extends { t: string }>(raw: string, shapes: FrameShapes<F>): F | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value['t'] !== 'string' || !Object.hasOwn(shapes, value['t'])) return null;
  const frame = value;
  const shape: Record<string, FieldCheck> = shapes[frame['t'] as F['t']];
  return Object.entries(shape).every(([name, check]) => check(frame[name])) ? frame as unknown as F : null;
}

/** Parse and validate a frame sent by a worker. Returns null for anything malformed. */
export function parseWorkerFrame(raw: string): WorkerFrame | null {
  return parseFrame(raw, WORKER_FRAMES);
}

/** Parse and validate a frame sent by the pool. Returns null for anything malformed. */
export function parsePoolFrame(raw: string): PoolFrame | null {
  return parseFrame(raw, POOL_FRAMES);
}
