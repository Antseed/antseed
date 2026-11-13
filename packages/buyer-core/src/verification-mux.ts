import { MessageType, type FramedMessage, type ResponseAuthPayload } from '@antseed/protocol/messages';
import type { BuyerConnection } from './interfaces.js';
import { encodeFrame } from '@antseed/protocol/framing';
import { debugLog } from './debug.js';
import { decodeResponseAuth, encodeResponseAuth } from './verification-codec.js';

const MESSAGE_TYPE_NAME: Record<number, string> = {
  [MessageType.VerificationResponseAuth]: 'VerificationResponseAuth',
};

const MAX_BUFFERED_AUTHS = 256;
const DEFAULT_RESPONSE_AUTH_TIMEOUT_MS = 30_000;

export type VerificationMessageHandler<T> = (payload: T) => void | Promise<void>;

export class VerificationMux {
  private readonly _connection: BuyerConnection;
  private _messageIdCounter = 0;
  private _onResponseAuth?: VerificationMessageHandler<ResponseAuthPayload>;
  private readonly _pendingResponseAuths = new Map<string, PendingResponseAuth>();
  private readonly _bufferedResponseAuths = new Map<string, ResponseAuthPayload>();

  constructor(connection: BuyerConnection) {
    this._connection = connection;
  }

  onResponseAuth(handler: VerificationMessageHandler<ResponseAuthPayload>): void {
    this._onResponseAuth = handler;
  }

  sendResponseAuth(payload: ResponseAuthPayload): void {
    this._send(MessageType.VerificationResponseAuth, encodeResponseAuth(payload));
  }

  waitForResponseAuth(
    requestId: string,
    timeoutMs = DEFAULT_RESPONSE_AUTH_TIMEOUT_MS,
  ): Promise<ResponseAuthPayload> {
    const buffered = this._bufferedResponseAuths.get(requestId);
    if (buffered) {
      this._bufferedResponseAuths.delete(requestId);
      return Promise.resolve(buffered);
    }

    const existing = this._pendingResponseAuths.get(requestId);
    if (existing) return existing.promise;

    let resolve!: (payload: ResponseAuthPayload) => void;
    let reject!: (error: Error) => void;
    const timer = setTimeout(() => {
      this._pendingResponseAuths.delete(requestId);
      reject(new Error(`ResponseAuth timed out for request ${requestId}`));
    }, Math.max(1, timeoutMs));

    const promise = new Promise<ResponseAuthPayload>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this._pendingResponseAuths.set(requestId, { promise, resolve, reject, timer });
    return promise;
  }

  close(): void {
    for (const pending of this._pendingResponseAuths.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('VerificationMux closed'));
    }
    this._pendingResponseAuths.clear();
    this._bufferedResponseAuths.clear();
  }

  async handleFrame(frame: FramedMessage): Promise<boolean> {
    const name = MESSAGE_TYPE_NAME[frame.type];
    if (!name) return false;
    debugLog(`[VerificationMux] ← recv ${name} (${frame.payload.length}b)`);

    switch (frame.type) {
      case MessageType.VerificationResponseAuth: {
        const payload = decodeResponseAuth(frame.payload);
        const pending = this._pendingResponseAuths.get(payload.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this._pendingResponseAuths.delete(payload.requestId);
          pending.resolve(payload);
        } else {
          this._bufferResponseAuth(payload);
        }
        await this._onResponseAuth?.(payload);
        return true;
      }
      default:
        return false;
    }
  }

  static isVerificationMessage(type: number): boolean {
    return type >= 0x80 && type <= 0x8f;
  }

  private _bufferResponseAuth(payload: ResponseAuthPayload): void {
    if (this._bufferedResponseAuths.size >= MAX_BUFFERED_AUTHS) {
      const oldest = this._bufferedResponseAuths.keys().next().value as string | undefined;
      if (oldest) this._bufferedResponseAuths.delete(oldest);
    }
    this._bufferedResponseAuths.set(payload.requestId, payload);
  }

  private _send(type: MessageType, payload: Uint8Array): void {
    debugLog(`[VerificationMux] → send ${MESSAGE_TYPE_NAME[type] ?? `0x${type.toString(16)}`} (${payload.length}b)`);
    const frame = encodeFrame({
      type,
      messageId: this._messageIdCounter++ & 0xffffffff,
      payload,
    });
    this._connection.send(frame);
  }
}

interface PendingResponseAuth {
  promise: Promise<ResponseAuthPayload>;
  resolve: (payload: ResponseAuthPayload) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
