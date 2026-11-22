/**
 * The seller-keyed blind relay sidecar. The seller adds its own upstream
 * credential to a TLS session that the buyer runs to the upstream through the
 * seller, without the seller being able to read the session and without the
 * buyer seeing the credential. The cryptography (TLS key proof in zero
 * knowledge, the seller's record, revealing request bytes for the seller's
 * check and response bytes for billing) lives
 * in the Rust sidecar in `native/`; this module spawns it and speaks its framing.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';

/** Points at the sidecar binary, overriding the packaged one. */
export const KEYED_RELAY_BIN_ENV = 'ANTSEED_KEYED_RELAY_BIN';

const CTL = 0;
const PEER = 1;
const APP = 2;
/** Largest payload per frame; the sidecar accepts up to 1 MiB. */
const MAX_PAYLOAD = 64 * 1024;
/** How long a sidecar has to report and exit once its peer stream is gone, before it is stopped. */
const PEER_GONE_GRACE_MS = 2_000;

const BINARY_NAME = process.platform === 'win32' ? 'antseed-keyed-relay.exe' : 'antseed-keyed-relay';

/**
 * Finds the sidecar: `ANTSEED_KEYED_RELAY_BIN`, then the platform package
 * `@antseed/keyed-relay-<platform>-<arch>`, then a local `cargo build --release`.
 * Null when none is installed: keyed relaying is then off on this host.
 */
export function resolveKeyedRelayBinary(): string | null {
  const fromEnv = process.env[KEYED_RELAY_BIN_ENV];
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  try {
    // Bundled builds (desktop, Nix) may have no module URL; only the environment variable works there.
    const here = import.meta.url;
    try {
      const packaged = createRequire(here).resolve(`@antseed/keyed-relay-${process.platform}-${process.arch}/bin/${BINARY_NAME}`);
      if (existsSync(packaged)) return packaged;
    } catch {
      // No prebuilt binary for this platform.
    }
    const local = join(dirname(fileURLToPath(here)), '..', 'native', 'target', 'release', BINARY_NAME);
    return existsSync(local) ? local : null;
  } catch {
    return null;
  }
}

/** Bytes the buyer revealed: where they start in the stream, and the bytes (base64). */
export interface KeyedRelayRange {
  offset: number;
  data: string;
}

export type KeyedRelayEvent =
  | { type: 'ready' }
  | { type: 'injected' }
  /** Seller: the buyer's whole request is held, `length` bytes after the seller's head, with the ranges it revealed. Answer with `admit` or `refuse`. */
  | { type: 'request'; length: number; ranges: KeyedRelayRange[] }
  /** Both: the seller forwarded the request. */
  | { type: 'admitted' }
  /** Seller: the request was refused, and nothing of it reached the upstream. */
  | { type: 'refused'; reason: string }
  /** Both: the answer ended, `length` plaintext bytes of it. Seller: also when the buyer left before the upstream ended it, with what was relayed until then. */
  | { type: 'responseEnd'; length: number; bytesUp?: number; bytesDown?: number }
  | { type: 'revealed'; length: number; ranges: KeyedRelayRange[] }
  | { type: 'done' };

export interface KeyedRelaySellerStart {
  /** Where the seller connects. */
  host: string;
  port: number;
  /** The name the upstream's certificate must carry. */
  serverName: string;
  /** The seller's record: request line, Host, credential headers, Connection: close. */
  head: Uint8Array;
  /** The longest request (after the head) the seller holds for its check; 32 MiB if absent. */
  maxRequestBytes?: number;
  /** How long the upstream may take to end its answer once the request is forwarded; 15 minutes if absent. */
  responseTimeoutMs?: number;
  /** Tests only: an extra trusted root certificate (PEM). */
  extraRootsPem?: string;
}

export interface KeyedRelayBuyerStart {
  serverName: string;
  /** Tests only: an extra trusted root certificate (PEM). */
  extraRootsPem?: string;
}

export interface KeyedRelayExit {
  code: number | null;
  /** The sidecar's last stderr lines, which carry its error. */
  stderr: string;
}

/**
 * One sidecar process for one relayed request. `peer` is the byte stream to
 * the other side's sidecar: pipe it to the relay stream. Destroying `peer`
 * says the other side is gone: the sidecar reports what it has and exits, and
 * is stopped if it has not within a moment; `kill` stops it at once. Events:
 * `event` (KeyedRelayEvent), `app` (response bytes, buyer only), `appEnd`, `exit`.
 */
export class KeyedRelayProcess extends EventEmitter {
  readonly peer: Duplex;
  private _stdout = Buffer.alloc(0);
  private _stderr = '';
  private _exited: KeyedRelayExit | null = null;
  private _stopTimer: ReturnType<typeof setTimeout> | null = null;
  /** The latest event of each type, so a wait started late still sees it. */
  private readonly _seen = new Map<KeyedRelayEvent['type'], KeyedRelayEvent>();

  private constructor(private readonly _child: ChildProcess) {
    super();
    const send = (channel: number, payload: Uint8Array): boolean => this._send(channel, payload);
    const self = this;
    this.peer = new Duplex({
      // Ending both ways must not kill the sidecar: it may still be reporting why it stopped.
      autoDestroy: false,
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        let ok = true;
        for (let offset = 0; offset < chunk.length; offset += MAX_PAYLOAD) {
          ok = send(PEER, chunk.subarray(offset, offset + MAX_PAYLOAD)) && ok;
        }
        if (ok || self._exited) callback();
        else _child.stdin?.once('drain', () => callback());
      },
      final(callback) {
        send(PEER, new Uint8Array(0));
        callback();
      },
      destroy(error, callback) {
        // The other side is gone. The sidecar is told and stops by itself: a
        // seller first reports what it relayed, which the request is billed by.
        self._peerGone();
        callback(error);
      },
    });
    _child.stdout?.on('data', (data: Buffer) => this._onStdout(data));
    _child.stderr?.on('data', (data: Buffer) => {
      this._stderr = (this._stderr + data.toString('utf8')).slice(-4096);
    });
    _child.stdin?.on('error', () => {});
    const ended = (code: number | null): void => {
      if (this._exited) return;
      this._exited = { code, stderr: this._stderr.trim() };
      if (this._stopTimer) clearTimeout(this._stopTimer);
      if (!this.peer.destroyed) this.peer.push(null);
      this.emit('exit', this._exited);
    };
    _child.on('exit', ended);
    _child.on('error', (error) => {
      this._stderr += `\n${error.message}`;
      // A sidecar that never started has no exit of its own.
      if (_child.pid === undefined) ended(null);
    });
  }

  static spawn(role: 'buyer' | 'seller', binary: string): KeyedRelayProcess {
    const child = spawn(binary, [role], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    return new KeyedRelayProcess(child);
  }

  get exited(): KeyedRelayExit | null {
    return this._exited;
  }

  startSeller(config: KeyedRelaySellerStart): void {
    this._ctl({
      type: 'start',
      host: config.host,
      port: config.port,
      serverName: config.serverName,
      head: Buffer.from(config.head).toString('base64'),
      ...(config.maxRequestBytes !== undefined ? { maxRequestBytes: config.maxRequestBytes } : {}),
      ...(config.responseTimeoutMs !== undefined ? { responseTimeoutMs: config.responseTimeoutMs } : {}),
      ...(config.extraRootsPem ? { extraRootsPem: config.extraRootsPem } : {}),
    });
  }

  startBuyer(config: KeyedRelayBuyerStart): void {
    this._ctl({ type: 'start', serverName: config.serverName, ...(config.extraRootsPem ? { extraRootsPem: config.extraRootsPem } : {}) });
  }

  /** Buyer: plaintext request bytes that follow the seller's head. */
  writeApp(data: Uint8Array): void {
    for (let offset = 0; offset < data.length; offset += MAX_PAYLOAD) {
      this._send(APP, data.subarray(offset, offset + MAX_PAYLOAD));
    }
  }

  /**
   * Buyer, once the whole request is written: its length (the bytes written
   * with `writeApp`) and the ranges (offset, length) of it the seller checks
   * before it forwards the request.
   */
  revealRequest(length: number, ranges: Array<[number, number]>): void {
    this._ctl({ type: 'request', length, ranges });
  }

  /** Seller: forward the held request. */
  admit(): void {
    this._ctl({ type: 'admit' });
  }

  /** Seller: drop the held request; nothing of it reaches the upstream. The buyer gets `reason`. */
  refuse(reason: string): void {
    this._ctl({ type: 'refuse', reason });
  }

  /** Buyer: response ranges (offset, length) to reveal to the seller for billing. */
  reveal(ranges: Array<[number, number]>): void {
    this._ctl({ type: 'reveal', ranges });
  }

  /** Resolves with the event of `type`, already received or the next; rejects if the sidecar exits first or the wait runs out. */
  waitFor<T extends KeyedRelayEvent['type']>(type: T, timeoutMs: number): Promise<Extract<KeyedRelayEvent, { type: T }>> {
    return new Promise((resolve, reject) => {
      const onEvent = (event: KeyedRelayEvent): void => {
        if (event.type !== type) return;
        cleanup();
        resolve(event as Extract<KeyedRelayEvent, { type: T }>);
      };
      const onExit = (exit: KeyedRelayExit): void => {
        cleanup();
        reject(new Error(`keyed relay ended before "${type}": ${exit.stderr || `exit ${exit.code}`}`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`keyed relay: no "${type}" within ${timeoutMs} ms`));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.off('event', onEvent);
        this.off('exit', onExit);
      };
      const seen = this._seen.get(type);
      if (seen) {
        onEvent(seen);
        return;
      }
      if (this._exited) {
        onExit(this._exited);
        return;
      }
      this.on('event', onEvent);
      this.on('exit', onExit);
    });
  }

  kill(): void {
    if (!this._exited) this._child.kill();
  }

  /** Ends the peer stream towards the sidecar and stops the sidecar if it has not exited shortly after. */
  private _peerGone(): void {
    if (this._exited || this._stopTimer) return;
    this._send(PEER, new Uint8Array(0));
    this._stopTimer = setTimeout(() => this.kill(), PEER_GONE_GRACE_MS);
    this._stopTimer.unref();
  }

  private _ctl(message: Record<string, unknown>): void {
    this._send(CTL, Buffer.from(JSON.stringify(message), 'utf8'));
  }

  private _send(channel: number, payload: Uint8Array): boolean {
    const stdin = this._child.stdin;
    if (!stdin || stdin.destroyed || this._exited) return false;
    const header = Buffer.alloc(5);
    header[0] = channel;
    header.writeUInt32BE(payload.length, 1);
    return stdin.write(Buffer.concat([header, payload]));
  }

  private _onStdout(data: Buffer): void {
    this._stdout = Buffer.concat([this._stdout, data]);
    while (this._stdout.length >= 5) {
      const length = this._stdout.readUInt32BE(1);
      if (this._stdout.length < 5 + length) break;
      const channel = this._stdout[0];
      const payload = this._stdout.subarray(5, 5 + length);
      this._stdout = this._stdout.subarray(5 + length);
      if (channel === CTL) {
        let event: KeyedRelayEvent;
        try {
          event = JSON.parse(payload.toString('utf8')) as KeyedRelayEvent;
        } catch {
          this.kill();
          continue;
        }
        this._seen.set(event.type, event);
        this.emit('event', event);
      } else if (channel === PEER) {
        if (this.peer.destroyed) continue;
        if (payload.length === 0) this.peer.push(null);
        else this.peer.push(Buffer.from(payload));
      } else if (channel === APP) {
        if (payload.length === 0) this.emit('appEnd');
        else this.emit('app', Buffer.from(payload));
      }
    }
  }
}
