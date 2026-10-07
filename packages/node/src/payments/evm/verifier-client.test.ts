import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { VERIFICATION_ABI, VerifierClient } from './verifier-client.js';

const CONTRACT_ADDRESS = '0x00000000000000000000000000000000000000aa';
const EVIDENCE_HASH = '0x' + '11'.repeat(32);
const TRANSACTION_HASH = '0x' + '22'.repeat(32);
const VERIFIER = ethers.getAddress('0x50d4a83a89a1acf4af825fe49c44297183ed1e5c');

function makeClient(): VerifierClient {
  return new VerifierClient({ rpcUrl: 'http://localhost:8545', contractAddress: CONTRACT_ADDRESS });
}

function bundleLog(blockNumber: number) {
  const encoded = new ethers.Interface(VERIFICATION_ABI).encodeEventLog('VerificationBundleSubmitted', [
    EVIDENCE_HASH,
    VERIFIER,
    3,
    'ipfs://bundle',
  ]);
  return {
    address: CONTRACT_ADDRESS,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber,
    index: 4,
    transactionHash: TRANSACTION_HASH,
  };
}

describe('VerifierClient bundle lookup', () => {
  it('reads a submitted bundle from its transaction receipt without querying logs', async () => {
    const client = makeClient();
    const provider = (client as any)._provider;
    provider.getTransactionReceipt = async () => ({ status: 1, logs: [bundleLog(52_297_475)] });
    provider.getLogs = async () => {
      throw new Error('eth_getLogs is limited to a 500 range');
    };

    await expect(client.findBundleSubmission(EVIDENCE_HASH, TRANSACTION_HASH)).resolves.toEqual({
      evidenceHash: EVIDENCE_HASH,
      verifier: VERIFIER,
      resultCount: 3,
      evidenceUri: 'ipfs://bundle',
      blockNumber: 52_297_475,
      logIndex: 4,
      transactionHash: TRANSACTION_HASH,
    });
  });

  it('locates an existing bundle with a bounded log query when the transaction is unknown', async () => {
    const client = makeClient();
    const provider = (client as any)._provider;
    const queries: Array<{ fromBlock: number; toBlock: number }> = [];
    (client as any)._contract = () => ({
      getFunction: () => async () => ({ submittedAt: 1_700_000_005n }),
      filters: new ethers.Contract(CONTRACT_ADDRESS, VERIFICATION_ABI).filters,
      queryFilter: async (_filter: unknown, fromBlock: number, toBlock: number) => {
        queries.push({ fromBlock, toBlock });
        const iface = new ethers.Interface(VERIFICATION_ABI);
        const log = bundleLog(52_000_005);
        return [new ethers.EventLog(log as any, iface, iface.getEvent('VerificationBundleSubmitted')!)];
      },
    });
    provider.getBlockNumber = async () => 52_000_100;
    provider.getBlock = async (blockNumber: number) => ({
      timestamp: 1_700_000_000 + blockNumber - 52_000_000,
    });

    const event = await client.findBundleSubmission(EVIDENCE_HASH);

    expect(event?.transactionHash).toBe(TRANSACTION_HASH);
    expect(queries).toEqual([{ fromBlock: 52_000_005, toBlock: 52_000_005 }]);
  });
});
