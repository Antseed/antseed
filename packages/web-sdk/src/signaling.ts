/**
 * Newline-delimited JSON signaling over a relay WebSocket. The relay pipes
 * bytes verbatim to the seller's TCP signaling port, so the messages here are
 * exactly what packages/node/src/p2p/connection-manager.ts expects.
 *
 * The hello line is sent as its own WebSocket frame: the seller caps all
 * bytes buffered before the first newline at 8 KiB, so the SDP offer must
 * never coalesce with the hello.
 */

import type { ConnectionAuthEnvelope } from './identity.js';

export type SignalingMessage =
  | { type: 'sdp'; sdp: string; descriptionType: string }
  | { type: 'candidate'; candidate: string; mid: string };

export interface HelloMessage {
  type: 'hello';
  auth: ConnectionAuthEnvelope;
  capabilities?: string[];
}

export type WebSocketLike = {
  binaryType: string;
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
};

export type WebSocketCtor = new (url: string) => WebSocketLike;

const MAX_LINE_BUFFER = 64 * 1024;

export class SignalingSocket {
  private ws: WebSocketLike;
  private buffer = '';
  private decoder = new TextDecoder();

  onMessage: (msg: SignalingMessage) => void = () => {};
  onClose: (reason: string) => void = () => {};

  private constructor(ws: WebSocketLike) {
    this.ws = ws;
  }

  static async connect(url: string, WebSocketImpl: WebSocketCtor): Promise<SignalingSocket> {
    const ws = new WebSocketImpl(url);
    ws.binaryType = 'arraybuffer';
    const socket = new SignalingSocket(ws);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error(`signaling connect failed: ${url}`)));
      ws.addEventListener('close', (event: { code?: number; reason?: string }) =>
        reject(new Error(`signaling closed: ${event.code} ${event.reason ?? ''}`)),
      );
    });
    ws.addEventListener('message', (event: { data: unknown }) => socket.handleData(event.data));
    ws.addEventListener('close', (event: { code?: number; reason?: string }) =>
      socket.onClose(`${event.code ?? ''} ${event.reason ?? ''}`.trim()),
    );
    return socket;
  }

  sendHello(hello: HelloMessage): void {
    this.ws.send(JSON.stringify(hello) + '\n');
  }

  sendSignal(msg: SignalingMessage): void {
    if (this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify(msg) + '\n');
  }

  close(): void {
    try {
      this.ws.close(1000, 'done');
    } catch {
      // already closed
    }
  }

  private handleData(data: unknown): void {
    if (typeof data === 'string') {
      this.buffer += data;
    } else if (data instanceof ArrayBuffer) {
      this.buffer += this.decoder.decode(new Uint8Array(data), { stream: true });
    } else if (ArrayBuffer.isView(data as ArrayBufferView)) {
      const view = data as ArrayBufferView;
      this.buffer += this.decoder.decode(
        new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
        { stream: true },
      );
    } else {
      return;
    }

    if (this.buffer.length > MAX_LINE_BUFFER) {
      this.close();
      this.onClose('signaling buffer overflow');
      return;
    }

    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let parsed: SignalingMessage;
      try {
        parsed = JSON.parse(line) as SignalingMessage;
      } catch {
        this.close();
        this.onClose('malformed signaling line');
        return;
      }
      this.onMessage(parsed);
    }
  }
}
