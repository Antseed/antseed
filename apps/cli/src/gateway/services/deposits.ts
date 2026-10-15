/**
 * Deposit confirmations: a deposit credited to a workspace wallet, checked
 * against its transaction receipt so the confirmation states only what the
 * chain shows.
 *
 * Two kinds of deposit credit a wallet:
 * - relay: USDC is sent to the workspace wallet (from a wallet, an exchange,
 *   or minted straight in by the USDC issuer for a card purchase) and a
 *   relayer sweeps it into AntseedDeposits, keeping a fixed fee
 *   (`SweepExecuted`). Where the USDC came from is the USDC `Transfer`s into
 *   the wallet shortly before the sweep, found with one bounded log query.
 * - direct: a connected wallet deposits for the workspace wallet itself
 *   (`Deposited` without a sweep); the payer is the transaction's sender.
 */
import { Interface, getAddress, type Log, type TransactionReceipt } from 'ethers'
import type { DepositSource } from '../store.js'

/** Public RPCs cap log queries at about 1000 blocks; on Base that is the half hour before the sweep. */
export const SOURCE_LOOKBACK_BLOCKS = 999

const DEPOSITS_ABI = new Interface(['event Deposited(address indexed buyer, uint256 amount)'])
const RELAY_ABI = new Interface(['event SweepExecuted(address indexed buyer, address indexed relayer, uint256 deposited, uint256 fee, bytes32 authNonce)'])
const USDC_ABI = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)'])

export interface DepositChain {
  depositsContractAddress: string
  depositRelayAddress?: string | undefined
  usdcContractAddress: string
}

/** The provider calls this needs; ethers providers (and the shared chain provider) satisfy it. */
export interface DepositChainProvider {
  getTransactionReceipt(hash: string): Promise<TransactionReceipt | null>
  getTransaction(hash: string): Promise<{ from: string } | null>
  getBlock(block: number): Promise<{ timestamp: number } | null>
  getLogs(filter: { address: string; topics: Array<string | null>; fromBlock: number; toBlock: number }): Promise<Log[]>
}

export interface VerifiedDeposit {
  txHash: string
  wallet: string
  kind: 'relay' | 'direct'
  creditedUsdc: number
  feeUsdc: number
  blockNumber: number
  /** Epoch ms. */
  blockTime: number
  sources: DepositSource[]
}

const same = (a: string, b: string | undefined): boolean => !!b && a.toLowerCase() === b.toLowerCase()

function parse(abi: Interface, log: Log) {
  try {
    return abi.parseLog({ topics: [...log.topics], data: log.data })
  } catch {
    return null
  }
}

/**
 * The deposit `txHash` credited to `wallet`, or null when the transaction
 * failed or credited another wallet (or nothing). Where the money came from
 * is best effort: an RPC that refuses the log query leaves `sources` empty.
 */
export async function verifyDeposit(provider: DepositChainProvider, chain: DepositChain, txHash: string, wallet: string): Promise<VerifiedDeposit | null> {
  const receipt = await provider.getTransactionReceipt(txHash)
  if (!receipt || receipt.status !== 1) return null
  let credited: bigint | null = null
  let fee: bigint | null = null
  let swept: bigint | null = null
  for (const log of receipt.logs) {
    if (same(log.address, chain.depositsContractAddress)) {
      const event = parse(DEPOSITS_ABI, log)
      if (event?.name === 'Deposited' && same(event.args[0] as string, wallet)) credited = (credited ?? 0n) + (event.args[1] as bigint)
    } else if (chain.depositRelayAddress && same(log.address, chain.depositRelayAddress)) {
      const event = parse(RELAY_ABI, log)
      if (event?.name === 'SweepExecuted' && same(event.args[0] as string, wallet)) {
        swept = event.args[2] as bigint
        fee = event.args[3] as bigint
      }
    }
  }
  if (credited === null) return null
  const block = await provider.getBlock(receipt.blockNumber)
  const kind = swept !== null ? 'relay' : 'direct'
  const sources = kind === 'relay'
    ? await incomingTransfers(provider, chain, wallet, receipt.blockNumber, receipt.hash, credited + (fee ?? 0n)).catch(() => [])
    : await directPayer(provider, chain, receipt).catch(() => [])
  return {
    txHash: receipt.hash.toLowerCase(),
    wallet: getAddress(wallet),
    kind,
    creditedUsdc: Number(credited),
    feeUsdc: Number(fee ?? 0n),
    blockNumber: receipt.blockNumber,
    blockTime: (block?.timestamp ?? 0) * 1000,
    sources,
  }
}

/**
 * USDC that arrived in the wallet before the sweep, newest first, until it
 * covers what the sweep moved (credited + fee). A transfer from the zero
 * address is USDC the issuer minted into the wallet (a card purchase).
 */
async function incomingTransfers(provider: DepositChainProvider, chain: DepositChain, wallet: string, sweepBlock: number, sweepTx: string, swept: bigint): Promise<DepositSource[]> {
  const transfer = USDC_ABI.getEvent('Transfer')!.topicHash
  const to = `0x${wallet.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`
  const logs = await provider.getLogs({
    address: chain.usdcContractAddress,
    topics: [transfer, null, to],
    fromBlock: Math.max(0, sweepBlock - SOURCE_LOOKBACK_BLOCKS),
    toBlock: sweepBlock,
  })
  const sources: DepositSource[] = []
  let covered = 0n
  for (const log of [...logs].reverse()) {
    if (same(log.transactionHash, sweepTx)) continue
    const event = parse(USDC_ABI, log)
    if (!event) continue
    const amount = event.args[2] as bigint
    sources.push({ from: getAddress(event.args[0] as string), amountUsdc: Number(amount), txHash: log.transactionHash.toLowerCase() })
    covered += amount
    if (covered >= swept) break
  }
  return sources.reverse()
}

/** A direct deposit: the transaction's sender paid, by the USDC it moved in the same transaction. */
async function directPayer(provider: DepositChainProvider, chain: DepositChain, receipt: TransactionReceipt): Promise<DepositSource[]> {
  const tx = await provider.getTransaction(receipt.hash)
  if (!tx) return []
  let amount = 0n
  for (const log of receipt.logs) {
    if (!same(log.address, chain.usdcContractAddress)) continue
    const event = parse(USDC_ABI, log)
    if (event?.name === 'Transfer' && same(event.args[0] as string, tx.from)) amount += event.args[2] as bigint
  }
  return [{ from: getAddress(tx.from), amountUsdc: Number(amount), txHash: receipt.hash.toLowerCase() }]
}
