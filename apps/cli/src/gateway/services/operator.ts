/**
 * The workspace wallet's "authorized wallet": its AntseedDeposits operator,
 * the only address that can withdraw the wallet's deposits and claim its
 * ANTS rewards (both go to the operator), and the only one that can hand the
 * role over or clear it. Shared by the console API and `antseed gateway
 * workspace operator`. Contract rules are summarized in
 * console-api/operator-types.ts.
 */
import type { AntsChainConfig } from '@antseed/ants'
import { DepositsClient, makeDepositsDomain, signSetOperator } from '@antseed/node'
import { getAddress, Interface, type AbstractSigner } from 'ethers'
import type Database from 'better-sqlite3'
import type { OperatorAuthorization, OperatorRelation } from '../console-api/operator-types.js'
import { ConsoleError } from '../console-api/router.js'
import { ChainReadCache } from '../../proxy/chain-read-cache.js'
import { sharedChainProvider } from '../../proxy/chain-rpc.js'
import { errorMessage } from '../errors.js'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const ZERO_RE = /^0x0{40}$/

/** Live reads of one buyer's operator state. Never cached: callers cache what they want. */
export interface OperatorReader {
  /** The current operator, or null when none is set. */
  operator(buyer: string): Promise<string | null>
  /** The nonce the next SetOperator signature must carry. */
  nonce(buyer: string): Promise<bigint>
}

/** A checksummed address, or null for anything else (including the zero address). */
export function normalizeOperator(value: unknown): string | null {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value) || ZERO_RE.test(value)) return null
  return getAddress(value.toLowerCase())
}

export function isOperatorAddress(value: unknown): value is string {
  return normalizeOperator(value) !== null
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}

function depositsClient(chain: AntsChainConfig): DepositsClient {
  if (!chain.depositsContractAddress || !chain.usdcContractAddress) {
    throw new ConsoleError(503, 'chain_unavailable', 'The deposits contract is not configured for this chain.')
  }
  const target = {
    rpcUrl: chain.rpcUrl,
    ...(chain.fallbackRpcUrls ? { fallbackRpcUrls: chain.fallbackRpcUrls } : {}),
    evmChainId: chain.evmChainId,
  }
  // Through the process's one rate-aware provider, not a new one per read.
  return new DepositsClient({ ...target, contractAddress: chain.depositsContractAddress, usdcAddress: chain.usdcContractAddress })
    .withProvider(sharedChainProvider(target))
}

/** Reads straight from AntseedDeposits on the configured chain. */
export function depositsOperatorReader(chain: AntsChainConfig): OperatorReader {
  const client = depositsClient(chain)
  return {
    operator: async (buyer) => normalizeOperator(await client.getOperator(buyer)),
    nonce: (buyer) => client.getOperatorNonce(buyer),
  }
}

/**
 * Operator reads per buyer address, shared by every console request: one RPC
 * call per buyer per `ttlMs`, concurrent readers share it. A fresh read
 * (after a transaction) is allowed once per `freshIntervalMs`; within that
 * the last read stands. Entries live in a `ChainReadCache` (pass the
 * gateway's shared one), under `operator:<address>`. A failed read is an
 * error, never a stale operator: the authorized wallet is a security fact.
 */
export class OperatorCache {
  readonly cache: ChainReadCache
  private readonly settled = new Map<string, { operator: string | null }>()

  constructor(
    now: () => number,
    private readonly ttlMs = 60_000,
    private readonly freshIntervalMs = 3_000,
    cache?: ChainReadCache,
  ) {
    this.cache = cache ?? new ChainReadCache({ now })
  }

  static key(buyer: string): string {
    return `operator:${buyer.toLowerCase()}`
  }

  /** The last value read for `buyer`, or undefined when none has been read. */
  known(buyer: string): { operator: string | null } | undefined {
    return this.settled.get(buyer.toLowerCase())
  }

  async read(buyer: string, load: () => Promise<string | null>, fresh = false): Promise<{ operator: string | null; checkedAt: number }> {
    const key = OperatorCache.key(buyer)
    const age = this.cache.age(key)
    const force = fresh && (age === null || age >= this.freshIntervalMs)
    const read = await this.cache.read(key, { ttlMs: this.ttlMs, force, serveStaleOnError: false, errorRetryMs: 0 }, load)
    this.settled.set(buyer.toLowerCase(), { operator: read.value })
    return { operator: read.value, checkedAt: read.fetchedAt }
  }
}

export interface WalletOwner {
  memberId: string
  label: string
}

/**
 * The member who signs in with `address` (a SIWE wallet credential), or
 * null. Reads auth's credentials table; a gateway without it has no owners.
 */
export function walletOwnerFromDb(db: Database.Database, getMember: (id: string) => { id: string; label: string; status: string } | null, address: string): WalletOwner | null {
  let memberId: string | undefined
  try {
    const row = db.prepare("SELECT member_id FROM auth_credentials WHERE kind = 'wallet' AND wallet_address = ?").get(address.toLowerCase()) as { member_id: string } | undefined
    memberId = row?.member_id
  } catch {
    return null
  }
  if (!memberId) return null
  const member = getMember(memberId)
  return member && member.status !== 'disabled' ? { memberId: member.id, label: member.label } : null
}

/** How the operator relates to the caller; see `OperatorRelation`. */
export function operatorRelation(input: {
  buyer: string
  operator: string | null
  /** The signed-in member asking, or null (management token, CLI). */
  viewerMemberId: string | null
  ownerOf: (address: string) => WalletOwner | null
}): { relation: OperatorRelation; owner: WalletOwner | null } {
  if (!input.operator) return { relation: 'none', owner: null }
  if (sameAddress(input.operator, input.buyer)) return { relation: 'self', owner: null }
  const owner = input.ownerOf(input.operator)
  if (!owner) return { relation: 'unknown', owner: null }
  if (input.viewerMemberId && owner.memberId === input.viewerMemberId) return { relation: 'yours', owner }
  return { relation: 'member', owner }
}

/** One sentence on what the relation means, for the CLI. */
export function describeRelation(relation: OperatorRelation, owner: WalletOwner | null): string {
  switch (relation) {
    case 'none': return 'No authorized wallet: nobody can withdraw or claim rewards until one is authorized.'
    case 'self': return 'The workspace wallet is its own authorized wallet: withdrawals and rewards stay in the gateway-held wallet.'
    case 'yours': return 'One of your own sign-in wallets.'
    case 'member': return `The sign-in wallet of ${owner ? `member ${owner.label} (${owner.memberId})` : 'another member'}.`
    case 'unknown': return 'WARNING: no member of this gateway signs in with this wallet. Withdrawals and rewards go to it, and only it can change or clear the authorization.'
  }
}

/** SigningWallet's EIP-712 half; ethers wallets have it. */
export interface TypedDataSigner {
  address: string
  signTypedData?: AbstractSigner['signTypedData']
}

/**
 * Signs the buyer's SetOperator authorization for `operator`. Reads the
 * current operator and the nonce straight from the chain right before
 * signing: a signature for a buyer that already has an operator could never
 * be used (OperatorAlreadySet), and a stale nonce would revert (InvalidNonce).
 */
export async function signOperatorAuthorization(input: {
  wallet: TypedDataSigner
  chain: AntsChainConfig
  operator: string
  reader: OperatorReader
}): Promise<OperatorAuthorization & { nonceValue: bigint }> {
  const operator = normalizeOperator(input.operator)
  if (!operator) throw new ConsoleError(400, 'invalid_operator', 'operator must be a wallet address.')
  if (typeof input.wallet.signTypedData !== 'function') {
    throw new ConsoleError(409, 'wallet_unavailable', 'The workspace wallet cannot sign typed data on this gateway.')
  }
  if (!input.chain.depositsContractAddress) throw new ConsoleError(503, 'chain_unavailable', 'The deposits contract is not configured for this chain.')
  const buyer = input.wallet.address
  let current: string | null
  let nonce: bigint
  try {
    current = await input.reader.operator(buyer)
    // Read after the operator: setOperator bumps the nonce, so this is never older than `current`.
    nonce = await input.reader.nonce(buyer)
  } catch (err) {
    if (err instanceof ConsoleError) throw err
    throw new ConsoleError(502, 'chain_unavailable', `The operator nonce could not be read: ${errorMessage(err)}`)
  }
  if (current) {
    throw new ConsoleError(409, 'operator_already_set', `This wallet already has an authorized wallet (${current}). Only that wallet can transfer or clear the authorization.`)
  }
  const domain = makeDepositsDomain(input.chain.evmChainId, input.chain.depositsContractAddress)
  const signature = await signSetOperator(input.wallet as unknown as AbstractSigner, domain, { operator, nonce })
  return {
    buyer,
    operator,
    nonce: nonce.toString(),
    nonceValue: nonce,
    signature,
    depositsContract: getAddress(input.chain.depositsContractAddress.toLowerCase()),
    chainId: input.chain.evmChainId,
  }
}

const DEPOSITS_OPERATOR_IFACE = new Interface([
  'function setOperator(address buyer, address operator, uint256 nonce, bytes buyerSig)',
  'function transferOperator(address buyer, address newOperator)',
])

export function setOperatorCalldata(buyer: string, operator: string, nonce: bigint, signature: string): string {
  return DEPOSITS_OPERATOR_IFACE.encodeFunctionData('setOperator', [buyer, operator, nonce, signature])
}

export function transferOperatorCalldata(buyer: string, newOperator: string): string {
  return DEPOSITS_OPERATOR_IFACE.encodeFunctionData('transferOperator', [buyer, newOperator])
}
