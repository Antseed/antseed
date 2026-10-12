/** Buyer-daemon client and response normalization for payment channels. */
import type { ChannelInfo, CloseChannelResultPayload } from '@antseed/node';
import { multicallRead } from '@antseed/node/payments';
import { Interface, type AbstractProvider } from 'ethers';
import { LOCALHOST_URL } from '../constants.js';
import type { DesktopPaymentChannelSummary } from './buyer-channels.js';

function readNumberField(raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

function readStringField(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return '';
}

type ChannelOnChainSnapshot = {
  status: number;
  deposit: string;
  settled: string;
  closeRequestedAt: number;
};

const CHANNEL_CLOSE_GRACE_SECS = 900;
const channelOnChainSnapshots = new Map<string, ChannelOnChainSnapshot>();

export function applyChannelOnChainSnapshot(
  row: DesktopPaymentChannelSummary,
  snapshot?: ChannelOnChainSnapshot,
  nowSeconds = Math.floor(Date.now() / 1000),
): void {
  if (snapshot && snapshot.status !== 0) {
    channelOnChainSnapshots.set(row.channelId, snapshot);
  }

  const knownSnapshot = channelOnChainSnapshots.get(row.channelId);
  if (!knownSnapshot) return;

  row.onChainStateKnown = true;
  row.onChainDeposit = knownSnapshot.deposit;
  row.onChainSettled = knownSnapshot.settled;
  if (knownSnapshot.status === 2) row.status = 'settled';
  else if (knownSnapshot.status === 3) row.status = 'timedout';
  else if (knownSnapshot.status === 1 && knownSnapshot.closeRequestedAt > 0) {
    row.status = nowSeconds < knownSnapshot.closeRequestedAt + CHANNEL_CLOSE_GRACE_SECS
      ? 'closing'
      : 'withdrawable';
  }
}

export function normalizePaymentChannelSummary(value: unknown): DesktopPaymentChannelSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const channelId = readStringField(raw, 'channelId') || readStringField(raw, 'sessionId');
  if (!channelId) return null;
  return {
    channelId,
    peerId: readStringField(raw, 'peerId') || readStringField(raw, 'sellerPeerId'),
    seller: readStringField(raw, 'seller') || readStringField(raw, 'sellerAddress') || readStringField(raw, 'sellerEvmAddress'),
    sellerDisplayName: readStringField(raw, 'sellerDisplayName') || null,
    onChainStateKnown: raw['onChainStateKnown'] === true,
    reserveCeiling: readStringField(raw, 'reserveCeiling') || readStringField(raw, 'reserveMax') || null,
    cumulativeSigned: readStringField(raw, 'cumulativeSigned') || readStringField(raw, 'latestCumulativeAmount') || readStringField(raw, 'cumulativeAmount') || '0',
    onChainDeposit: readStringField(raw, 'onChainDeposit') || '0',
    onChainSettled: readStringField(raw, 'onChainSettled') || readStringField(raw, 'settledAmount') || '0',
    reservedAt: readNumberField(raw, 'reservedAt'),
    updatedAt: readNumberField(raw, 'updatedAt'),
    status: readStringField(raw, 'status') || 'unknown',
    requestCount: readNumberField(raw, 'requestCount'),
    inputTokens: readStringField(raw, 'tokensDelivered') || '0',
    outputTokens: readStringField(raw, 'outputTokens') || '0',
    cooperativeCloseSupported: raw['cooperativeCloseSupported'] === true,
  };
}

export type CooperativeCloseRequestOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export async function runInBatches<T>(
  items: readonly T[],
  batchSize: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  for (let offset = 0; offset < items.length; offset += batchSize) {
    const batch = items.slice(offset, offset + batchSize);
    await Promise.allSettled(batch.map(task));
  }
}

function isCloseChannelResult(value: unknown): value is CloseChannelResultPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return result['version'] === 1
    && typeof result['channelId'] === 'string'
    && (result['status'] === 'closed' || result['status'] === 'rejected');
}

export async function requestCooperativeChannelCloseAtPort(
  port: number,
  peerId: string,
  options: CooperativeCloseRequestOptions = {},
): Promise<CloseChannelResultPayload> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${LOCALHOST_URL}:${port}/_antseed/channels/close`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ peerId, includeAuth: true }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 90_000),
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || body?.['ok'] !== true) {
    const error = typeof body?.['error'] === 'string' ? body['error'] : `Buyer daemon returned HTTP ${response.status}`;
    throw new Error(error);
  }
  if (!isCloseChannelResult(body['result'])) {
    throw new Error('Buyer daemon returned an invalid cooperative-close response');
  }
  return body['result'];
}

const CHANNELS_READ_IFACE = new Interface([
  'function channels(bytes32 channelId) view returns (address buyer, address seller, uint128 deposit, uint128 settled, bytes32 metadataHash, uint256 deadline, uint256 settledAt, uint256 closeRequestedAt, uint8 status)',
]);

/** Read many channels in one Multicall3 call; channels it could not read are left out. */
export async function readChannelsBatched(provider: AbstractProvider, channelsAddress: string, channelIds: string[]): Promise<Map<string, ChannelInfo>> {
  if (channelIds.length === 0) return new Map();
  const results = await multicallRead(provider, channelIds.map((channelId) => ({
    target: channelsAddress,
    iface: CHANNELS_READ_IFACE,
    method: 'channels',
    args: [channelId],
  })));
  const sessions = new Map<string, ChannelInfo>();
  results.forEach((result, index) => {
    if (!result) return;
    sessions.set(channelIds[index]!, {
      buyer: result[0] as string,
      seller: result[1] as string,
      deposit: result[2] as bigint,
      settled: result[3] as bigint,
      metadataHash: result[4] as string,
      deadline: result[5] as bigint,
      settledAt: result[6] as bigint,
      closeRequestedAt: result[7] as bigint,
      status: Number(result[8]),
    });
  });
  return sessions;
}
