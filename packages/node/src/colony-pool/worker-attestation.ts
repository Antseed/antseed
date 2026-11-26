import { createHash, verify } from 'node:crypto';
import { publicKeyObject } from './p256.js';
import type { WorkerKeyCertificate } from './worker-crypto.js';

/**
 * What a colony pool's worker app reports about itself, and how a pool or
 * buyer checks it. Spec: docs/protocol/colony-pool.md.
 */

/** How far ahead of the reader's clock an attestation may be dated (clock skew between a Mac and the pool or buyer). */
const ATTESTATION_CLOCK_SKEW_S = 300;

/**
 * What a worker app reports about itself, signed with its attestation key:
 * which signed build is running and whether macOS keeps other processes
 * (the Mac's owner included) out of it. Self-reported: it shows the official
 * app holds the key, not that no modified app exists (docs/protocol/colony-pool.md).
 */
export interface WorkerAttestation {
  v: 1;
  /** Apple Developer team that signed the running app; null for unsigned or ad-hoc builds. */
  teamId: string | null;
  /** Code-signing identifier (bundle id) of the running app. */
  signingId: string | null;
  /** Code directory hash of the running build, lowercase hex. */
  cdhash: string | null;
  /** System Integrity Protection fully on. */
  sip: boolean;
  /** Signed with the hardened runtime and without get-task-allow. */
  hardenedRuntime: boolean;
  /** The process refused debugger attachment (PT_DENY_ATTACH) and none is attached. */
  debuggerDenied: boolean;
  /** The decryption key is stored so only this signed app can use it. */
  keyAppBound: boolean;
  /** OS name and version, e.g. `macOS 26.2`. */
  os: string;
  /** The Mac's serial number and hardware UUID, which the pool's MDM (if any) attests through Apple. */
  serial: string | null;
  udid: string | null;
  /** Service → the checkpoint the worker loaded for it and the SHA-256 of its files (`modelFilesDigest`). */
  models?: Record<string, AttestedModel>;
  /** Unix seconds. */
  issued: number;
  /** The pool's challenge nonce this answers. */
  nonce: string;
  /** Base64 DER ECDSA-P256-SHA256 signature by the certificate's attestationKey over workerAttestationMessage. */
  signature: string;
}

/** A checkpoint a worker attests it loaded: `repo@revision` and the SHA-256 of its files. */
export interface AttestedModel {
  model: string;
  sha256: string;
  /**
   * SHA-256 of the engine executable the worker app runs for this service, hashed by the app for every
   * model, witnessed or not. When `witness` is present, its `binary` names the same executable.
   */
  engine?: string;
  /** What the engine reports it loaded (its execution witness), when it knows: absent on paths the engine can't attest. */
  witness?: AttestedWitness;
}

/**
 * A TensorFold engine's execution witness of what serves a service (`serve --execution-witness`):
 * reported by the engine and signed by the worker app, so it is as trustworthy as the app's attestation.
 */
export interface AttestedWitness {
  /** The engine's supported path, e.g. `qwen3_5-2b/metal/tp1/mlx-q4g64/text`. */
  path: string;
  /** `components.engine`: every weight byte as loaded, the checkpoint's structure, and the kernels and machine facts that path binds. */
  engine: string;
  /** `components.binary`: the engine executable's SHA-256. */
  binary: string;
  /** `components.text`: the tokenizer, template and special-token files the engine loaded. */
  text: string;
}

const ATTESTED_SERVICE = /^[!-~]{1,128}$/;
const ATTESTED_MODEL = /^[^\s@,=#]+@[^\s@,=#]+$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_ATTESTED_MODELS = 32;

/**
 * The digest of a checkpoint's files that workers attest: SHA-256 over the
 * lines `shasum -a 256` prints for every regular file in the snapshot
 * directory (symlinks followed), as `./path`, sorted bytewise. An operator
 * gets the same value with
 * `cd SNAPSHOT && find -L . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | shasum -a 256`.
 */
export function modelFilesDigest(files: readonly { path: string; sha256: string }[]): string {
  const lines = [...files]
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
    .map((file) => `${file.sha256}  ${file.path}\n`)
    .join('');
  return createHash('sha256').update(lines).digest('hex');
}

function attestedModelsLine(models: Record<string, AttestedModel> | undefined): string[] {
  const entries = Object.entries(models ?? {}).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  // Absent and empty sign the same: no line, so attestations without models keep their message.
  if (entries.length === 0) return [];
  const witnesses = entries.flatMap(([service, { witness: w }]) => (w ? [`${service}=${w.path}#${w.engine}#${w.binary}#${w.text}`] : []));
  return [
    // The engine's digest only when attested, so attestations without it keep their message.
    `models:${entries.map(([service, { model, sha256, engine }]) => `${service}=${model}#${sha256}${engine ? `#${engine}` : ''}`).join(',')}`,
    // Only services the engine attests; none signs no line.
    ...(witnesses.length > 0 ? [`witness:${witnesses.join(',')}`] : []),
  ];
}

function isAttestedWitness(value: unknown): value is AttestedWitness {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { path, engine, binary, text, ...rest } = value as Record<string, unknown>;
  return Object.keys(rest).length === 0 && typeof path === 'string' && ATTESTED_SERVICE.test(path) && !/[,=#]/.test(path)
    && [engine, binary, text].every((digest) => typeof digest === 'string' && DIGEST.test(digest));
}

function isAttestedModels(value: unknown): value is Record<string, AttestedModel> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= MAX_ATTESTED_MODELS && entries.every(([service, entry]) => {
    if (!ATTESTED_SERVICE.test(service) || /[,=#]/.test(service) || typeof entry !== 'object' || entry === null) return false;
    const { model, sha256, engine, witness } = entry as Record<string, unknown>;
    return typeof model === 'string' && ATTESTED_MODEL.test(model) && typeof sha256 === 'string' && DIGEST.test(sha256)
      && (engine === undefined || (typeof engine === 'string' && DIGEST.test(engine)))
      && (witness === undefined || isAttestedWitness(witness))
      // The witness and the app's own hash must name the same engine executable.
      && (engine === undefined || witness === undefined || (witness as AttestedWitness).binary === engine);
  });
}

export function workerAttestationMessage(worker: string, keyHex: string, a: Omit<WorkerAttestation, 'signature'>): string {
  const flag = (value: boolean) => (value ? '1' : '0');
  return [
    `antseed-worker-attestation/v${a.v}`,
    `worker:${worker.toLowerCase()}`,
    `key:${keyHex.toLowerCase()}`,
    `team:${a.teamId ?? ''}`,
    `signing-id:${a.signingId ?? ''}`,
    `cdhash:${a.cdhash ?? ''}`,
    `sip:${flag(a.sip)}`,
    `hardened-runtime:${flag(a.hardenedRuntime)}`,
    `debugger-denied:${flag(a.debuggerDenied)}`,
    `key-app-bound:${flag(a.keyAppBound)}`,
    `os:${a.os}`,
    `serial:${a.serial ?? ''}`,
    `udid:${a.udid ?? ''}`,
    ...attestedModelsLine(a.models),
    `issued:${a.issued}`,
    `nonce:${a.nonce}`,
  ].join('\n');
}

export function isWorkerAttestation(value: unknown): value is WorkerAttestation {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Record<string, unknown>;
  const nullableString = (v: unknown) => v === null || typeof v === 'string';
  return a['v'] === 1 && nullableString(a['teamId']) && nullableString(a['signingId']) && nullableString(a['cdhash'])
    && typeof a['sip'] === 'boolean' && typeof a['hardenedRuntime'] === 'boolean' && typeof a['debuggerDenied'] === 'boolean'
    && typeof a['keyAppBound'] === 'boolean' && typeof a['os'] === 'string' && nullableString(a['serial'])
    && nullableString(a['udid']) && (a['models'] === undefined || isAttestedModels(a['models'])) && typeof a['issued'] === 'number'
    && typeof a['nonce'] === 'string' && typeof a['signature'] === 'string';
}

export interface AttestationPolicy {
  /** Require this nonce (the pool's live challenge). */
  nonce?: string;
  /** Oldest acceptable `issued`, in seconds before now. */
  maxAgeS: number;
  /** If set, only these Apple Developer teams count as hardened. */
  teams?: ReadonlySet<string>;
  now?: number;
}

/**
 * Checks an attestation against the worker's certificate. `valid` means it is
 * genuinely signed by the certified attestation key, fresh, and for this
 * worker and key; `hardened` additionally means it reports a signed build
 * with the hardened runtime, SIP on, no debugger, and an app-bound key.
 */
export function verifyWorkerAttestation(
  attestation: WorkerAttestation,
  cert: WorkerKeyCertificate,
  policy: AttestationPolicy,
): { valid: boolean; hardened: boolean; reason?: string } {
  const now = policy.now ?? Math.floor(Date.now() / 1000);
  const fail = (reason: string) => ({ valid: false, hardened: false, reason });
  if (!cert.attestationKey) return fail('worker has no attestation key');
  if (policy.nonce !== undefined && attestation.nonce !== policy.nonce) return fail('attestation answers another challenge');
  if (attestation.issued < now - policy.maxAgeS || attestation.issued > now + ATTESTATION_CLOCK_SKEW_S) return fail('attestation is stale');
  const { signature, ...statement } = attestation;
  let signed = false;
  try {
    signed = verify(
      'sha256',
      Buffer.from(workerAttestationMessage(cert.worker, cert.key, statement)),
      { key: publicKeyObject(Buffer.from(cert.attestationKey, 'hex')), dsaEncoding: 'der' },
      Buffer.from(signature, 'base64'),
    );
  } catch {
    signed = false;
  }
  if (!signed) return fail('attestation signature does not verify');
  const hardened = attestation.teamId !== null && attestation.sip && attestation.hardenedRuntime
    && attestation.debuggerDenied && attestation.keyAppBound
    && (!policy.teams || policy.teams.has(attestation.teamId));
  return { valid: true, hardened };
}
