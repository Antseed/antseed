import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { Contract, ContractFactory, HDNodeWallet, Interface, JsonRpcProvider, NonceManager, Wallet, ZeroAddress, verifyTypedData } from 'ethers'
import type { AntsChainConfig } from '@antseed/ants'
import { makeDepositsDomain, SET_OPERATOR_TYPES } from '@antseed/node'
import { ConsoleError } from '../console-api/router.js'
import {
  depositsOperatorReader,
  normalizeOperator,
  OperatorCache,
  operatorRelation,
  setOperatorCalldata,
  signOperatorAuthorization,
  transferOperatorCalldata,
  walletOwnerFromDb,
  type OperatorReader,
} from './operator.js'

// Obvious fakes only.
const BUYER = new Wallet(`0x${'31'.repeat(32)}`)
const OPERATOR_A = `0x${'0a'.repeat(20)}`
const OPERATOR_B = `0x${'0b'.repeat(20)}`
const CHAIN = {
  chainId: 'base-mainnet',
  evmChainId: 8453,
  rpcUrl: 'https://rpc.example.test',
  depositsContractAddress: `0x${'d1'.repeat(20)}`,
  usdcContractAddress: `0x${'a1'.repeat(20)}`,
} as AntsChainConfig

function fakeReader(state: { operator: string | null; nonce: bigint }, log: string[] = []): OperatorReader {
  return {
    operator: async (buyer) => { log.push(`operator:${buyer}`); return normalizeOperator(state.operator) },
    nonce: async (buyer) => { log.push(`nonce:${buyer}`); return state.nonce },
  }
}

test('normalizeOperator drops the zero address and junk, checksums the rest', () => {
  assert.equal(normalizeOperator(ZeroAddress), null)
  assert.equal(normalizeOperator('0x1234'), null)
  assert.equal(normalizeOperator(undefined), null)
  assert.equal(normalizeOperator(OPERATOR_A.toUpperCase().replace('0X', '0x'))?.toLowerCase(), OPERATOR_A)
})

test('operatorRelation covers none, self, yours, member, unknown', () => {
  const ownerOf = (address: string) => (address.toLowerCase() === OPERATOR_A ? { memberId: 'm_owner', label: 'Owner' } : null)
  const base = { buyer: BUYER.address, ownerOf }
  assert.equal(operatorRelation({ ...base, operator: null, viewerMemberId: 'm_owner' }).relation, 'none')
  assert.equal(operatorRelation({ ...base, operator: BUYER.address.toLowerCase(), viewerMemberId: 'm_owner' }).relation, 'self')
  assert.equal(operatorRelation({ ...base, operator: OPERATOR_A, viewerMemberId: 'm_owner' }).relation, 'yours')
  assert.equal(operatorRelation({ ...base, operator: OPERATOR_A, viewerMemberId: 'm_other' }).relation, 'member')
  assert.equal(operatorRelation({ ...base, operator: OPERATOR_A, viewerMemberId: null }).relation, 'member')
  assert.equal(operatorRelation({ ...base, operator: OPERATOR_B, viewerMemberId: 'm_owner' }).relation, 'unknown')
})

test('walletOwnerFromDb finds the member signing in with a wallet; disabled members and missing tables give null', () => {
  const db = new Database(':memory:')
  assert.equal(walletOwnerFromDb(db, () => null, OPERATOR_A), null)
  db.exec("CREATE TABLE auth_credentials (id TEXT, member_id TEXT, kind TEXT, wallet_address TEXT)")
  db.prepare('INSERT INTO auth_credentials VALUES (?, ?, ?, ?)').run('c1', 'm1', 'wallet', OPERATOR_A)
  db.prepare('INSERT INTO auth_credentials VALUES (?, ?, ?, ?)').run('c2', 'm2', 'wallet', OPERATOR_B)
  const members: Record<string, { id: string; label: string; status: string }> = {
    m1: { id: 'm1', label: 'One', status: 'active' },
    m2: { id: 'm2', label: 'Two', status: 'disabled' },
  }
  assert.deepEqual(walletOwnerFromDb(db, (id) => members[id] ?? null, OPERATOR_A.toUpperCase().replace('0X', '0x')), { memberId: 'm1', label: 'One' })
  assert.equal(walletOwnerFromDb(db, (id) => members[id] ?? null, OPERATOR_B), null)
  db.close()
})

test('OperatorCache shares concurrent reads, keeps the TTL, and forgets failures', async () => {
  let now = 1_000
  let calls = 0
  let fail = false
  const cache = new OperatorCache(() => now, 60_000, 3_000)
  const load = async () => {
    calls += 1
    if (fail) throw new Error('rpc down')
    return OPERATOR_A
  }
  const [a, b] = await Promise.all([cache.read(BUYER.address, load), cache.read(BUYER.address.toLowerCase(), load)])
  assert.equal(calls, 1)
  assert.equal(a.operator, OPERATOR_A)
  assert.equal(b.checkedAt, 1_000)
  assert.deepEqual(cache.known(BUYER.address), { operator: OPERATOR_A })
  now += 61_000
  fail = true
  await assert.rejects(cache.read(BUYER.address, load), /rpc down/)
  // The last good value stays known (for change audits) but is due for a re-read.
  assert.deepEqual(cache.known(BUYER.address), { operator: OPERATOR_A })
  fail = false
  await cache.read(BUYER.address, load)
  assert.equal(calls, 3)
})

test('signOperatorAuthorization reads the operator then the nonce, live, and signs the SetOperator struct', async () => {
  const log: string[] = []
  const auth = await signOperatorAuthorization({ wallet: BUYER, chain: CHAIN, operator: OPERATOR_A, reader: fakeReader({ operator: null, nonce: 7n }, log) })
  assert.deepEqual(log, [`operator:${BUYER.address}`, `nonce:${BUYER.address}`])
  assert.equal(auth.nonce, '7')
  assert.equal(auth.nonceValue, 7n)
  assert.equal(auth.chainId, 8453)
  const signer = verifyTypedData(makeDepositsDomain(8453, CHAIN.depositsContractAddress!), SET_OPERATOR_TYPES, { operator: OPERATOR_A, nonce: 7n }, auth.signature)
  assert.equal(signer, BUYER.address)
  // Calldata matches the contract's ABI.
  const iface = new Interface(['function setOperator(address buyer, address operator, uint256 nonce, bytes buyerSig)', 'function transferOperator(address buyer, address newOperator)'])
  const decoded = iface.decodeFunctionData('setOperator', setOperatorCalldata(auth.buyer, auth.operator!, auth.nonceValue, auth.signature))
  assert.equal(decoded[2], 7n)
  assert.equal(iface.decodeFunctionData('transferOperator', transferOperatorCalldata(BUYER.address, ZeroAddress))[1], ZeroAddress)
})

test('signOperatorAuthorization refuses when an operator is set, or the chain cannot be read', async () => {
  await assert.rejects(
    signOperatorAuthorization({ wallet: BUYER, chain: CHAIN, operator: OPERATOR_A, reader: fakeReader({ operator: OPERATOR_B, nonce: 1n }) }),
    (err: unknown) => err instanceof ConsoleError && err.status === 409 && err.code === 'operator_already_set' && err.message.includes(normalizeOperator(OPERATOR_B)!),
  )
  const broken: OperatorReader = { operator: async () => { throw new Error('rpc down') }, nonce: async () => 0n }
  await assert.rejects(signOperatorAuthorization({ wallet: BUYER, chain: CHAIN, operator: OPERATOR_A, reader: broken }), (err: unknown) => err instanceof ConsoleError && err.code === 'chain_unavailable')
  await assert.rejects(signOperatorAuthorization({ wallet: BUYER, chain: CHAIN, operator: ZeroAddress, reader: fakeReader({ operator: null, nonce: 0n }) }), (err: unknown) => err instanceof ConsoleError && err.code === 'invalid_operator')
  await assert.rejects(signOperatorAuthorization({ wallet: BUYER, chain: { ...CHAIN, depositsContractAddress: undefined }, operator: OPERATOR_A, reader: fakeReader({ operator: null, nonce: 0n }) }), (err: unknown) => err instanceof ConsoleError && err.code === 'chain_unavailable')
})

// ── Optional end-to-end run against a local anvil chain ──────────────────

const ARTIFACT = fileURLToPath(new URL('../../../../../packages/contracts/out/AntseedDeposits.sol/AntseedDeposits.json', import.meta.url))
const ANVIL = spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status === 0
// anvil's public dev mnemonic (accounts 0-2): test keys, never real funds.
const DEV_MNEMONIC = 'test test test test test test test test test test test junk'
const devWallet = (index: number) => HDNodeWallet.fromPhrase(DEV_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`)

async function startAnvil(): Promise<{ url: string; process: ChildProcess }> {
  const port = 20_000 + Math.floor(Math.random() * 20_000)
  const child = spawn('anvil', ['--port', String(port), '--silent'], { stdio: 'ignore' })
  const url = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) })
      if (response.ok) return { url, process: child }
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  child.kill()
  throw new Error('anvil did not start')
}

function revertName(iface: Interface, err: unknown): string | null {
  const data = (err as { data?: string; info?: { error?: { data?: string } } }).data ?? (err as { info?: { error?: { data?: string } } }).info?.error?.data
  if (typeof data !== 'string') return (err as { revert?: { name?: string } }).revert?.name ?? null
  return iface.parseError(data)?.name ?? null
}

test('anvil: authorize, refuse a second authorization, transfer, clear, re-authorize with the next nonce', { skip: !ANVIL || !existsSync(ARTIFACT) ? 'anvil or the AntseedDeposits artifact is not available' : false, timeout: 60_000 }, async () => {
  const { url, process: anvil } = await startAnvil()
  try {
    const provider = new JsonRpcProvider(url, 31_337, { staticNetwork: true })
    const [deployer, operatorA, operatorB] = [0, 1, 2].map((index) => new NonceManager(devWallet(index).connect(provider)))
    const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8')) as { abi: unknown[]; bytecode: { object: string } }
    const factory = new ContractFactory(artifact.abi as never, artifact.bytecode.object, deployer!)
    const deployed = await factory.deploy(`0x${'a1'.repeat(20)}`)
    await deployed.waitForDeployment()
    const address = await deployed.getAddress()
    const iface = new Interface(artifact.abi as never)
    const chain = { chainId: 'base-local', evmChainId: 31_337, rpcUrl: url, depositsContractAddress: address, usdcContractAddress: `0x${'a1'.repeat(20)}` } as AntsChainConfig
    const reader = depositsOperatorReader(chain)
    const buyer = Wallet.createRandom()
    const addressA = await operatorA!.getAddress()
    const addressB = await operatorB!.getAddress()
    const asA = new Contract(address, artifact.abi as never, operatorA)
    const asB = new Contract(address, artifact.abi as never, operatorB)

    // No operator → authorize A: the buyer signs, A submits and pays gas.
    assert.equal(await reader.operator(buyer.address), null)
    const first = await signOperatorAuthorization({ wallet: buyer, chain, operator: addressA, reader })
    assert.equal(first.nonce, '0')
    await (await asA.getFunction('setOperator')(buyer.address, addressA, first.nonceValue, first.signature)).wait()
    assert.equal(await reader.operator(buyer.address), addressA)
    assert.equal(await reader.nonce(buyer.address), 1n)

    // Set: the gateway refuses to sign; replaying the old signature reverts.
    await assert.rejects(signOperatorAuthorization({ wallet: buyer, chain, operator: addressB, reader }), (err: unknown) => err instanceof ConsoleError && err.code === 'operator_already_set')
    const replay = await asB.getFunction('setOperator').staticCall(buyer.address, addressA, 0n, first.signature).then(() => null, (err: unknown) => revertName(iface, err))
    assert.equal(replay, 'OperatorAlreadySet')

    // Only the current operator can transfer.
    const stranger = await asB.getFunction('transferOperator').staticCall(buyer.address, addressB).then(() => null, (err: unknown) => revertName(iface, err))
    assert.equal(stranger, 'NotAuthorized')
    await (await asA.getFunction('transferOperator')(buyer.address, addressB)).wait()
    assert.equal(await reader.operator(buyer.address), addressB)

    // B clears it (transfer to the zero address); the nonce stays at 1.
    await (await asB.getFunction('transferOperator')(buyer.address, ZeroAddress)).wait()
    assert.equal(await reader.operator(buyer.address), null)
    assert.equal(await reader.nonce(buyer.address), 1n)

    // The nonce-0 signature cannot be replayed after clearing; a fresh one (nonce 1) works.
    const stale = await asA.getFunction('setOperator').staticCall(buyer.address, addressA, 0n, first.signature).then(() => null, (err: unknown) => revertName(iface, err))
    assert.equal(stale, 'InvalidNonce')
    const second = await signOperatorAuthorization({ wallet: buyer, chain, operator: addressA, reader })
    assert.equal(second.nonce, '1')
    await (await asA.getFunction('setOperator')(buyer.address, addressA, second.nonceValue, second.signature)).wait()
    assert.equal(await reader.operator(buyer.address), addressA)
    provider.destroy()
  } finally {
    anvil.kill()
  }
})
