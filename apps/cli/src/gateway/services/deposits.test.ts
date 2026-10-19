import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AbiCoder, Interface, zeroPadValue, type Log, type TransactionReceipt } from 'ethers'
import { SOURCE_LOOKBACK_BLOCKS, verifyDeposit, type DepositChainProvider } from './deposits.js'

// Obvious fakes: fixed test addresses and hashes, never real ones.
const DEPOSITS = `0x${'d0'.repeat(20)}`
const RELAY = `0x${'e0'.repeat(20)}`
const USDC = `0x${'f0'.repeat(20)}`
const WALLET = `0x${'11'.repeat(20)}`
const PAYER = `0x${'22'.repeat(20)}`
const RELAYER = `0x${'33'.repeat(20)}`
const SWEEP_TX = `0x${'a1'.repeat(32)}`
const FUND_TX = `0x${'b2'.repeat(32)}`
const CHAIN = { depositsContractAddress: DEPOSITS, depositRelayAddress: RELAY, usdcContractAddress: USDC }

const abi = new Interface([
  'event Deposited(address indexed buyer, uint256 amount)',
  'event SweepExecuted(address indexed buyer, address indexed relayer, uint256 deposited, uint256 fee, bytes32 authNonce)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])
const coder = AbiCoder.defaultAbiCoder()
const topic = (address: string) => zeroPadValue(address, 32)
const log = (address: string, topics: string[], data: string, txHash: string): Log => ({ address, topics, data, transactionHash: txHash } as unknown as Log)
const deposited = (buyer: string, amount: bigint, txHash: string) => log(DEPOSITS, [abi.getEvent('Deposited')!.topicHash, topic(buyer)], coder.encode(['uint256'], [amount]), txHash)
const swept = (buyer: string, net: bigint, fee: bigint, txHash: string) => log(RELAY, [abi.getEvent('SweepExecuted')!.topicHash, topic(buyer), topic(RELAYER)], coder.encode(['uint256', 'uint256', 'bytes32'], [net, fee, `0x${'00'.repeat(32)}`]), txHash)
const transfer = (from: string, to: string, value: bigint, txHash: string) => log(USDC, [abi.getEvent('Transfer')!.topicHash, topic(from), topic(to)], coder.encode(['uint256'], [value]), txHash)

function provider(receipt: { status: number; logs: Log[]; from?: string } | null, incoming: Log[] = []): DepositChainProvider & { queries: unknown[] } {
  const queries: unknown[] = []
  return {
    queries,
    getTransactionReceipt: async (hash) => (receipt ? { hash, status: receipt.status, blockNumber: 5_000, logs: receipt.logs } as unknown as TransactionReceipt : null),
    getTransaction: async () => ({ from: receipt?.from ?? PAYER }),
    getBlock: async () => ({ timestamp: 1_700_000_000 }),
    getLogs: async (filter) => { queries.push(filter); return incoming },
  }
}

test('a relayed deposit: credited, fee, and the USDC that funded it', async () => {
  const chain = provider(
    { status: 1, logs: [transfer(WALLET, RELAY, 1_050_000n, SWEEP_TX), deposited(WALLET, 1_000_000n, SWEEP_TX), swept(WALLET, 1_000_000n, 50_000n, SWEEP_TX)] },
    [transfer('0x0000000000000000000000000000000000000000', WALLET, 1_050_000n, FUND_TX)],
  )
  const result = await verifyDeposit(chain, CHAIN, SWEEP_TX, WALLET)
  assert.equal(result?.kind, 'relay')
  assert.equal(result?.creditedUsdc, 1_000_000)
  assert.equal(result?.feeUsdc, 50_000)
  assert.equal(result?.blockTime, 1_700_000_000_000)
  assert.deepEqual(result?.sources, [{ from: '0x0000000000000000000000000000000000000000', amountUsdc: 1_050_000, txHash: FUND_TX }])
  assert.deepEqual((chain.queries[0] as { fromBlock: number; toBlock: number }), { address: USDC, topics: [abi.getEvent('Transfer')!.topicHash, null, topic(WALLET)], fromBlock: 5_000 - SOURCE_LOOKBACK_BLOCKS, toBlock: 5_000 })
})

test('a direct deposit: the sender paid, no fee', async () => {
  const result = await verifyDeposit(provider({ status: 1, logs: [transfer(PAYER, DEPOSITS, 2_000_000n, SWEEP_TX), deposited(WALLET, 2_000_000n, SWEEP_TX)] }), CHAIN, SWEEP_TX, WALLET)
  assert.equal(result?.kind, 'direct')
  assert.equal(result?.feeUsdc, 0)
  assert.deepEqual(result?.sources, [{ from: PAYER, amountUsdc: 2_000_000, txHash: SWEEP_TX }])
})

test('not a deposit to this wallet: another wallet, a failed transaction, a forged event, or no receipt', async () => {
  const other = `0x${'99'.repeat(20)}`
  assert.equal(await verifyDeposit(provider({ status: 1, logs: [deposited(other, 1n, SWEEP_TX)] }), CHAIN, SWEEP_TX, WALLET), null)
  assert.equal(await verifyDeposit(provider({ status: 0, logs: [deposited(WALLET, 1n, SWEEP_TX)] }), CHAIN, SWEEP_TX, WALLET), null)
  const forged = { ...deposited(WALLET, 1n, SWEEP_TX), address: `0x${'66'.repeat(20)}` } as Log
  assert.equal(await verifyDeposit(provider({ status: 1, logs: [forged] }), CHAIN, SWEEP_TX, WALLET), null)
  assert.equal(await verifyDeposit(provider(null), CHAIN, SWEEP_TX, WALLET), null)
})

test('a log query the RPC refuses leaves the sources empty, not the confirmation', async () => {
  const chain = provider({ status: 1, logs: [deposited(WALLET, 1_000_000n, SWEEP_TX), swept(WALLET, 1_000_000n, 50_000n, SWEEP_TX)] })
  chain.getLogs = async () => { throw new Error('block range too large') }
  const result = await verifyDeposit(chain, CHAIN, SWEEP_TX, WALLET)
  assert.equal(result?.creditedUsdc, 1_000_000)
  assert.deepEqual(result?.sources, [])
})

test('USDC sent to the wallet is a transfer: the amount, and who sent it', async () => {
  const result = await verifyDeposit(provider({ status: 1, logs: [transfer(PAYER, WALLET, 40_000_000n, FUND_TX)] }), CHAIN, FUND_TX, WALLET)
  assert.equal(result?.kind, 'transfer')
  assert.equal(result?.creditedUsdc, 40_000_000)
  assert.equal(result?.feeUsdc, 0)
  assert.deepEqual(result?.sources, [{ from: PAYER, amountUsdc: 40_000_000, txHash: FUND_TX }])
  // USDC sent elsewhere, or by the protocol's own contracts, is not money coming in.
  assert.equal(await verifyDeposit(provider({ status: 1, logs: [transfer(PAYER, RELAYER, 1n, FUND_TX)] }), CHAIN, FUND_TX, WALLET), null)
  assert.equal(await verifyDeposit(provider({ status: 1, logs: [transfer(DEPOSITS, WALLET, 1n, FUND_TX)] }), CHAIN, FUND_TX, WALLET), null)
})
