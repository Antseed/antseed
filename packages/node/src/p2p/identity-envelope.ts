import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback, type ScryptOptions } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { computeAddress } from 'ethers';

/**
 * Passphrase-encrypted identity files. An `identity.key` holds either the
 * private key as 64 hex chars or, once protected, a one-line JSON envelope:
 *   {"v":1,"address":"0x…","kdf":{"name":"scrypt","N":…,"r":…,"p":…,"salt":"<b64>"},
 *    "cipher":"aes-256-gcm","iv":"<b64>","ct":"<b64>","tag":"<b64>"}
 * The wallet address is kept in clear (it is public) so listings need no
 * passphrase; it is bound to the ciphertext as GCM associated data.
 */

export const PASSPHRASE_ENV = 'ANTSEED_PASSPHRASE';
export const PASSPHRASE_FILE_ENV = 'ANTSEED_PASSPHRASE_FILE';
/** For passphrases that encrypt keys from now on; files encrypted earlier open with any length. */
export const MIN_PASSPHRASE_LENGTH = 12;

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };

const KEY_BYTES = 32;

interface IdentityEnvelope {
  v: 1;
  address: string;
  kdf: ScryptParams & { name: 'scrypt'; salt: string };
  cipher: 'aes-256-gcm';
  iv: string;
  ct: string;
  tag: string;
}

/** scrypt over the NFKC-normalised password, with enough memory allowed for the given cost. */
export function deriveScryptKey(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const options: ScryptOptions = { ...params, maxmem: 256 * params.N * params.r + 1024 * 1024 };
  return new Promise((resolvePromise, reject) => {
    scryptCallback(password.normalize('NFKC'), salt, KEY_BYTES, options, (error, key) => (error ? reject(error) : resolvePromise(key)));
  });
}

/**
 * Throws unless the passphrase is long enough to encrypt a key with, counted
 * as scrypt sees it (NFKC, untrimmed). `source` names where it came from.
 */
export function assertNewIdentityPassphrase(
  passphrase: string,
  source = `The passphrase in ${PASSPHRASE_ENV} (or ${PASSPHRASE_FILE_ENV})`,
): void {
  if ([...passphrase.normalize('NFKC')].length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`${source} is too short to encrypt wallet keys with: use at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
}

export function isIdentityEnvelope(text: string): boolean {
  return text.trimStart().startsWith('{');
}

export async function encryptIdentityKey(hexKey: string, passphrase: string, params: ScryptParams = DEFAULT_SCRYPT_PARAMS): Promise<string> {
  const address = computeAddress('0x' + hexKey);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveScryptKey(passphrase, salt, params);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(address.toLowerCase()));
  const ct = Buffer.concat([cipher.update(Buffer.from(hexKey, 'hex')), cipher.final()]);
  const envelope: IdentityEnvelope = {
    v: 1,
    address,
    kdf: { name: 'scrypt', ...params, salt: salt.toString('base64') },
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
  return JSON.stringify(envelope);
}

function parseEnvelope(text: string): IdentityEnvelope {
  let envelope: IdentityEnvelope;
  try {
    envelope = JSON.parse(text) as IdentityEnvelope;
  } catch {
    throw new Error('The encrypted identity is damaged.');
  }
  const kdf = envelope?.kdf;
  if (typeof kdf !== 'object' || kdf === null) throw new Error('The encrypted identity is damaged.');
  const validCost = Number.isInteger(kdf.N) && kdf.N >= 2 ** 14 && kdf.N <= 2 ** 20 && (kdf.N & (kdf.N - 1)) === 0
    && Number.isInteger(kdf.r) && kdf.r >= 1 && kdf.r <= 16 && Number.isInteger(kdf.p) && kdf.p >= 1 && kdf.p <= 4;
  if (envelope.v !== 1 || kdf.name !== 'scrypt' || envelope.cipher !== 'aes-256-gcm' || !validCost) {
    throw new Error('The encrypted identity uses settings this version does not support.');
  }
  if (typeof envelope.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(envelope.address)) {
    throw new Error('The encrypted identity is damaged.');
  }
  return envelope;
}

/** The wallet address an envelope is for, without decrypting it. */
export function identityEnvelopeAddress(text: string): string {
  return parseEnvelope(text).address;
}

/** The private key as 64 lowercase hex chars; throws on a wrong passphrase or a tampered file. */
export async function decryptIdentityKey(text: string, passphrase: string): Promise<string> {
  const envelope = parseEnvelope(text);
  const key = await deriveScryptKey(passphrase, Buffer.from(envelope.kdf.salt, 'base64'), envelope.kdf);
  let plain: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from(envelope.address.toLowerCase()));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    plain = Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]);
  } catch {
    throw new Error(`Wrong passphrase (${PASSPHRASE_ENV}), or the encrypted identity was changed.`);
  }
  if (plain.length !== KEY_BYTES) throw new Error('The encrypted identity is damaged.');
  return plain.toString('hex');
}

/**
 * Taken from the environment once and removed from process.env, so child
 * processes started later do not inherit it by accident. This does not erase
 * it from the environment the OS recorded at exec (e.g. /proc/<pid>/environ,
 * readable by the same user and root): ANTSEED_PASSPHRASE_FILE avoids that.
 */
let _envPassphrase: string | undefined;

function takeEnvPassphrase(): string | undefined {
  const fromEnv = process.env[PASSPHRASE_ENV];
  if (fromEnv !== undefined) {
    delete process.env[PASSPHRASE_ENV];
    if (fromEnv) _envPassphrase = fromEnv;
  }
  return _envPassphrase;
}

/**
 * The passphrase that protects identity files: ANTSEED_PASSPHRASE, else the
 * first line of the file named by ANTSEED_PASSPHRASE_FILE; null when neither
 * is set. Throws when the passphrase file cannot be read or is empty.
 */
export function resolveIdentityPassphrase(): string | null {
  const fromEnv = takeEnvPassphrase();
  if (fromEnv) return fromEnv;
  const file = process.env[PASSPHRASE_FILE_ENV];
  if (!file) return null;
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read ${PASSPHRASE_FILE_ENV} (${file}).`, { cause: error });
  }
  const passphrase = content.split(/\r?\n/, 1)[0] ?? '';
  if (!passphrase) throw new Error(`${PASSPHRASE_FILE_ENV} (${file}) is empty.`);
  return passphrase;
}

/**
 * Uses a passphrase obtained another way (asked on a terminal) for the rest
 * of this process, exactly like one taken from ANTSEED_PASSPHRASE: it is
 * returned by identityPassphraseEnv() and never written.
 */
export function setIdentityPassphrase(passphrase: string): void {
  _envPassphrase = passphrase;
}

/**
 * The passphrase this process took out of its environment (or was given),
 * as `{ ANTSEED_PASSPHRASE: … }`, for handing on to a child process that must
 * unlock identities too; prefer a channel other than the child's environment.
 * ANTSEED_PASSPHRASE_FILE stays in the environment and is inherited as is.
 */
export function identityPassphraseEnv(): Record<string, string> {
  const fromEnv = takeEnvPassphrase();
  return fromEnv ? { [PASSPHRASE_ENV]: fromEnv } : {};
}
