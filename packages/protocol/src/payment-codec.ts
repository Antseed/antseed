import {
  PAYMENT_CODE_CHANNEL_EXHAUSTED,
  CLOSE_CHANNEL_REJECT_CODES,
  type SpendingAuthPayload,
  type AuthAckPayload,
  type FreeUsageOpenPayload,
  type FreeUsageAuthPayload,
  type FreeUsageAckPayload,
  type NeedFreeUsageAuthPayload,
  type PaymentRequiredPayload,
  type NeedAuthPayload,
  type CloseChannelRequestPayload,
  type CloseChannelResultPayload,
  type CloseChannelRejectCode,
} from './messages.js';
import type { UnitBillingUsageReportV1 } from './billing.js';
import { validateUnitBillingUsageReportV1 } from './billing.js';
import { parseJsonObject, requireStringField } from './json-codec.js';

const encoder = new TextEncoder();

// --- Validation helpers ---

const MAX_PAYLOAD_SIZE = 65536; // 64KB

function parsePaymentJson(data: Uint8Array): Record<string, unknown> {
  return parseJsonObject(data, {
    maxBytes: MAX_PAYLOAD_SIZE,
    payloadName: 'Payment payload',
  });
}

function requireFiniteNumberField(obj: Record<string, unknown>, field: string): number {
  const value = typeof obj[field] === 'number' ? obj[field] : Number(requireStringField(obj, field));
  if (!Number.isFinite(value)) {
    throw new Error(`Payment payload field "${field}" must be a finite number`);
  }
  return value;
}

// --- Encoders ---

export function encodeSpendingAuth(payload: SpendingAuthPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeAuthAck(payload: AuthAckPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeFreeUsageOpen(payload: FreeUsageOpenPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeFreeUsageAuth(payload: FreeUsageAuthPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeFreeUsageAck(payload: FreeUsageAckPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeNeedFreeUsageAuth(payload: NeedFreeUsageAuthPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodePaymentRequired(payload: PaymentRequiredPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeNeedAuth(payload: NeedAuthPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeCloseChannelRequest(payload: CloseChannelRequestPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeCloseChannelResult(payload: CloseChannelResultPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

// --- Decoders (with runtime validation) ---

export function decodeSpendingAuth(data: Uint8Array): SpendingAuthPayload {
  const obj = parsePaymentJson(data);
  const result: SpendingAuthPayload = {
    channelId: requireStringField(obj, 'channelId'),
    cumulativeAmount: requireStringField(obj, 'cumulativeAmount'),
    metadataHash: requireStringField(obj, 'metadataHash'),
    metadata: typeof obj.metadata === 'string' ? obj.metadata : '',
    spendingAuthSig: requireStringField(obj, 'spendingAuthSig'),
  };
  // Optional reserve params (only on initial auth)
  if (typeof obj.reserveSalt === 'string') result.reserveSalt = obj.reserveSalt;
  if (typeof obj.reserveMaxAmount === 'string') result.reserveMaxAmount = obj.reserveMaxAmount;
  if (typeof obj.reserveDeadline === 'number') result.reserveDeadline = obj.reserveDeadline;
  return result;
}

export function decodeAuthAck(data: Uint8Array): AuthAckPayload {
  const obj = parsePaymentJson(data);
  return {
    channelId: requireStringField(obj, 'channelId'),
  };
}

export function decodeFreeUsageOpen(data: Uint8Array): FreeUsageOpenPayload {
  const obj = parsePaymentJson(data);
  return {
    channelId: requireStringField(obj, 'channelId'),
    salt: requireStringField(obj, 'salt'),
    deadline: requireFiniteNumberField(obj, 'deadline'),
    openSig: requireStringField(obj, 'openSig'),
  };
}

export function decodeFreeUsageAuth(data: Uint8Array): FreeUsageAuthPayload {
  const obj = parsePaymentJson(data);
  return {
    channelId: requireStringField(obj, 'channelId'),
    cumulativeInputTokens: requireStringField(obj, 'cumulativeInputTokens'),
    cumulativeOutputTokens: requireStringField(obj, 'cumulativeOutputTokens'),
    sequence: requireStringField(obj, 'sequence'),
    metadataHash: requireStringField(obj, 'metadataHash'),
    metadata: requireStringField(obj, 'metadata'),
    deadline: requireFiniteNumberField(obj, 'deadline'),
    usageSig: requireStringField(obj, 'usageSig'),
  };
}

export function decodeFreeUsageAck(data: Uint8Array): FreeUsageAckPayload {
  const obj = parsePaymentJson(data);
  const result: FreeUsageAckPayload = {
    channelId: requireStringField(obj, 'channelId'),
  };
  if (typeof obj.acceptedSequence === 'string') result.acceptedSequence = obj.acceptedSequence;
  return result;
}

export function decodeNeedFreeUsageAuth(data: Uint8Array): NeedFreeUsageAuthPayload {
  const obj = parsePaymentJson(data);
  const result: NeedFreeUsageAuthPayload = {
    channelId: requireStringField(obj, 'channelId'),
    requiredSequence: requireStringField(obj, 'requiredSequence'),
    currentAcceptedSequence: requireStringField(obj, 'currentAcceptedSequence'),
  };
  if (typeof obj.requestId === 'string') result.requestId = obj.requestId;
  if (typeof obj.inputTokens === 'string') result.inputTokens = obj.inputTokens;
  if (typeof obj.outputTokens === 'string') result.outputTokens = obj.outputTokens;
  if (typeof obj.service === 'string') result.service = obj.service;
  return result;
}

export function decodePaymentRequired(data: Uint8Array): PaymentRequiredPayload {
  const obj = parsePaymentJson(data);
  const result: PaymentRequiredPayload = {
    minBudgetPerRequest: requireStringField(obj, 'minBudgetPerRequest'),
    suggestedAmount: requireStringField(obj, 'suggestedAmount'),
    requestId: requireStringField(obj, 'requestId'),
  };
  if (typeof obj.inputUsdPerMillion === 'number') result.inputUsdPerMillion = obj.inputUsdPerMillion;
  if (typeof obj.outputUsdPerMillion === 'number') result.outputUsdPerMillion = obj.outputUsdPerMillion;
  if (typeof obj.cachedInputUsdPerMillion === 'number') result.cachedInputUsdPerMillion = obj.cachedInputUsdPerMillion;
  if (typeof obj.requiredCumulativeAmount === 'string') result.requiredCumulativeAmount = obj.requiredCumulativeAmount;
  if (typeof obj.currentSpent === 'string') result.currentSpent = obj.currentSpent;
  if (typeof obj.currentAcceptedCumulative === 'string') result.currentAcceptedCumulative = obj.currentAcceptedCumulative;
  if (typeof obj.channelId === 'string') result.channelId = obj.channelId;
  if (typeof obj.reserveMaxAmount === 'string') result.reserveMaxAmount = obj.reserveMaxAmount;
  if (obj.code === PAYMENT_CODE_CHANNEL_EXHAUSTED) result.code = obj.code;
  return result;
}

export function decodeNeedAuth(data: Uint8Array): NeedAuthPayload {
  const obj = parsePaymentJson(data);
  const result: NeedAuthPayload = {
    channelId: requireStringField(obj, 'channelId'),
    requiredCumulativeAmount: requireStringField(obj, 'requiredCumulativeAmount'),
    currentAcceptedCumulative: requireStringField(obj, 'currentAcceptedCumulative'),
    deposit: requireStringField(obj, 'deposit'),
  };
  if (typeof obj.requestId === 'string') result.requestId = obj.requestId;
  if (typeof obj.lastRequestCost === 'string') result.lastRequestCost = obj.lastRequestCost;
  if (typeof obj.inputTokens === 'string') result.inputTokens = obj.inputTokens;
  if (typeof obj.outputTokens === 'string') result.outputTokens = obj.outputTokens;
  if (typeof obj.cachedInputTokens === 'string') result.cachedInputTokens = obj.cachedInputTokens;
  if (typeof obj.freshInputTokens === 'string') result.freshInputTokens = obj.freshInputTokens;
  if (typeof obj.service === 'string') result.service = obj.service;
  if (obj.billingUsage !== undefined) {
    if (!obj.billingUsage || typeof obj.billingUsage !== 'object' || Array.isArray(obj.billingUsage)) {
      throw new Error('NeedAuth billingUsage must be an object');
    }
    const billingUsage = obj.billingUsage as UnitBillingUsageReportV1;
    const errors = validateUnitBillingUsageReportV1(billingUsage);
    if (errors.length > 0) {
      throw new Error(`Invalid NeedAuth billingUsage: ${errors.join('; ')}`);
    }
    result.billingUsage = billingUsage;
  }
  return result;
}

export function decodeCloseChannelRequest(data: Uint8Array): CloseChannelRequestPayload {
  const obj = parsePaymentJson(data);
  const result: CloseChannelRequestPayload = {
    version: 1,
    channelId: requireStringField(obj, 'channelId'),
  };
  // The four auth fields are only meaningful together — a partial set would
  // leave the seller unable to verify the signature, so drop it wholesale.
  if (
    typeof obj.cumulativeAmount === 'string'
    && typeof obj.metadataHash === 'string'
    && typeof obj.metadata === 'string'
    && typeof obj.spendingAuthSig === 'string'
  ) {
    result.cumulativeAmount = obj.cumulativeAmount;
    result.metadataHash = obj.metadataHash;
    result.metadata = obj.metadata;
    result.spendingAuthSig = obj.spendingAuthSig;
  }
  return result;
}

export function decodeCloseChannelResult(data: Uint8Array): CloseChannelResultPayload {
  const obj = parsePaymentJson(data);
  const status = requireStringField(obj, 'status');
  if (status !== 'closed' && status !== 'rejected') {
    throw new Error(`Payment payload field "status" must be "closed" or "rejected"`);
  }
  const result: CloseChannelResultPayload = {
    version: 1,
    channelId: requireStringField(obj, 'channelId'),
    status,
  };
  if (typeof obj.txHash === 'string') result.txHash = obj.txHash;
  if (typeof obj.finalAmount === 'string') result.finalAmount = obj.finalAmount;
  if (typeof obj.code === 'string' && (CLOSE_CHANNEL_REJECT_CODES as readonly string[]).includes(obj.code)) {
    result.code = obj.code as CloseChannelRejectCode;
  }
  if (typeof obj.reason === 'string') result.reason = obj.reason;
  if (typeof obj.retryAfterMs === 'number' && Number.isFinite(obj.retryAfterMs)) {
    result.retryAfterMs = obj.retryAfterMs;
  }
  if (typeof obj.requiredCumulativeAmount === 'string') {
    result.requiredCumulativeAmount = obj.requiredCumulativeAmount;
  }
  return result;
}
