import { describe, it, expect, vi } from 'vitest';
import { Interface, JsonRpcProvider, makeError, NonceManager, type AbstractSigner, type InterfaceAbi, type TransactionReceipt, type TransactionRequest, type TransactionResponse } from 'ethers';
import { BaseEvmClient, ReceiptWaitTimeoutError, TransactionCancelledError, type BaseEvmClientOptions } from '../src/payments/evm/base-evm-client.js';

class TestEvmClient extends BaseEvmClient {
  constructor(options?: BaseEvmClientOptions) {
    super('http://127.0.0.1:1', '0x' + 'aa'.repeat(20), undefined, undefined, options);
    vi.spyOn(this.provider, 'getTransactionReceipt')
      .mockImplementation(async (hash) => ({ hash, status: 1 }) as unknown as TransactionReceipt);
  }
  async waitFor(
    tx: Pick<TransactionResponse, 'hash' | 'from' | 'nonce'>,
    speedUp?: () => Promise<Pick<TransactionResponse, 'hash'> | null>,
  ): Promise<TransactionReceipt> {
    return this._waitForReceipt(tx, speedUp);
  }
  async exec(signer: AbstractSigner, abi: InterfaceAbi, method: string, ...args: unknown[]): Promise<string> {
    return this._execWrite(signer, abi, method, ...args);
  }
}

function signerSendingTo(
  sent: TransactionRequest[],
  address: string,
  estimateGas: () => Promise<bigint> = async () => 21_000n,
): AbstractSigner {
  const signer = {
    provider: undefined,
    getAddress: async () => address,
    connect() { return signer; },
    estimateGas,
    sendTransaction: async (tx: TransactionRequest): Promise<TransactionResponse> => {
      sent.push(tx);
      return { hash: '0x01', nonce: tx.nonce, from: address, wait: async () => ({ hash: '0x01' }) } as unknown as TransactionResponse;
    },
  };
  return signer as unknown as AbstractSigner;
}

const ABI = [
  'function transfer(address to, uint256 amount) external returns (bool)',
] as const;

describe('BaseEvmClient._execWrite', () => {
  it('applies a 30% buffer over estimateGas before sending the tx', async () => {
    const client = new TestEvmClient();

    // Stub the nonce read so we never touch the network.
    vi.spyOn(client.provider, 'getTransactionCount').mockResolvedValue(42);

    const captured: TransactionRequest[] = [];
    const fakeSigner = {
      provider: client.provider,
      getAddress: async () => '0x' + 'bb'.repeat(20),
      connect() { return fakeSigner; },
      estimateGas: async (_tx: TransactionRequest) => 100_000n,
      sendTransaction: async (tx: TransactionRequest): Promise<TransactionResponse> => {
        captured.push(tx);
        return {
          hash: '0xdeadbeef',
          wait: async () => ({ hash: '0xdeadbeef' }),
        } as unknown as TransactionResponse;
      },
    } as unknown as AbstractSigner;

    const hash = await client.exec(
      fakeSigner,
      ABI as unknown as InterfaceAbi,
      'transfer',
      '0x' + '01'.repeat(20),
      100n,
    );

    expect(hash).toBe('0xdeadbeef');
    expect(captured.length).toBe(1);
    const sent = captured[0]!;
    // 100,000 * 130 / 100 = 130,000
    expect(sent.gasLimit).toBe(130_000n);
    expect(sent.nonce).toBe(42);
    expect(typeof sent.data).toBe('string');
    expect(sent.to?.toString().toLowerCase()).toBe('0x' + 'aa'.repeat(20));
  });

  it('reuses the nonce of a tx whose estimateGas reverted', async () => {
    const client = new TestEvmClient();
    vi.spyOn(client.provider, 'getTransactionCount').mockResolvedValue(7);

    const fakeSigner = {
      provider: client.provider,
      getAddress: async () => '0x' + 'cc'.repeat(20),
      connect() { return fakeSigner; },
      estimateGas: async () => { throw new Error('execution reverted: not allowed'); },
      sendTransaction: async () => { throw new Error('should not be reached'); },
    } as unknown as AbstractSigner;

    await expect(
      client.exec(fakeSigner, ABI as unknown as InterfaceAbi, 'transfer', '0x' + '02'.repeat(20), 1n),
    ).rejects.toThrow(/execution reverted/);

    // The reverted tx never used nonce 7, so the next send gets it instead of leaving a gap.
    const sent: TransactionRequest[] = [];
    await client.exec(signerSendingTo(sent, '0x' + 'cc'.repeat(20)), ABI as unknown as InterfaceAbi, 'transfer', '0x' + '02'.repeat(20), 1n);
    expect(sent[0]!.nonce).toBe(7);
  });

  it('gives two clients signing with the same wallet different nonces', async () => {
    const channels = new TestEvmClient();
    const freeUsage = new TestEvmClient();
    vi.spyOn(channels.provider, 'getTransactionCount').mockResolvedValue(10);
    vi.spyOn(freeUsage.provider, 'getTransactionCount').mockResolvedValue(10);
    const sent: TransactionRequest[] = [];
    const signer = signerSendingTo(sent, '0x' + 'dd'.repeat(20));

    await Promise.all([
      channels.exec(signer, ABI as unknown as InterfaceAbi, 'transfer', '0x' + '03'.repeat(20), 1n),
      freeUsage.exec(signer, ABI as unknown as InterfaceAbi, 'transfer', '0x' + '04'.repeat(20), 1n),
    ]);

    expect(sent.map(tx => tx.nonce).sort()).toEqual([10, 11]);
  });

  it('does not reuse a nonce after another client\'s send fails', async () => {
    const channels = new TestEvmClient();
    const freeUsage = new TestEvmClient();
    const sent: TransactionRequest[] = [];
    // The pending count may lag behind txs already sent, as on a load-balanced RPC.
    vi.spyOn(channels.provider, 'getTransactionCount').mockResolvedValue(10);
    vi.spyOn(freeUsage.provider, 'getTransactionCount').mockResolvedValue(10);
    const address = '0x' + 'ee'.repeat(20);
    let finishChannelEstimate!: () => void;
    const slowEstimate = () => new Promise<bigint>(resolve => { finishChannelEstimate = () => resolve(21_000n); });
    const send = (client: TestEvmClient, signer: AbstractSigner) =>
      client.exec(signer, ABI as unknown as InterfaceAbi, 'transfer', '0x' + '06'.repeat(20), 1n);

    const channel = send(channels, signerSendingTo(sent, address, slowEstimate));
    const failing = send(freeUsage, signerSendingTo(sent, address, async () => { throw new Error('execution reverted'); }));
    const next = send(freeUsage, signerSendingTo(sent, address));
    await vi.waitFor(() => expect(finishChannelEstimate).toBeTypeOf('function'));
    finishChannelEstimate();

    await expect(failing).rejects.toThrow(/execution reverted/);
    await Promise.all([channel, next]);
    expect(sent.map(tx => tx.nonce)).toEqual([10, 11]);
  });
});

describe('BaseEvmClient nonce cursor', () => {
  it('trusts the pending count again once the cursor is stale, so dropped txs leave no gap', async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const client = new TestEvmClient();
      const sent: TransactionRequest[] = [];
      const address = '0x' + '12'.repeat(20);
      const send = () => client.exec(signerSendingTo(sent, address), ABI as unknown as InterfaceAbi, 'transfer', '0x' + '07'.repeat(20), 1n);
      // The first txs are sent but then dropped: the pending count never moves past 20.
      vi.spyOn(client.provider, 'getTransactionCount').mockResolvedValue(20);
      await send();
      await send();
      now += 61_000;
      await send();
      expect(sent.map((t) => t.nonce)).toEqual([20, 21, 20]);
    } finally {
      clock.mockRestore();
    }
  });
});

describe('BaseEvmClient speed-ups', () => {
  it('stops speeding up a dropped tx once its nonce went to a newer one', async () => {
    vi.useFakeTimers();
    try {
      const client = new TestEvmClient();
      const provider = client.provider as JsonRpcProvider;
      vi.spyOn(provider, 'getBlock').mockResolvedValue({ baseFeePerGas: 5_000_000n } as never);
      vi.spyOn(provider, '_perform').mockImplementation(async (req) => {
        if (req.method === 'getPriorityFee') return '0xf4240';
        throw new Error(`unexpected ${req.method}`);
      });
      vi.spyOn(provider, 'send').mockRejectedValue(new Error('no fee history'));
      // Nothing ever mines, and the pending count never counts the sent txs.
      vi.spyOn(provider, 'getTransactionCount').mockResolvedValue(20);
      vi.mocked(provider.getTransactionReceipt).mockResolvedValue(null);
      const sent: TransactionRequest[] = [];
      const address = '0x' + '13'.repeat(20);
      const transfer = (amount: bigint) =>
        client.exec(signerSendingTo(sent, address), ABI as unknown as InterfaceAbi, 'transfer', '0x' + '08'.repeat(20), amount).catch(() => undefined);
      const iface = new Interface(ABI as unknown as InterfaceAbi);
      const amounts = () => sent.map((tx) => (iface.decodeFunctionData('transfer', tx.data as string)[1] as bigint));

      void transfer(1n);
      await vi.advanceTimersByTimeAsync(65_000);
      // A was sent and sped up twice, all on nonce 20, with rising tips.
      expect(amounts()).toEqual([1n, 1n, 1n]);
      expect(sent.map((tx) => tx.nonce)).toEqual([20, 20, 20]);
      expect(BigInt(sent[2]!.maxPriorityFeePerGas!)).toBeGreaterThan(BigInt(sent[1]!.maxPriorityFeePerGas!));

      // The cursor is stale, so B gets nonce 20; A must not replace it.
      void transfer(2n);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(amounts().slice(3).every((amount) => amount === 2n)).toBe(true);
      expect(sent.slice(3).map((tx) => tx.nonce).every((nonce) => nonce === 20)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('BaseEvmClient speed-ups within a fee limit', () => {
  it('stops speeding up once a replacement would exceed the max fee per gas allowed', async () => {
    vi.useFakeTimers();
    try {
      const client = new TestEvmClient();
      const provider = client.provider as JsonRpcProvider;
      vi.spyOn(provider, 'getBlock').mockResolvedValue({ baseFeePerGas: 5_000_000n } as never);
      vi.spyOn(provider, '_perform').mockResolvedValue('0xf4240'); // 0.001 gwei tip
      vi.spyOn(provider, 'send').mockRejectedValue(new Error('no fee history'));
      vi.spyOn(provider, 'getTransactionCount').mockResolvedValue(40);
      vi.mocked(provider.getTransactionReceipt).mockResolvedValue(null);
      const sent: TransactionRequest[] = [];
      // First send: max fee 0.011 gwei. One speed-up fits under 0.016 gwei; the next would not.
      void (client as unknown as { _execWriteWithin: (...args: unknown[]) => Promise<string> })
        ._execWriteWithin(signerSendingTo(sent, '0x' + '15'.repeat(20)), { maxFeePerGasWei: 16_000_000n }, ABI as unknown as InterfaceAbi, 'transfer', '0x' + '0a'.repeat(20), 1n)
        .catch(() => undefined);
      // Up to just before the write would be cancelled (120 s).
      await vi.advanceTimersByTimeAsync(110_000);
      expect(sent).toHaveLength(2);
      expect(BigInt(sent[1]!.maxFeePerGas!)).toBeLessThanOrEqual(16_000_000n);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('BaseEvmClient writes within a fee limit', () => {
  it('sends the first tx at no more than the max fee per gas allowed', async () => {
    const client = new TestEvmClient();
    const provider = client.provider as JsonRpcProvider;
    vi.spyOn(provider, 'getBlock').mockResolvedValue({ baseFeePerGas: 5_000_000n } as never);
    vi.spyOn(provider, '_perform').mockResolvedValue('0xf4240'); // 0.001 gwei tip
    vi.spyOn(provider, 'send').mockRejectedValue(new Error('no fee history'));
    vi.spyOn(provider, 'getTransactionCount').mockResolvedValue(40);
    const sent: TransactionRequest[] = [];
    // Uncapped, the first send would offer 2 x base fee + tip = 0.011 gwei.
    await (client as unknown as { _execWriteWithin: (...args: unknown[]) => Promise<string> })
      ._execWriteWithin(signerSendingTo(sent, '0x' + '16'.repeat(20)), { maxFeePerGasWei: 8_000_000n }, ABI as unknown as InterfaceAbi, 'transfer', '0x' + '0a'.repeat(20), 1n);
    expect(sent).toHaveLength(1);
    expect(BigInt(sent[0]!.maxFeePerGas!)).toBe(8_000_000n);
    expect(BigInt(sent[0]!.maxPriorityFeePerGas!)).toBe(1_000_000n);
  });

  it('sends nothing when the base fee cannot be read to price the capped tx', async () => {
    const client = new TestEvmClient();
    const provider = client.provider as JsonRpcProvider;
    vi.spyOn(provider, 'getBlock').mockRejectedValue(new Error('rpc timeout'));
    vi.spyOn(provider, 'getTransactionCount').mockResolvedValue(41);
    const sent: TransactionRequest[] = [];
    // Left unpriced, the signer would fill in its own fees, above the cap.
    await expect((client as unknown as { _execWriteWithin: (...args: unknown[]) => Promise<string> })
      ._execWriteWithin(signerSendingTo(sent, '0x' + '17'.repeat(20)), { maxFeePerGasWei: 8_000_000n }, ABI as unknown as InterfaceAbi, 'transfer', '0x' + '0a'.repeat(20), 1n))
      .rejects.toThrow('fee-capped');
    expect(sent).toHaveLength(0);
  });
});

describe('BaseEvmClient speed-ups with nonce-managing signers', () => {
  it('never re-sends through a NonceManager, which would send the replacement on a new nonce', async () => {
    vi.useFakeTimers();
    try {
      const client = new TestEvmClient();
      const provider = client.provider as JsonRpcProvider;
      vi.spyOn(provider, 'getBlock').mockResolvedValue({ baseFeePerGas: 5_000_000n } as never);
      vi.spyOn(provider, '_perform').mockResolvedValue('0xf4240');
      vi.spyOn(provider, 'send').mockRejectedValue(new Error('no fee history'));
      vi.spyOn(provider, 'getTransactionCount').mockResolvedValue(30);
      vi.mocked(provider.getTransactionReceipt).mockResolvedValue(null);
      const sent: TransactionRequest[] = [];
      class ManagedSigner extends NonceManager {
        override async getAddress() { return '0x' + '14'.repeat(20); }
        override connect() { return this; }
        override async estimateGas() { return 21_000n; }
        override async sendTransaction(tx: TransactionRequest): Promise<TransactionResponse> {
          // Like NonceManager: the signer's own nonce replaces the one asked for.
          sent.push({ ...tx, nonce: 77 });
          return { hash: '0x02', nonce: 77, from: '0x' + '14'.repeat(20) } as unknown as TransactionResponse;
        }
      }
      const signer = new ManagedSigner(signerSendingTo([], '0x' + '14'.repeat(20)));
      void client.exec(signer, ABI as unknown as InterfaceAbi, 'transfer', '0x' + '09'.repeat(20), 1n).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(130_000);
      expect(sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('BaseEvmClient._waitForReceipt', () => {
  const tx = { hash: '0xabc', from: '0x' + 'ff'.repeat(20), nonce: 3 };
  const receipt = (status: number) => ({ hash: tx.hash, status }) as unknown as TransactionReceipt;

  it('keeps polling through RPC timeouts instead of failing the wait', async () => {
    vi.useFakeTimers();
    try {
      const client = new TestEvmClient();
      vi.mocked(client.provider.getTransactionReceipt)
        .mockRejectedValueOnce(makeError('request timeout', 'TIMEOUT'))
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(receipt(1));

      const waiting = client.waitFor(tx);
      await vi.advanceTimersByTimeAsync(4_000);

      await expect(waiting).resolves.toMatchObject({ hash: tx.hash, status: 1 });
      expect(client.provider.getTransactionReceipt).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws CALL_EXCEPTION when the tx reverted', async () => {
    const client = new TestEvmClient();
    vi.mocked(client.provider.getTransactionReceipt).mockResolvedValue(receipt(0));

    await expect(client.waitFor(tx)).rejects.toMatchObject({ code: 'CALL_EXCEPTION' });
  });

  it('sends a stuck tx again with higher fees, and returns whichever version mines', async () => {
    vi.useFakeTimers();
    try {
      const client = new TestEvmClient();
      vi.spyOn(client.provider, 'getTransactionCount').mockResolvedValue(tx.nonce);
      vi.mocked(client.provider.getTransactionReceipt).mockImplementation(async (hash) =>
        hash === '0xfaster' ? ({ hash, status: 1 }) as unknown as TransactionReceipt : null);
      const speedUp = vi.fn(async () => ({ hash: '0xfaster' }));

      const waiting = client.waitFor(tx, speedUp);
      await vi.advanceTimersByTimeAsync(29_000);
      expect(speedUp).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(4_000);

      await expect(waiting).resolves.toMatchObject({ hash: '0xfaster' });
      expect(speedUp).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws when another tx used the nonce', async () => {
    vi.useFakeTimers();
    try {
      const client = new TestEvmClient();
      vi.mocked(client.provider.getTransactionReceipt).mockResolvedValue(null);
      vi.spyOn(client.provider, 'getTransactionCount').mockResolvedValue(tx.nonce + 1);

      const waiting = client.waitFor(tx);
      const settled = expect(waiting).rejects.toThrow(/dropped or replaced/);
      await vi.advanceTimersByTimeAsync(10_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it('with a receipt wait limit, gives up on a tx still pending and names every version sent', async () => {
    vi.useFakeTimers();
    try {
      const client = new TestEvmClient({ receiptWaitLimitMs: 60_000 });
      vi.mocked(client.provider.getTransactionReceipt).mockResolvedValue(null);
      vi.spyOn(client.provider, 'getTransactionCount').mockResolvedValue(tx.nonce);
      const speedUp = vi.fn(async () => ({ hash: '0xfaster' }));

      const waiting = client.waitFor(tx, speedUp);
      const settled = waiting.then(() => null, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(58_000);
      await vi.advanceTimersByTimeAsync(4_000);
      const error = await settled;

      expect(error).toBeInstanceOf(ReceiptWaitTimeoutError);
      expect(error).toMatchObject({ code: 'TIMEOUT', hashes: [tx.hash, '0xfaster'] });
      expect((error as Error).message).toMatch(/0xfaster was sent but not mined within 6\d s/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('without a limit keeps waiting for a pending tx, as payments must', async () => {
    vi.useFakeTimers();
    try {
      const client = new TestEvmClient();
      vi.mocked(client.provider.getTransactionReceipt).mockResolvedValue(null);
      vi.spyOn(client.provider, 'getTransactionCount').mockResolvedValue(tx.nonce);
      let settled = false;
      const waiting = client.waitFor(tx).finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(settled).toBe(false);

      vi.mocked(client.provider.getTransactionReceipt).mockResolvedValue(receipt(1));
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(waiting).resolves.toMatchObject({ status: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});

/** A signer that gives each send its own hash, recorded in `byHash`. */
function signerWithHashes(sent: TransactionRequest[], byHash: Map<string, TransactionRequest>, address: string): AbstractSigner {
  const signer = {
    provider: undefined,
    getAddress: async () => address,
    connect() { return signer; },
    estimateGas: async () => 21_000n,
    sendTransaction: async (request: TransactionRequest): Promise<TransactionResponse> => {
      // A copy, as a signer serializes it: the client reuses the request object for replacements.
      const tx = { ...request };
      sent.push(tx);
      const hash = '0x' + sent.length.toString(16).padStart(64, '0');
      byHash.set(hash, tx);
      return { hash, nonce: tx.nonce, from: address } as unknown as TransactionResponse;
    },
  };
  return signer as unknown as AbstractSigner;
}

describe('BaseEvmClient cancels a fee-capped write that cannot mine', () => {
  const execWithin = (client: TestEvmClient, signer: AbstractSigner, limit: unknown) =>
    (client as unknown as { _execWriteWithin: (...args: unknown[]) => Promise<string> })
      ._execWriteWithin(signer, limit, ABI as unknown as InterfaceAbi, 'transfer', '0x' + '0a'.repeat(20), 1n)
      .then((hash) => hash, (err: unknown) => err);

  /** Base fee 5 Mwei and a 1 Mwei tip, so a capped first send is clamped to the cap; nothing mines yet. */
  function stuckClient(nonce: number) {
    const client = new TestEvmClient();
    const provider = client.provider as JsonRpcProvider;
    const getBlock = vi.spyOn(provider, 'getBlock').mockResolvedValue({ baseFeePerGas: 5_000_000n } as never);
    vi.spyOn(provider, '_perform').mockResolvedValue('0xf4240');
    vi.spyOn(provider, 'send').mockRejectedValue(new Error('no fee history'));
    vi.spyOn(provider, 'getTransactionCount').mockResolvedValue(nonce);
    const mined = new Set<string>();
    vi.mocked(provider.getTransactionReceipt).mockImplementation(async (hash) => (
      mined.has(hash) ? { hash, status: 1 } as unknown as TransactionReceipt : null
    ));
    // The base fee climbs above the cap once the write is out.
    const raiseBaseFee = () => getBlock.mockResolvedValue({ baseFeePerGas: 20_000_000n } as never);
    return { client, mined, raiseBaseFee };
  }

  it('replaces it on its nonce with a 0-value transfer to the signer after 120 s', async () => {
    vi.useFakeTimers();
    try {
      const { client, mined, raiseBaseFee } = stuckClient(50);
      const address = '0x' + '18'.repeat(20);
      const sent: TransactionRequest[] = [];
      const byHash = new Map<string, TransactionRequest>();
      const result = execWithin(client, signerWithHashes(sent, byHash, address), { maxFeePerGasWei: 8_000_000n });
      await vi.advanceTimersByTimeAsync(1_000);
      raiseBaseFee();
      // Speed-ups would cost more than the cap, so the write waits as it is.
      await vi.advanceTimersByTimeAsync(110_000);
      expect(sent).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(12_000);
      expect(sent).toHaveLength(2);
      const cancelTx = sent[1]!;
      expect(cancelTx).toMatchObject({ to: address, value: 0n, data: '0x', nonce: 50 });
      expect(BigInt(cancelTx.maxFeePerGas!)).toBeGreaterThanOrEqual(41_000_000n); // 2 x 20 Mwei + tip, above the cap

      mined.add([...byHash.keys()][1]!);
      await vi.advanceTimersByTimeAsync(3_000);
      const err = await result;
      expect(err).toBeInstanceOf(TransactionCancelledError);
      expect((err as TransactionCancelledError).hashes).toEqual([[...byHash.keys()][0]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unblocks a later write on the same wallet', async () => {
    vi.useFakeTimers();
    try {
      const { client, mined, raiseBaseFee } = stuckClient(52);
      const address = '0x' + '19'.repeat(20);
      const sent: TransactionRequest[] = [];
      const byHash = new Map<string, TransactionRequest>();
      const signer = signerWithHashes(sent, byHash, address);
      const capped = execWithin(client, signer, { maxFeePerGasWei: 8_000_000n });
      await vi.advanceTimersByTimeAsync(1_000);
      raiseBaseFee();
      // A settle on the next nonce, which cannot mine while nonce 52 is pending.
      const later = client.exec(signer, ABI as unknown as InterfaceAbi, 'transfer', '0x' + '0b'.repeat(20), 2n);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sent.map((tx) => tx.nonce)).toEqual([52, 53]);
      vi.mocked(client.provider.getTransactionReceipt).mockImplementation(async (hash) => {
        const nonce52Cleared = sent.some((tx) => tx.nonce === 52 && tx.to === address);
        const tx = byHash.get(hash);
        const isMined = mined.has(hash) || (nonce52Cleared && (tx?.to === address || tx?.nonce === 53));
        return isMined ? { hash, status: 1 } as unknown as TransactionReceipt : null;
      });

      await vi.advanceTimersByTimeAsync(125_000);
      await expect(later).resolves.toMatch(/^0x/);
      expect(await capped).toBeInstanceOf(TransactionCancelledError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still counts the write when it mines after the cancel was sent', async () => {
    vi.useFakeTimers();
    try {
      const { client, mined, raiseBaseFee } = stuckClient(54);
      const address = '0x' + '1a'.repeat(20);
      const sent: TransactionRequest[] = [];
      const byHash = new Map<string, TransactionRequest>();
      const result = execWithin(client, signerWithHashes(sent, byHash, address), { maxFeePerGasWei: 8_000_000n });
      await vi.advanceTimersByTimeAsync(1_000);
      raiseBaseFee();
      await vi.advanceTimersByTimeAsync(122_000);
      expect(sent).toHaveLength(2);

      const writeHash = [...byHash.keys()][0]!;
      mined.add(writeHash);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await result).toBe(writeHash);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never cancels a nonce that now belongs to a newer write', async () => {
    vi.useFakeTimers();
    try {
      const { client, raiseBaseFee } = stuckClient(56);
      const address = '0x' + '1b'.repeat(20);
      const sent: TransactionRequest[] = [];
      const signer = signerWithHashes(sent, new Map(), address);
      void execWithin(client, signer, { maxFeePerGasWei: 8_000_000n });
      await vi.advanceTimersByTimeAsync(1_000);
      raiseBaseFee();
      // The nonce cursor goes stale after 60 s, and the chain still reports 56 pending: B takes nonce 56.
      await vi.advanceTimersByTimeAsync(61_000);
      void client.exec(signer, ABI as unknown as InterfaceAbi, 'transfer', '0x' + '0c'.repeat(20), 3n).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(70_000);
      expect(sent.filter((tx) => tx.nonce === 56).length).toBeGreaterThan(1);
      expect(sent.some((tx) => tx.to === address)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('speeds the cancel up past the cap, and a mined bump still counts as cancelled', async () => {
    vi.useFakeTimers();
    try {
      const { client, mined, raiseBaseFee } = stuckClient(60);
      const address = '0x' + '1d'.repeat(20);
      const sent: TransactionRequest[] = [];
      const byHash = new Map<string, TransactionRequest>();
      const result = execWithin(client, signerWithHashes(sent, byHash, address), { maxFeePerGasWei: 8_000_000n });
      await vi.advanceTimersByTimeAsync(1_000);
      raiseBaseFee();
      await vi.advanceTimersByTimeAsync(122_000);
      expect(sent).toHaveLength(2);
      // The cancel does not mine at first: 30 s later it is bumped, with no cap.
      await vi.advanceTimersByTimeAsync(32_000);
      expect(sent).toHaveLength(3);
      expect(sent[2]).toMatchObject({ to: address, nonce: 60 });
      expect(BigInt(sent[2]!.maxFeePerGas!)).toBeGreaterThan(BigInt(sent[1]!.maxFeePerGas!));

      mined.add([...byHash.keys()][2]!);
      await vi.advanceTimersByTimeAsync(3_000);
      const err = await result;
      expect(err).toBeInstanceOf(TransactionCancelledError);
      expect((err as TransactionCancelledError).hashes).toEqual([[...byHash.keys()][0]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('prices the cancel above the speed-up tip cap when the write was near it', async () => {
    vi.useFakeTimers();
    try {
      const { client, raiseBaseFee } = stuckClient(62);
      // A 0.48 gwei tip, within 10% of the 0.5 gwei speed-up tip cap.
      vi.spyOn(client.provider as JsonRpcProvider, '_perform').mockResolvedValue('0x' + (480_000_000).toString(16));
      const address = '0x' + '1e'.repeat(20);
      const sent: TransactionRequest[] = [];
      void execWithin(client, signerWithHashes(sent, new Map(), address), { maxFeePerGasWei: 490_000_000n });
      await vi.advanceTimersByTimeAsync(1_000);
      raiseBaseFee();
      await vi.advanceTimersByTimeAsync(122_000);
      expect(sent).toHaveLength(2);
      // A replacement must raise the tip by at least 10% to be accepted.
      expect(BigInt(sent[1]!.maxPriorityFeePerGas!)).toBeGreaterThanOrEqual(528_000_000n);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels at cancelByMs when that comes before 120 s', async () => {
    vi.useFakeTimers();
    try {
      const { client, raiseBaseFee } = stuckClient(58);
      const address = '0x' + '1c'.repeat(20);
      const sent: TransactionRequest[] = [];
      void execWithin(client, signerWithHashes(sent, new Map(), address), { maxFeePerGasWei: 8_000_000n, cancelByMs: Date.now() + 40_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      raiseBaseFee();
      await vi.advanceTimersByTimeAsync(35_000);
      expect(sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(sent).toHaveLength(2);
      expect(sent[1]).toMatchObject({ to: address, nonce: 58 });
    } finally {
      vi.useRealTimers();
    }
  });
});
