import { connect as netConnect, type Socket } from 'node:net';
import { Duplex } from 'node:stream';
import {
  RELAY_DATA_MAX_BYTES,
  decodeRelayClose,
  decodeRelayData,
  decodeRelayOpen,
  decodeRelayStreamId,
  encodeRelayClose,
  encodeRelayData,
  encodeRelayOpen,
  encodeRelayStreamId,
} from '@antseed/protocol/blind-relay';
import type { PeerConnection } from './connection-manager.js';
import { MessageType } from '../types/protocol.js';
import type { FramedMessage } from '../types/protocol.js';
import { encodeFrame } from './message-protocol.js';
import { debugLog, debugWarn } from '../utils/debug.js';

/** What a seller allows one relay stream to reach, and what it is told when the stream ends. */
export interface RelayGrant {
  host: string;
  port: number;
  /** Called once when the stream ends, however it ends. */
  onClose?(stats: { bytesUp: number; bytesDown: number; error?: string }): void;
}

/** Seller side: decides whether a stream may open. Throws (with a reason) to refuse it. */
export type RelayAuthorizer = (streamId: string, credentialId: string) => Promise<RelayGrant>;

export interface RelayMuxOptions {
  /** Seller side only. Without it every RelayOpen is refused. */
  authorize?: RelayAuthorizer;
  /** The most streams open at once on this connection. */
  maxStreams?: number;
  /** A stream with no bytes either way for this long is closed. */
  idleTimeoutMs?: number;
  /** Seller side: how long the TCP connect to the upstream may take. */
  connectTimeoutMs?: number;
  /** Tests: replaces the TCP connect. */
  connectImpl?: (host: string, port: number) => Socket;
}

const DEFAULT_MAX_STREAMS = 8;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const OPEN_TIMEOUT_MS = 30_000;

const MESSAGE_TYPE_NAME: Record<number, string> = {
  [MessageType.RelayOpen]: 'RelayOpen',
  [MessageType.RelayOpened]: 'RelayOpened',
  [MessageType.RelayData]: 'RelayData',
  [MessageType.RelayClose]: 'RelayClose',
};

interface SellerStream {
  socket: Socket | null;
  grant: RelayGrant | null;
  bytesUp: number;
  bytesDown: number;
  closed: boolean;
}

interface BuyerStream {
  duplex: Duplex;
  opened: boolean;
  open: { resolve(): void; reject(error: Error): void } | null;
}

/**
 * Raw byte streams over a peer connection. The buyer opens a stream naming a
 * credential the seller minted for it; the seller connects to that
 * credential's upstream host (never one the buyer names) and copies bytes both
 * ways. The buyer runs TLS inside the stream, so the seller sees ciphertext.
 */
export class RelayMux {
  private readonly _sellerStreams = new Map<string, SellerStream>();
  private readonly _buyerStreams = new Map<string, BuyerStream>();
  private readonly _idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private _messageIdCounter = 0;
  private _closed = false;

  constructor(private readonly _connection: PeerConnection, private readonly _options: RelayMuxOptions = {}) {}

  static isRelayMessage(type: number): boolean {
    return type >= 0x30 && type <= 0x3f;
  }

  get openStreams(): number {
    return this._sellerStreams.size + this._buyerStreams.size;
  }

  // ── Buyer side ──────────────────────────────────────────────

  /** Opens a stream to the upstream of `credentialId`; resolves once the seller has connected. */
  openStream(streamId: string, credentialId: string): Promise<Duplex> {
    if (this._closed) return Promise.reject(new Error('connection closed'));
    if (this._buyerStreams.has(streamId)) return Promise.reject(new Error(`relay stream ${streamId} already open`));
    if (this.openStreams >= (this._options.maxStreams ?? DEFAULT_MAX_STREAMS)) {
      return Promise.reject(new Error('too many relay streams open'));
    }
    const duplex = new Duplex({
      write: (chunk: Buffer, _encoding, callback) => {
        try {
          for (let offset = 0; offset < chunk.length; offset += RELAY_DATA_MAX_BYTES) {
            this._send(MessageType.RelayData, encodeRelayData({ streamId, data: chunk.subarray(offset, offset + RELAY_DATA_MAX_BYTES) }));
          }
          this._touch(streamId);
          const writable = this._connection.whenWritable?.();
          if (writable) writable.then(() => callback(), callback);
          else callback();
        } catch (error) {
          callback(error as Error);
        }
      },
      read: () => {},
      // Ending the write side keeps the stream open for the answer; destroy closes it.
      final: (callback) => callback(),
      destroy: (error, callback) => {
        this._finishBuyerStream(streamId, error ? error.message || 'cancelled' : '');
        callback(error);
      },
    });
    const stream: BuyerStream = { duplex, opened: false, open: null };
    this._buyerStreams.set(streamId, stream);
    return new Promise<Duplex>((resolve, reject) => {
      const timer = setTimeout(() => stream.open?.reject(new Error('the seller did not open the relay stream in time')), OPEN_TIMEOUT_MS);
      stream.open = {
        resolve: () => { clearTimeout(timer); stream.open = null; resolve(duplex); },
        reject: (error) => { clearTimeout(timer); stream.open = null; this._dropBuyerStream(streamId); reject(error); },
      };
      try {
        this._send(MessageType.RelayOpen, encodeRelayOpen({ streamId, credentialId }));
      } catch (error) {
        stream.open.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private _finishBuyerStream(streamId: string, reason: string): void {
    const stream = this._buyerStreams.get(streamId);
    if (!stream) return;
    this._dropBuyerStream(streamId);
    this._trySend(MessageType.RelayClose, encodeRelayClose({ streamId, reason }));
  }

  private _dropBuyerStream(streamId: string): void {
    this._buyerStreams.delete(streamId);
    this._clearIdle(streamId);
  }

  // ── Seller side ─────────────────────────────────────────────

  private async _handleOpen(streamId: string, credentialId: string): Promise<void> {
    const refuse = (reason: string): void => {
      this._trySend(MessageType.RelayClose, encodeRelayClose({ streamId, reason }));
    };
    if (this._sellerStreams.has(streamId)) return refuse('stream id in use');
    if (!this._options.authorize) return refuse('this seller does not relay');
    if (this.openStreams >= (this._options.maxStreams ?? DEFAULT_MAX_STREAMS)) return refuse('too many relay streams open');
    const stream: SellerStream = { socket: null, grant: null, bytesUp: 0, bytesDown: 0, closed: false };
    this._sellerStreams.set(streamId, stream);
    let grant: RelayGrant;
    try {
      grant = await this._options.authorize(streamId, credentialId);
    } catch (error) {
      this._sellerStreams.delete(streamId);
      return refuse(error instanceof Error ? error.message : String(error));
    }
    stream.grant = grant;
    if (stream.closed || this._closed) return this._endSellerStream(streamId, 'closed before it opened', false);
    const socket = (this._options.connectImpl ?? ((host, port) => netConnect({ host, port })))(grant.host, grant.port);
    stream.socket = socket;
    socket.setTimeout(this._options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
    socket.once('connect', () => {
      socket.setTimeout(0);
      if (stream.closed) return;
      this._touch(streamId);
      this._trySend(MessageType.RelayOpened, encodeRelayStreamId(streamId));
    });
    socket.once('timeout', () => socket.destroy(new Error('upstream connect timed out')));
    socket.on('data', (data: Buffer) => {
      stream.bytesDown += data.length;
      this._touch(streamId);
      for (let offset = 0; offset < data.length; offset += RELAY_DATA_MAX_BYTES) {
        if (!this._trySend(MessageType.RelayData, encodeRelayData({ streamId, data: data.subarray(offset, offset + RELAY_DATA_MAX_BYTES) }))) {
          socket.destroy();
          return;
        }
      }
      const writable = this._connection.whenWritable?.();
      if (writable) {
        socket.pause();
        writable.then(() => socket.resume(), () => socket.destroy());
      }
    });
    socket.once('error', (error) => this._endSellerStream(streamId, error.message, true));
    socket.once('close', () => this._endSellerStream(streamId, '', true));
  }

  private _endSellerStream(streamId: string, reason: string, notify: boolean): void {
    const stream = this._sellerStreams.get(streamId);
    if (!stream || stream.closed) return;
    stream.closed = true;
    this._sellerStreams.delete(streamId);
    this._clearIdle(streamId);
    stream.socket?.destroy();
    if (notify) this._trySend(MessageType.RelayClose, encodeRelayClose({ streamId, reason }));
    try {
      stream.grant?.onClose?.({ bytesUp: stream.bytesUp, bytesDown: stream.bytesDown, ...(reason ? { error: reason } : {}) });
    } catch (error) {
      debugWarn(`[RelayMux] onClose failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  // ── Frames ──────────────────────────────────────────────────

  async handleFrame(frame: FramedMessage): Promise<boolean> {
    const name = MESSAGE_TYPE_NAME[frame.type];
    if (!name) return false;
    switch (frame.type) {
      case MessageType.RelayOpen: {
        const { streamId, credentialId } = decodeRelayOpen(frame.payload);
        debugLog(`[RelayMux] ← RelayOpen ${streamId.slice(0, 8)}`);
        await this._handleOpen(streamId, credentialId);
        return true;
      }
      case MessageType.RelayOpened: {
        const stream = this._buyerStreams.get(decodeRelayStreamId(frame.payload));
        if (stream && !stream.opened) {
          stream.opened = true;
          this._touch(decodeRelayStreamId(frame.payload));
          stream.open?.resolve();
        }
        return true;
      }
      case MessageType.RelayData: {
        const { streamId, data } = decodeRelayData(frame.payload);
        const seller = this._sellerStreams.get(streamId);
        if (seller) {
          if (!seller.socket) return true;
          seller.bytesUp += data.length;
          this._touch(streamId);
          seller.socket.write(data);
          return true;
        }
        const buyer = this._buyerStreams.get(streamId);
        if (buyer?.opened) {
          this._touch(streamId);
          buyer.duplex.push(data);
        }
        return true;
      }
      case MessageType.RelayClose: {
        const { streamId, reason } = decodeRelayClose(frame.payload);
        if (this._sellerStreams.has(streamId)) {
          this._endSellerStream(streamId, reason, false);
          return true;
        }
        const buyer = this._buyerStreams.get(streamId);
        if (!buyer) return true;
        if (!buyer.opened) {
          buyer.open?.reject(new Error(reason || 'the seller refused the relay stream'));
          return true;
        }
        this._dropBuyerStream(streamId);
        if (reason) buyer.duplex.destroy(new Error(`relay closed: ${reason}`));
        else buyer.duplex.push(null);
        return true;
      }
      default:
        return false;
    }
  }

  /** The connection is gone: end every stream. */
  close(): void {
    if (this._closed) return;
    this._closed = true;
    for (const streamId of [...this._sellerStreams.keys()]) this._endSellerStream(streamId, 'connection closed', false);
    for (const [streamId, stream] of [...this._buyerStreams]) {
      this._dropBuyerStream(streamId);
      if (stream.open) stream.open.reject(new Error('connection closed'));
      else stream.duplex.destroy(new Error('connection closed'));
    }
  }

  private _touch(streamId: string): void {
    this._clearIdle(streamId);
    const timer = setTimeout(() => {
      this._idleTimers.delete(streamId);
      if (this._sellerStreams.has(streamId)) this._endSellerStream(streamId, 'idle', true);
      else this._buyerStreams.get(streamId)?.duplex.destroy(new Error('relay stream idle'));
    }, this._options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
    timer.unref?.();
    this._idleTimers.set(streamId, timer);
  }

  private _clearIdle(streamId: string): void {
    const timer = this._idleTimers.get(streamId);
    if (timer) clearTimeout(timer);
    this._idleTimers.delete(streamId);
  }

  private _send(type: MessageType, payload: Uint8Array): void {
    this._connection.send(encodeFrame({ type, messageId: this._messageIdCounter, payload }));
    this._messageIdCounter = (this._messageIdCounter + 1) & 0xffffffff;
  }

  private _trySend(type: MessageType, payload: Uint8Array): boolean {
    try {
      this._send(type, payload);
      return true;
    } catch (error) {
      debugLog(`[RelayMux] drop ${MESSAGE_TYPE_NAME[type]}: ${error instanceof Error ? error.message : error}`);
      return false;
    }
  }
}
