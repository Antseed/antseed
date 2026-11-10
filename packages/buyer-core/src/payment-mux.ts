import type { BuyerConnection } from './interfaces.js';
import { MessageType } from '@antseed/protocol/messages';
import type {
  SpendingAuthPayload,
  AuthAckPayload,
  FreeUsageOpenPayload,
  FreeUsageAuthPayload,
  FreeUsageAckPayload,
  NeedFreeUsageAuthPayload,
  PaymentRequiredPayload,
  NeedAuthPayload,
  CloseChannelRequestPayload,
  CloseChannelResultPayload,
} from '@antseed/protocol/messages';
import { encodeFrame } from '@antseed/protocol/framing';
import type { FramedMessage } from '@antseed/protocol/messages';
import * as codec from '@antseed/protocol/payment-codec';
import { debugLog } from './debug.js';
import { hitFailpointSync } from './failpoints.js';

const MESSAGE_TYPE_NAME: Record<number, string> = {
  [MessageType.SpendingAuth]: 'SpendingAuth',
  [MessageType.AuthAck]: 'AuthAck',
  [MessageType.FreeUsageOpen]: 'FreeUsageOpen',
  [MessageType.FreeUsageAuth]: 'FreeUsageAuth',
  [MessageType.FreeUsageAck]: 'FreeUsageAck',
  [MessageType.NeedFreeUsageAuth]: 'NeedFreeUsageAuth',
  [MessageType.PaymentRequired]: 'PaymentRequired',
  [MessageType.NeedAuth]: 'NeedAuth',
  [MessageType.CloseChannelRequest]: 'CloseChannelRequest',
  [MessageType.CloseChannelResult]: 'CloseChannelResult',
};

export type PaymentMessageHandler<T> = (payload: T) => void | Promise<void>;

/**
 * Multiplexes payment messages over a BuyerConnection.
 * Register handlers for each message type, then call handleFrame()
 * when a payment-range frame arrives.
 */
export class PaymentMux {
  private _connection: BuyerConnection;
  private _messageIdCounter = 0;

  // Handler registrations
  private _onSpendingAuth?: PaymentMessageHandler<SpendingAuthPayload>;
  private _onAuthAck?: PaymentMessageHandler<AuthAckPayload>;
  private _onFreeUsageOpen?: PaymentMessageHandler<FreeUsageOpenPayload>;
  private _onFreeUsageAuth?: PaymentMessageHandler<FreeUsageAuthPayload>;
  private _onFreeUsageAck?: PaymentMessageHandler<FreeUsageAckPayload>;
  private _onNeedFreeUsageAuth?: PaymentMessageHandler<NeedFreeUsageAuthPayload>;
  private _onPaymentRequired?: PaymentMessageHandler<PaymentRequiredPayload>;
  private _onNeedAuth?: PaymentMessageHandler<NeedAuthPayload>;
  private _onCloseChannelRequest?: PaymentMessageHandler<CloseChannelRequestPayload>;
  private _onCloseChannelResult?: PaymentMessageHandler<CloseChannelResultPayload>;

  constructor(connection: BuyerConnection) {
    this._connection = connection;
  }

  // --- Handler registration ---
  onSpendingAuth(handler: PaymentMessageHandler<SpendingAuthPayload>): void {
    this._onSpendingAuth = handler;
  }
  onAuthAck(handler: PaymentMessageHandler<AuthAckPayload>): void {
    this._onAuthAck = handler;
  }
  onFreeUsageOpen(handler: PaymentMessageHandler<FreeUsageOpenPayload>): void {
    this._onFreeUsageOpen = handler;
  }
  onFreeUsageAuth(handler: PaymentMessageHandler<FreeUsageAuthPayload>): void {
    this._onFreeUsageAuth = handler;
  }
  onFreeUsageAck(handler: PaymentMessageHandler<FreeUsageAckPayload>): void {
    this._onFreeUsageAck = handler;
  }
  onNeedFreeUsageAuth(handler: PaymentMessageHandler<NeedFreeUsageAuthPayload>): void {
    this._onNeedFreeUsageAuth = handler;
  }
  onPaymentRequired(handler: PaymentMessageHandler<PaymentRequiredPayload>): void {
    this._onPaymentRequired = handler;
  }
  onNeedAuth(handler: PaymentMessageHandler<NeedAuthPayload>): void {
    this._onNeedAuth = handler;
  }
  onCloseChannelRequest(handler: PaymentMessageHandler<CloseChannelRequestPayload>): void {
    this._onCloseChannelRequest = handler;
  }
  onCloseChannelResult(handler: PaymentMessageHandler<CloseChannelResultPayload>): void {
    this._onCloseChannelResult = handler;
  }

  // --- Sending ---
  /**
   * Every SpendingAuth and ReserveAuth frame the buyer sends goes through here. A frame with a reserve
   * ceiling is a ReserveAuth (the opening reserve or a top-up); anything else is a SpendingAuth.
   */
  sendSpendingAuth(payload: SpendingAuthPayload): void {
    const kind = payload.reserveMaxAmount !== undefined ? 'reserve-auth' : 'spending-auth';
    hitFailpointSync(`buyer.${kind}.before-send`, `${payload.channelId}:${payload.cumulativeAmount}`);
    this._send(MessageType.SpendingAuth, codec.encodeSpendingAuth(payload));
    hitFailpointSync(`buyer.${kind}.after-send`, `${payload.channelId}:${payload.cumulativeAmount}`);
  }
  sendAuthAck(payload: AuthAckPayload): void {
    this._send(MessageType.AuthAck, codec.encodeAuthAck(payload));
  }
  sendFreeUsageOpen(payload: FreeUsageOpenPayload): void {
    this._send(MessageType.FreeUsageOpen, codec.encodeFreeUsageOpen(payload));
  }
  sendFreeUsageAuth(payload: FreeUsageAuthPayload): void {
    this._send(MessageType.FreeUsageAuth, codec.encodeFreeUsageAuth(payload));
  }
  sendFreeUsageAck(payload: FreeUsageAckPayload): void {
    this._send(MessageType.FreeUsageAck, codec.encodeFreeUsageAck(payload));
  }
  sendNeedFreeUsageAuth(payload: NeedFreeUsageAuthPayload): void {
    this._send(MessageType.NeedFreeUsageAuth, codec.encodeNeedFreeUsageAuth(payload));
  }
  sendPaymentRequired(payload: PaymentRequiredPayload): void {
    this._send(MessageType.PaymentRequired, codec.encodePaymentRequired(payload));
  }
  sendNeedAuth(payload: NeedAuthPayload): void {
    this._send(MessageType.NeedAuth, codec.encodeNeedAuth(payload));
  }
  sendCloseChannelRequest(payload: CloseChannelRequestPayload): void {
    this._send(MessageType.CloseChannelRequest, codec.encodeCloseChannelRequest(payload));
  }
  sendCloseChannelResult(payload: CloseChannelResultPayload): void {
    this._send(MessageType.CloseChannelResult, codec.encodeCloseChannelResult(payload));
  }

  // --- Receiving ---
  /**
   * Returns true if this frame is a payment message and was handled.
   */
  async handleFrame(frame: FramedMessage): Promise<boolean> {
    const name = MESSAGE_TYPE_NAME[frame.type];
    if (!name) return false;
    debugLog(`[PaymentMux] ← recv ${name} (${frame.payload.length}b)`);
    switch (frame.type) {
      case MessageType.SpendingAuth:
        await this._onSpendingAuth?.(codec.decodeSpendingAuth(frame.payload));
        return true;
      case MessageType.AuthAck:
        await this._onAuthAck?.(codec.decodeAuthAck(frame.payload));
        return true;
      case MessageType.FreeUsageOpen:
        await this._onFreeUsageOpen?.(codec.decodeFreeUsageOpen(frame.payload));
        return true;
      case MessageType.FreeUsageAuth:
        await this._onFreeUsageAuth?.(codec.decodeFreeUsageAuth(frame.payload));
        return true;
      case MessageType.FreeUsageAck:
        await this._onFreeUsageAck?.(codec.decodeFreeUsageAck(frame.payload));
        return true;
      case MessageType.NeedFreeUsageAuth:
        await this._onNeedFreeUsageAuth?.(codec.decodeNeedFreeUsageAuth(frame.payload));
        return true;
      case MessageType.PaymentRequired:
        await this._onPaymentRequired?.(codec.decodePaymentRequired(frame.payload));
        return true;
      case MessageType.NeedAuth:
        await this._onNeedAuth?.(codec.decodeNeedAuth(frame.payload));
        return true;
      case MessageType.CloseChannelRequest:
        await this._onCloseChannelRequest?.(codec.decodeCloseChannelRequest(frame.payload));
        return true;
      case MessageType.CloseChannelResult:
        await this._onCloseChannelResult?.(codec.decodeCloseChannelResult(frame.payload));
        return true;
      default:
        return false;
    }
  }

  /** Check if a message type is in the payment range (0x50-0x5F). */
  static isPaymentMessage(type: number): boolean {
    return type >= 0x50 && type <= 0x5f;
  }

  private _send(type: MessageType, payload: Uint8Array): void {
    const name = MESSAGE_TYPE_NAME[type] ?? `0x${type.toString(16)}`;
    debugLog(`[PaymentMux] → send ${name} (${payload.length}b)`);
    const frame = encodeFrame({
      type,
      messageId: this._messageIdCounter++ & 0xffffffff,
      payload,
    });
    this._connection.send(frame);
  }
}
