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
import { buyerFault } from '../errors.js';
import type { PeerInfo } from '../types/peer.js';

/** How a buyer opens a relay stream. */
export interface RelayStreamOptions {
  /** Open the stream only on the connection with this session hash: the one a TEE attestation covered. */
  channelBinding?: string;
}

/**
 * Fails, as the buyer's own, when `conn` is not the connection
 * `options.channelBinding` names: a connection that replaced the attested
 * one carries no relay stream for a request that needs the attestation.
 */
export function requireAttestedConnection(conn: Pick<PeerConnection, 'channelBinding'>, peer: PeerInfo, options?: RelayStreamOptions): void {
  if (options?.channelBinding !== undefined && conn.channelBinding !== options.channelBinding) {
    throw buyerFault(
      `Connection to ${peer.peerId.slice(0, 12)}... is not the one its TEE attestation covered; verify the seller again`,
      'buyer-tee-connection-changed',
    );
  }
}

/**
 * What a seller allows one relay stream to reach, and what it is told when the
 * stream ends: a local byte stream the seller supplies (the keyed-relay
 * sidecar, which connects to the upstream itself).
 */
export interface RelayGrant {
  /** Supplies the stream's other end. Destroying it ends the stream. */
  open(): Duplex;
  /**
   * Asked before each chunk from the buyer is passed on: false when the seller
   * has no room to hold `bytes` more, and the stream then closes with that reason.
   */
  accept?(bytes: number): boolean;
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
  /** A stream holding more received bytes than this, because its reader fell behind, is closed. */
  maxBufferedBytes?: number;
}

const DEFAULT_MAX_STREAMS = 8;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const OPEN_TIMEOUT_MS = 30_000;
/**
 * A peer sends as fast as the connection carries, whatever the stream's reader
 * takes: the bytes received and not yet read are bounded here, per stream.
 */
const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const FELL_BEHIND = 'the relay stream fell behind';
const NO_ROOM = 'the seller is holding too many request bytes; retry shortly';

const MESSAGE_TYPE_NAME: Record<number, string> = {
  [MessageType.RelayOpen]: 'RelayOpen',
  [MessageType.RelayOpened]: 'RelayOpened',
  [MessageType.RelayData]: 'RelayData',
  [MessageType.RelayClose]: 'RelayClose',
};

interface SellerStream {
  socket: Duplex | null;
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
 * credential the seller minted for it; the seller joins it to the byte stream
 * it supplies for that credential (never to a host the buyer names) and copies
 * bytes both ways. The buyer runs TLS inside the stream, so the seller sees
 * ciphertext.
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

  /** Opens a stream on `credentialId`; resolves once the seller has opened its end. */
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
      if (this._sellerStreams.get(streamId) === stream) this._sellerStreams.delete(streamId);
      return refuse(error instanceof Error ? error.message : String(error));
    }
    stream.grant = grant;
    if (stream.closed) {
      // The stream ended while the seller was deciding, before there was a grant to tell.
      return this._closeGrant(stream, 'closed before it opened');
    }
    if (this._closed) return this._endSellerStream(streamId, 'closed before it opened', false);
    let socket: Duplex;
    try {
      socket = grant.open();
    } catch (error) {
      return this._endSellerStream(streamId, error instanceof Error ? error.message : String(error), true);
    }
    stream.socket = socket;
    // The supplied stream is open at once; its end ends the relay stream.
    socket.once('end', () => this._endSellerStream(streamId, '', true));
    this._touch(streamId);
    this._trySend(MessageType.RelayOpened, encodeRelayStreamId(streamId));
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
    this._closeGrant(stream, reason);
  }

  /** Tells a stream's grant, once, that the stream ended. */
  private _closeGrant(stream: SellerStream, reason: string): void {
    const grant = stream.grant;
    stream.grant = null;
    try {
      grant?.onClose?.({ bytesUp: stream.bytesUp, bytesDown: stream.bytesDown, ...(reason ? { error: reason } : {}) });
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
          if (seller.grant?.accept && !seller.grant.accept(data.length)) {
            this._endSellerStream(streamId, NO_ROOM, true);
            return true;
          }
          seller.bytesUp += data.length;
          this._touch(streamId);
          seller.socket.write(data);
          if (seller.socket.writableLength > this._maxBuffered()) this._endSellerStream(streamId, FELL_BEHIND, true);
          return true;
        }
        const buyer = this._buyerStreams.get(streamId);
        if (buyer?.opened) {
          this._touch(streamId);
          buyer.duplex.push(data);
          // Destroying it tells the seller, which stops sending.
          if (buyer.duplex.readableLength > this._maxBuffered()) buyer.duplex.destroy(new Error(FELL_BEHIND));
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

  private _maxBuffered(): number {
    return this._options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
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
