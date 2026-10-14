import { randomBytes } from "node:crypto";
import { access, readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { Wallet } from "ethers";
import { toPeerId, type PeerId } from "../types/peer.js";
import { hexToBytes, bytesToHex } from "../utils/hex.js";
import {
  PASSPHRASE_ENV,
  PASSPHRASE_FILE_ENV,
  assertNewIdentityPassphrase,
  decryptIdentityKey,
  encryptIdentityKey,
  identityEnvelopeAddress,
  isIdentityEnvelope,
  resolveIdentityPassphrase,
} from "./identity-envelope.js";

export { hexToBytes, bytesToHex };

const CONFIG_DIR = join(homedir(), ".antseed");
const PRIVATE_KEY_FILE = "identity.key";
const ENCRYPTED_PRIVATE_KEY_FILE = "identity.enc";

export interface Identity {
  peerId: PeerId;
  privateKey: Uint8Array;
  wallet: Wallet;
}

/**
 * Pluggable storage backend for identity private keys.
 */
export interface IdentityStore {
  /** Load the private key hex string, or return null if not found. */
  load(): Promise<string | null>;
  /** Persist the private key hex string. */
  save(hexKey: string): Promise<void>;
}

export interface FileIdentityStoreOptions {
  /**
   * Unlocks an encrypted key file, and encrypts new ones. Defaults to
   * ANTSEED_PASSPHRASE / ANTSEED_PASSPHRASE_FILE; null means no passphrase.
   */
  passphrase?: string | null;
}

/** Decrypted keys by envelope, so repeated loads in one process skip the deliberately slow scrypt. */
const decryptedKeys = new Map<string, { passphrase: string; hexKey: string }>();

/**
 * Stores identity private key as a file on disk (default behavior): 64 hex
 * chars, or a passphrase-encrypted envelope (see identity-envelope.ts).
 */
export class FileIdentityStore implements IdentityStore {
  private readonly keyPath: string;
  private readonly encryptedKeyPath: string;
  private readonly dir: string;

  constructor(configDir?: string, private readonly options: FileIdentityStoreOptions = {}) {
    this.dir = configDir ?? CONFIG_DIR;
    this.keyPath = join(this.dir, PRIVATE_KEY_FILE);
    this.encryptedKeyPath = join(this.dir, ENCRYPTED_PRIVATE_KEY_FILE);
  }

  private passphrase(): string | null {
    return this.options.passphrase !== undefined ? this.options.passphrase : resolveIdentityPassphrase();
  }

  /** The key file's content, or null when there is none. */
  private async readKeyFile(): Promise<string | null> {
    try {
      return (await readFile(this.keyPath, "utf-8")).trim();
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw new Error(`Unable to read identity at ${this.keyPath}; refusing to create a replacement identity.`, { cause: error });
    }
  }

  async load(): Promise<string | null> {
    const stored = await this.readKeyFile();
    if (stored !== null) return isIdentityEnvelope(stored) ? this.decrypt(stored) : stored;

    try {
      await access(this.encryptedKeyPath);
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw new Error(`Unable to inspect identity at ${this.encryptedKeyPath}; refusing to create a replacement identity.`, { cause: error });
    }

    throw new Error(
      `An app-encrypted identity already exists at ${this.encryptedKeyPath}. ` +
      'The CLI cannot decrypt Electron safeStorage identities and will not create a second wallet in the same data directory. ' +
      'Back up the private key from the AI VPN and import it for CLI use, launch the CLI through the AI VPN, or choose a different --data-dir.',
    );
  }

  /** Written encrypted when a passphrase is configured. */
  async save(hexKey: string): Promise<void> {
    const passphrase = this.passphrase();
    if (!passphrase) return this.writeKeyFile(hexKey);
    assertNewIdentityPassphrase(passphrase);
    await this.writeKeyFile(await encryptIdentityKey(hexKey, passphrase));
  }

  /** How the key file is stored, or null when there is none. */
  async format(): Promise<"plaintext" | "encrypted" | null> {
    const stored = await this.readKeyFile();
    if (stored === null) return null;
    return isIdentityEnvelope(stored) ? "encrypted" : "plaintext";
  }

  /** The wallet address, read without the passphrase; null when there is no key file. */
  async address(): Promise<string | null> {
    const stored = await this.readKeyFile();
    if (stored === null) return null;
    if (isIdentityEnvelope(stored)) return identityEnvelopeAddress(stored);
    return identityFromPrivateKeyHex(this.validHex(stored)).wallet.address;
  }

  /**
   * Whether this passphrase unlocks the encrypted key file; null when the
   * file is missing or plaintext. Throws when the file is unreadable or damaged.
   */
  async unlocksWith(passphrase: string): Promise<boolean | null> {
    const stored = await this.readKeyFile();
    if (stored === null || !isIdentityEnvelope(stored)) return null;
    const cached = decryptedKeys.get(stored);
    if (cached?.passphrase === passphrase) return true;
    let hexKey: string;
    try {
      hexKey = await decryptIdentityKey(stored, passphrase);
    } catch (error) {
      if ((error as Error).message.startsWith("Wrong passphrase")) return false;
      throw error;
    }
    decryptedKeys.set(stored, { passphrase, hexKey });
    return true;
  }

  /** Encrypts a plaintext key file in place; false when it already is encrypted. */
  async protect(): Promise<boolean> {
    const passphrase = this.passphrase();
    if (!passphrase) throw new Error(`Set ${PASSPHRASE_ENV} or ${PASSPHRASE_FILE_ENV} to the passphrase that should protect the key.`);
    const stored = await this.readKeyFile();
    if (stored === null) throw new Error(`No identity at ${this.keyPath}.`);
    if (isIdentityEnvelope(stored)) return false;
    assertNewIdentityPassphrase(passphrase);
    const hexKey = this.validHex(stored);
    const envelope = await encryptIdentityKey(hexKey, passphrase);
    // The plaintext is about to be replaced: make sure the passphrase opens what replaces it.
    if (await decryptIdentityKey(envelope, passphrase) !== hexKey) throw new Error(`Encrypting ${this.keyPath} failed its check; the file was left as it was.`);
    await this.writeKeyFile(envelope);
    return true;
  }

  /** Decrypts an encrypted key file in place; false when it already is plaintext. */
  async unprotect(): Promise<boolean> {
    const stored = await this.readKeyFile();
    if (stored === null) throw new Error(`No identity at ${this.keyPath}.`);
    if (!isIdentityEnvelope(stored)) return false;
    await this.writeKeyFile(await this.decrypt(stored));
    return true;
  }

  private validHex(stored: string): string {
    const hexKey = stored.replace(/^0x/, "");
    if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) throw new Error(`Identity at ${this.keyPath} is invalid: expected 64 hex characters.`);
    return hexKey.toLowerCase();
  }

  private async decrypt(envelope: string): Promise<string> {
    const passphrase = this.passphrase();
    if (!passphrase) {
      throw new Error(`Identity at ${this.keyPath} is encrypted; set ${PASSPHRASE_ENV} or ${PASSPHRASE_FILE_ENV} to unlock it.`);
    }
    const cached = decryptedKeys.get(envelope);
    if (cached?.passphrase === passphrase) return cached.hexKey;
    let hexKey: string;
    try {
      hexKey = await decryptIdentityKey(envelope, passphrase);
    } catch (error) {
      throw new Error(`Cannot unlock identity at ${this.keyPath}: ${(error as Error).message}`, { cause: error });
    }
    decryptedKeys.set(envelope, { passphrase, hexKey });
    return hexKey;
  }

  /** Owner-only and atomic, so a crash never leaves a half-written key. */
  private async writeKeyFile(content: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const temp = `${this.keyPath}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temp, content, { mode: 0o600, flag: "wx" });
      await rename(temp, this.keyPath);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Environment variable for passing identity hex from a parent process (e.g. desktop → CLI). */
const IDENTITY_HEX_ENV = 'ANTSEED_IDENTITY_HEX';

/** Cache the identity resolved from the env var so repeated calls in the same process return the same key. */
let _envIdentityCache: Identity | undefined;

export function identityFromPrivateKeyHex(hex: string): Identity {
  const privateKey = hexToBytes(hex);
  const wallet = new Wallet('0x' + hex);
  const peerId = toPeerId(wallet.address.slice(2).toLowerCase());
  return { peerId, privateKey, wallet };
}

/**
 * Load an existing identity or create and persist a new one.
 *
 * The identity is a secp256k1 private key stored as 64 hex chars.
 * The peerId is derived as the EVM address (lowercase, no 0x prefix).
 */
export async function loadOrCreateIdentity(configDirOrStore?: string | IdentityStore): Promise<Identity> {
  // Return cached env identity if we already resolved it in a prior call.
  if (_envIdentityCache) {
    return _envIdentityCache;
  }

  // Check for identity injected via environment (desktop → CLI child process).
  const rawEnvHex = process.env[IDENTITY_HEX_ENV]?.trim();
  const envHex = rawEnvHex?.startsWith('0x') ? rawEnvHex.slice(2) : rawEnvHex;
  if (envHex && envHex.length === 64) {
    delete process.env[IDENTITY_HEX_ENV];
    _envIdentityCache = identityFromPrivateKeyHex(envHex);
    return _envIdentityCache;
  }

  const store: IdentityStore =
    configDirOrStore === undefined || typeof configDirOrStore === 'string'
      ? new FileIdentityStore(configDirOrStore)
      : configDirOrStore;

  const existingHex = await store.load();
  if (existingHex !== null) {
    if (existingHex.length !== 64) {
      throw new Error(`Existing identity is invalid: expected 64 hex characters, found ${existingHex.length}. Refusing to replace it.`);
    }
    return identityFromPrivateKeyHex(existingHex);
  }

  // Key doesn't exist — generate a new secp256k1 private key.
  const privateKey = randomBytes(32);
  const hex = bytesToHex(privateKey);

  await store.save(hex);

  return identityFromPrivateKeyHex(hex);
}

// Signing primitives moved to @antseed/protocol; re-exported for compatibility.
export { signData, verifySignature, signUtf8, verifyUtf8 } from '@antseed/protocol/signing';
