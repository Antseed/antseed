import { randomBytes } from "node:crypto";
import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { Wallet } from "ethers";
import { toPeerId, type PeerId } from "../types/peer.js";
import { hexToBytes, bytesToHex } from "../utils/hex.js";

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

/**
 * Stores identity private key as a hex file on disk (default behavior).
 */
export class FileIdentityStore implements IdentityStore {
  private readonly keyPath: string;
  private readonly encryptedKeyPath: string;
  private readonly dir: string;

  constructor(configDir?: string) {
    this.dir = configDir ?? CONFIG_DIR;
    this.keyPath = join(this.dir, PRIVATE_KEY_FILE);
    this.encryptedKeyPath = join(this.dir, ENCRYPTED_PRIVATE_KEY_FILE);
  }

  async load(): Promise<string | null> {
    try {
      const hexKey = (await readFile(this.keyPath, "utf-8")).trim();
      return hexKey;
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw new Error(`Unable to read identity at ${this.keyPath}; refusing to create a replacement identity.`, { cause: error });
      }
    }

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

  async save(hexKey: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.keyPath, hexKey, { mode: 0o600 });
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
