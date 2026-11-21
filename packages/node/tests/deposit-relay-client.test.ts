import { describe, expect, it, vi } from 'vitest';
import { Interface, JsonRpcProvider, Wallet } from 'ethers';
import { DepositRelayClient } from '../src/payments/evm/deposit-relay-client.js';

const RELAY = '0x8A791620dd6260079BF849Dc5567aDC3F2FdC318';
const BUYER = '0x1111111111111111111111111111111111111111';
const RELAYER = '0x2222222222222222222222222222222222222222';
const NONCE = '0x' + 'aa'.repeat(32);
const TX_HASH = '0x' + '77'.repeat(32);

const FEED = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70';
const RELAYER_WALLET = new Wallet('0x' + 'b2'.repeat(32));
const FEED_IFACE = new Interface([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);
const SWEEP_PARAMS = {
  from: BUYER,
  amount: 99_410_000n,
  validAfter: 0n,
  validBefore: 9_999_999_999n,
  nonce: NONCE,
  sig3009: '0x' + '11'.repeat(65),
};

const RELAY_IFACE = new Interface([
  'event SweepExecuted(address indexed buyer, address indexed relayer, uint256 deposited, uint256 fee, bytes32 authNonce)',
]);

function makeClientWithReceipt(receipt: unknown): DepositRelayClient {
  const client = new DepositRelayClient({
    rpcUrl: 'http://127.0.0.1:1',
    contractAddress: RELAY,
    evmChainId: 31337,
  });
  vi.spyOn(client.provider, 'getTransactionReceipt').mockResolvedValue(receipt as never);
  return client;
}

describe('DepositRelayClient', () => {
  it('confirms a matching SweepExecuted event from a transaction receipt', async () => {
    const encoded = RELAY_IFACE.encodeEventLog(
      RELAY_IFACE.getEvent('SweepExecuted')!,
      [BUYER, RELAYER, 4_950_000n, 50_000n, NONCE],
    );
    const client = makeClientWithReceipt({
      status: 1,
      hash: TX_HASH,
      blockNumber: 123,
      logs: [{ address: RELAY, topics: encoded.topics, data: encoded.data }],
    });

    const confirmation = await client.getSweepConfirmation(TX_HASH, {
      buyer: BUYER,
      deposited: 4_950_000n,
      fee: 50_000n,
      authNonce: NONCE,
    });

    expect(confirmation).toEqual({
      txHash: TX_HASH,
      blockNumber: 123,
      buyer: BUYER,
      relayer: RELAYER,
      deposited: 4_950_000n,
      fee: 50_000n,
      authNonce: NONCE,
    });
  });

  it('does not confirm receipts whose relay event does not match the requested nonce', async () => {
    const encoded = RELAY_IFACE.encodeEventLog(
      RELAY_IFACE.getEvent('SweepExecuted')!,
      [BUYER, RELAYER, 4_950_000n, 50_000n, NONCE],
    );
    const client = makeClientWithReceipt({
      status: 1,
      hash: TX_HASH,
      blockNumber: 123,
      logs: [{ address: RELAY, topics: encoded.topics, data: encoded.data }],
    });

    await expect(client.getSweepConfirmation(TX_HASH, {
      buyer: BUYER,
      deposited: 4_950_000n,
      fee: 50_000n,
      authNonce: '0x' + 'bb'.repeat(32),
    })).resolves.toBeNull();
  });
});

const MWEI = 1_000_000n;
const NOW = 1_795_000_000;
const ETH_USD_E8 = 165_266_541_925n; // Chainlink ETH/USD on 20 Nov 2026: $1,652.67
const FALLBACK_USD_E8 = 400_000_000_000n;

/**
 * A relay client on a mocked Base: the latest block, the tip RPCs suggest (no fee history), the
 * relay's FEE and the Chainlink ETH/USD feed.
 */
function makeEstimatingClient(opts: {
  baseFee?: bigint;
  feed?: { answer: bigint; updatedAt: number } | 'reverts' | null;
}) {
  const baseFee = opts.baseFee ?? 25_600_000n;
  const tip = MWEI;
  const client = new DepositRelayClient({
    rpcUrl: 'http://127.0.0.1:1',
    contractAddress: RELAY,
    evmChainId: 8453,
    ...(opts.feed === null ? {} : { ethUsdPriceFeedAddress: FEED }),
  });
  const provider = client.provider as JsonRpcProvider;
  vi.spyOn(provider, 'estimateGas').mockResolvedValue(165_000n);
  vi.spyOn(provider, 'getBlock').mockResolvedValue({ baseFeePerGas: baseFee, timestamp: NOW } as never);
  vi.spyOn(provider, '_perform').mockImplementation(async (req) => {
    if (req.method === 'getPriorityFee') return '0x' + tip.toString(16);
    throw new Error(`unexpected ${req.method}`);
  });
  vi.spyOn(provider, 'send').mockRejectedValue(new Error('no fee history'));
  vi.spyOn(client, 'fee').mockResolvedValue(50_000n);
  const call = vi.spyOn(provider, 'call').mockImplementation(async (tx) => {
    const feed = opts.feed;
    if (String(tx.to).toLowerCase() !== FEED.toLowerCase() || !feed || feed === 'reverts') {
      throw new Error('execution reverted');
    }
    return FEED_IFACE.encodeFunctionResult('latestRoundData', [1n, feed.answer, BigInt(feed.updatedAt), BigInt(feed.updatedAt), 1n]);
  });
  return { client, call };
}

describe('DepositRelayClient.sweep', () => {
  it('cancels a capped sweep no later than its authorization expires', async () => {
    const client = new DepositRelayClient({ rpcUrl: 'http://127.0.0.1:1', contractAddress: RELAY, evmChainId: 8453 });
    const exec = vi.spyOn(client as unknown as { _execWriteWithin: (...args: unknown[]) => Promise<string> }, '_execWriteWithin')
      .mockResolvedValue('0x' + '77'.repeat(32));

    await client.sweep(RELAYER_WALLET, { ...SWEEP_PARAMS, validBefore: 1_800_000_040n }, { maxFeePerGasWei: 183_000_000n });
    await client.sweep(RELAYER_WALLET, SWEEP_PARAMS);

    expect(exec.mock.calls[0]![1]).toEqual({ maxFeePerGasWei: 183_000_000n, cancelByMs: 1_800_000_030_000 });
    expect(exec.mock.calls[1]![1]).toBeNull();
  });
});

describe('DepositRelayClient.estimateSweepProfit', () => {
  it('prices a sweep at the expected gas cost and the Chainlink ETH price (base fee 25.6 Mwei, ETH $1,652.67)', async () => {
    const { client } = makeEstimatingClient({ feed: { answer: ETH_USD_E8, updatedAt: NOW - 600 } });

    const estimate = await client.estimateSweepProfit(RELAYER_WALLET, SWEEP_PARAMS);

    // (25.6 Mwei x 1.25 + 1 Mwei) x 165,000 gas x $1,652.67 = $0.0090 against the 0.05 USDC fee.
    // Priced at maxFeePerGas (52.2 Mwei) and $10,000 it was $0.086, and the relayer refused.
    expect({ estGasCostUsdc: estimate.estGasCostUsdc, profitUsdc: estimate.profitUsdc })
      .toEqual({ estGasCostUsdc: 8_998n, profitUsdc: 41_002n });
    expect(estimate.gasPriceWei).toBe(33_000_000n);
    expect(estimate.ethPriceUsdE8).toBe(ETH_USD_E8);
    // The sweep and its speed-ups stop where the gas would eat the whole fee: 0.05 / (165,000 x $1,652.67) = 183.4 Mwei.
    expect(estimate.maxFeePerGasWei).toBe(183_358_530n);
  });

  it.each([
    ['stale', { answer: ETH_USD_E8, updatedAt: NOW - 3 * 60 * 60 }],
    ['reverting', 'reverts'],
    ['zero', { answer: 0n, updatedAt: NOW }],
    ['missing', null],
  ] as const)('falls back to a cautious $4,000 when the feed is %s', async (_name, feed) => {
    const { client } = makeEstimatingClient({ feed });

    const estimate = await client.estimateSweepProfit(RELAYER_WALLET, SWEEP_PARAMS);

    expect(estimate.ethPriceUsdE8).toBe(FALLBACK_USD_E8);
    // 33 Mwei x 165,000 gas x $4,000
    expect(estimate.estGasCostUsdc).toBe(21_780n);
  });

  it('uses the configured ETH price over the feed', async () => {
    const { client, call } = makeEstimatingClient({ feed: { answer: ETH_USD_E8, updatedAt: NOW } });

    const estimate = await client.estimateSweepProfit(RELAYER_WALLET, SWEEP_PARAMS, { ethPriceUsd: 2_500.5 });

    expect(estimate.ethPriceUsdE8).toBe(250_050_000_000n);
    // 33 Mwei x 165,000 gas x $2,500.50
    expect(estimate.estGasCostUsdc).toBe(13_615n);
    expect(call).not.toHaveBeenCalled();
  });

  it('still takes a whole-dollar bigint ETH price over the feed', async () => {
    const { client, call } = makeEstimatingClient({ feed: { answer: ETH_USD_E8, updatedAt: NOW } });

    const estimate = await client.estimateSweepProfit(RELAYER_WALLET, SWEEP_PARAMS, { ethPriceUsd: 2_500n });

    expect(estimate.ethPriceUsdE8).toBe(250_000_000_000n);
    expect(call).not.toHaveBeenCalled();
  });

  it.each([Number.NaN, 1e-9])('ignores a configured ETH price of %s, which is not a positive price', async (ethPriceUsd) => {
    const { client } = makeEstimatingClient({ feed: { answer: ETH_USD_E8, updatedAt: NOW } });

    const estimate = await client.estimateSweepProfit(RELAYER_WALLET, SWEEP_PARAMS, { ethPriceUsd });

    expect(estimate.ethPriceUsdE8).toBe(ETH_USD_E8);
  });

  it('refuses to price a sweep when the latest block has no base fee', async () => {
    const { client } = makeEstimatingClient({ feed: { answer: ETH_USD_E8, updatedAt: NOW } });
    vi.spyOn(client.provider as JsonRpcProvider, 'getBlock').mockResolvedValue({ baseFeePerGas: null, timestamp: NOW } as never);

    await expect(client.estimateSweepProfit(RELAYER_WALLET, SWEEP_PARAMS)).rejects.toThrow('base fee');
  });

  it('keeps refusing when the expected gas cost is above the fee', async () => {
    // A congested Base: 300 Mwei base fee, at the real ETH price.
    const { client } = makeEstimatingClient({ baseFee: 300_000_000n, feed: { answer: ETH_USD_E8, updatedAt: NOW } });

    const estimate = await client.estimateSweepProfit(RELAYER_WALLET, SWEEP_PARAMS);

    expect(estimate.profitUsdc).toBeLessThan(0n);
  });
});
