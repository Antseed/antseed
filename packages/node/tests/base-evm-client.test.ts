import { describe, it, expect, vi } from 'vitest';
import type { AbstractSigner, InterfaceAbi, TransactionRequest, TransactionResponse } from 'ethers';
import { BaseEvmClient } from '../src/payments/evm/base-evm-client.js';

class TestEvmClient extends BaseEvmClient {
  constructor() {
    super('http://127.0.0.1:1', '0x' + 'aa'.repeat(20));
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
      return { hash: '0x01', wait: async () => ({ hash: '0x01' }) } as unknown as TransactionResponse;
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
