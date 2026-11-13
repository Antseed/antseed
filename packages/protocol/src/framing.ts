import {
  MessageType,
  type FramedMessage,
  FRAME_HEADER_SIZE,
  MAX_PAYLOAD_SIZE,
} from "./messages.js";

/**
 * Frame layout (9 bytes header + payload):
 *   [0]       u8   — message type
 *   [1..4]    u32  — message ID (big-endian)
 *   [5..8]    u32  — payload length (big-endian)
 *   [9..]     raw  — payload bytes
 */

/** Encode a FramedMessage into a binary buffer. */
export function encodeFrame(msg: FramedMessage): Uint8Array {
  if (msg.payload.length > MAX_PAYLOAD_SIZE) {
    throw new Error(
      `Payload too large: ${msg.payload.length} > ${MAX_PAYLOAD_SIZE}`
    );
  }

  const frame = new Uint8Array(FRAME_HEADER_SIZE + msg.payload.length);
  const view = new DataView(frame.buffer);

  view.setUint8(0, msg.type);
  view.setUint32(1, msg.messageId);
  view.setUint32(5, msg.payload.length);
  frame.set(msg.payload, FRAME_HEADER_SIZE);

  return frame;
}

/**
 * Decode a single FramedMessage from a binary buffer.
 * Returns the message and the number of bytes consumed.
 * Returns null if the buffer doesn't contain a complete frame.
 */
export function decodeFrame(
  data: Uint8Array
): { message: FramedMessage; bytesConsumed: number } | null {
  if (data.length < FRAME_HEADER_SIZE) {
    return null;
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const type = view.getUint8(0);
  const messageId = view.getUint32(1);
  const payloadLength = view.getUint32(5);

  if (payloadLength > MAX_PAYLOAD_SIZE) {
    throw new Error(
      `Payload length ${payloadLength} exceeds maximum ${MAX_PAYLOAD_SIZE}`
    );
  }

  const totalLength = FRAME_HEADER_SIZE + payloadLength;
  if (data.length < totalLength) {
    return null; // incomplete frame
  }

  const payload = data.slice(FRAME_HEADER_SIZE, totalLength);

  return {
    message: { type, messageId, payload },
    bytesConsumed: totalLength,
  };
}

/**
 * Streaming frame decoder that handles partial frames across
 * multiple data chunks (e.g., from a DataChannel).
 */
export class FrameDecoder {
  private _buffer: Uint8Array = new Uint8Array(0);

  /** Feed new data and return any complete frames. */
  feed(chunk: Uint8Array): FramedMessage[] {
    // Append chunk to buffer
    const newBuffer = new Uint8Array(this._buffer.length + chunk.length);
    newBuffer.set(this._buffer, 0);
    newBuffer.set(chunk, this._buffer.length);
    this._buffer = newBuffer;

    const messages: FramedMessage[] = [];

    while (true) {
      let result: ReturnType<typeof decodeFrame>;
      try {
        result = decodeFrame(this._buffer);
      } catch (err) {
        this._buffer = new Uint8Array(0);
        throw err;
      }
      if (!result) break;

      messages.push(result.message);
      this._buffer = this._buffer.slice(result.bytesConsumed);
    }

    return messages;
  }

  /** Reset the internal buffer. */
  reset(): void {
    this._buffer = new Uint8Array(0);
  }

  /** Number of buffered bytes not yet decoded. */
  get bufferedBytes(): number {
    return this._buffer.length;
  }
}

/** Handler function for a specific message type. */
export type MessageHandler = (msg: FramedMessage) => void | Promise<void>;

/**
 * Message multiplexer — routes decoded frames to registered handlers.
 */
export class MessageMux {
  private _handlers = new Map<MessageType, MessageHandler[]>();
  private _defaultHandler: MessageHandler | null = null;

  /** Register a handler for a specific message type. */
  on(type: MessageType, handler: MessageHandler): void {
    const existing = this._handlers.get(type) ?? [];
    existing.push(handler);
    this._handlers.set(type, existing);
  }

  /** Remove a handler for a specific message type. */
  off(type: MessageType, handler: MessageHandler): void {
    const existing = this._handlers.get(type);
    if (!existing) return;
    const idx = existing.indexOf(handler);
    if (idx !== -1) {
      existing.splice(idx, 1);
    }
  }

  /** Set a default handler for unregistered message types. */
  setDefaultHandler(handler: MessageHandler): void {
    this._defaultHandler = handler;
  }

  /** Dispatch a framed message to registered handlers. */
  async dispatch(msg: FramedMessage): Promise<void> {
    const handlers = this._handlers.get(msg.type);
    if (handlers && handlers.length > 0) {
      for (const handler of handlers) {
        await handler(msg);
      }
    } else if (this._defaultHandler) {
      await this._defaultHandler(msg);
    }
  }
}
