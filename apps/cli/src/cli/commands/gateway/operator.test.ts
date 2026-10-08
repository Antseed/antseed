import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, before, beforeEach } from 'node:test'
import { Command } from 'commander'
import { verifyTypedData } from 'ethers'
import type { AntsChainConfig } from '@antseed/ants'
import { makeDepositsDomain, SET_OPERATOR_TYPES } from '@antseed/node'
import { AuthDb } from '../../../gateway/auth/db.js'
import { addActiveMember } from '../../../gateway/console-api/test-support.js'
import { normalizeOperator } from '../../../gateway/services/operator.js'
import { GatewayStore } from '../../../gateway/store.js'
import { operatorCliRuntime } from './operator.js'
import { registerGatewayWorkspaceCommands } from './workspace.js'
import { gatewayCliRuntime } from './shared.js'

// Never ask a buyer that may be running on this machine; tests that need one inject it.
gatewayCliRuntime.buyerAddresses = async () => null

// Obvious fakes only.
const MEMBER_WALLET = `0x${'0a'.repeat(20)}`
const STRANGER = `0x${'0c'.repeat(20)}`
const CHAIN = {
  chainId: 'base-mainnet',
  evmChainId: 8453,
  rpcUrl: 'https://rpc.example.test',
  depositsContractAddress: `0x${'d1'.repeat(20)}`,
  usdcContractAddress: `0x${'a1'.repeat(20)}`,
} as AntsChainConfig

let dataDir: string
let configPath: string
const chain = { operator: null as string | null, nonce: 0n }
let answers: boolean[] = []
const original = { ...operatorCliRuntime }

async function run(...args: string[]): Promise<string> {
  const program = new Command()
  program.exitOverride().option('--data-dir <path>').option('--config <path>')
  registerGatewayWorkspaceCommands(program.command('gateway'))
  const lines: string[] = []
  const log = console.log
  const error = console.error
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')) }
  console.error = () => {}
  try {
    await program.parseAsync(['node', 'antseed', '--data-dir', dataDir, '--config', configPath, 'gateway', 'workspace', 'operator', ...args])
  } finally {
    console.log = log
    console.error = error
  }
  return lines.join('\n')
}

function withStore<T>(fn: (store: GatewayStore) => T): T {
  const store = new GatewayStore(dataDir)
  try {
    return fn(store)
  } finally {
    store.close()
  }
}

function audits(): Array<{ action: string; actor: { kind: string }; details: Record<string, unknown> }> {
  return withStore((store) => store.listAudit({ limit: 100 }).entries) as never
}

before(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'antseed-operator-cli-'))
  configPath = join(dataDir, 'config.json')
  writeFileSync(configPath, '{}')
  operatorCliRuntime.resolveChain = async () => CHAIN
  operatorCliRuntime.reader = () => ({ operator: async () => normalizeOperator(chain.operator), nonce: async () => chain.nonce })
  operatorCliRuntime.confirm = async () => answers.shift() ?? false
  withStore((store) => {
    const member = addActiveMember(store, 'Ali', { orgRole: 'admin', email: 'ali@example.test' })
    new AuthDb(store.database, () => Date.now()).addCredential(member.id, { kind: 'wallet', label: 'Ali wallet', address: MEMBER_WALLET })
  })
})

after(() => {
  Object.assign(operatorCliRuntime, original)
  rmSync(dataDir, { recursive: true, force: true })
})

beforeEach(() => {
  chain.operator = null
  chain.nonce = 0n
  answers = []
})

test('show reports each state with whose wallet it is', async () => {
  const none = JSON.parse(await run('show', 'Default', '--json')) as Record<string, unknown>
  assert.equal(none['relation'], 'none')
  assert.equal(none['operator'], null)
  chain.operator = MEMBER_WALLET
  const member = JSON.parse(await run('show', 'Default', '--json')) as Record<string, unknown>
  assert.equal(member['relation'], 'member')
  assert.equal((member['member'] as { label: string }).label, 'Ali')
  chain.operator = STRANGER
  assert.equal((JSON.parse(await run('show', 'Default', '--json')) as Record<string, unknown>)['relation'], 'unknown')
  chain.operator = none['buyer'] as string
  assert.equal((JSON.parse(await run('show', 'Default', '--json')) as Record<string, unknown>)['relation'], 'self')
  assert.match(await run('show', 'Default'), /operator transfer/)
})

test('authorize needs a confirmation; declining signs nothing', async () => {
  answers = [false]
  await assert.rejects(run('authorize', 'Default', MEMBER_WALLET), /Cancelled; nothing was signed/)
  assert.equal(audits().filter((entry) => entry.action === 'wallet.operator_auth').length, 0)
})

test('authorize signs with the live nonce, prints calldata and audits as the CLI', async () => {
  chain.nonce = 5n
  answers = [true]
  const human = await run('authorize', 'Default', MEMBER_WALLET)
  assert.match(human, /cast send 0x[dD]1/)
  assert.match(human, /nonce {5}5/)
  const out = JSON.parse(await run('authorize', 'Default', MEMBER_WALLET, '--yes', '--json')) as Record<string, string>
  assert.equal(out['nonce'], '5')
  assert.match(out['calldata']!, /^0x/)
  assert.equal(out['explorerWriteUrl'], `https://basescan.org/address/${out['depositsContract']}#writeContract`)
  const signer = verifyTypedData(makeDepositsDomain(8453, CHAIN.depositsContractAddress!), SET_OPERATOR_TYPES, { operator: MEMBER_WALLET, nonce: 5n }, out['signature']!)
  assert.equal(signer, out['buyer'])
  const signed = audits().filter((entry) => entry.action === 'wallet.operator_auth')
  assert.equal(signed.length, 2)
  assert.equal(signed[0]!.actor.kind, 'cli')
  assert.equal(signed[0]!.details['nonce'], '5')
})

test('authorize refuses when an authorized wallet is set, and bad input', async () => {
  chain.operator = STRANGER
  await assert.rejects(run('authorize', 'Default', MEMBER_WALLET, '--yes'), /already has an authorized wallet/)
  await assert.rejects(run('authorize', 'Default', '0x1234', '--yes'), /non-zero 0x wallet address/)
  await assert.rejects(run('authorize', 'Default', '--yes'), /Pass the wallet address/)
  await assert.rejects(run('authorize', 'Default', MEMBER_WALLET, '--browser', '--yes'), /either an address or --browser/)
  await assert.rejects(run('authorize', 'Default', '--browser', '--yes'), /already has an authorized wallet/)
})

test('transfer is only for a self-authorized workspace wallet', async () => {
  chain.operator = MEMBER_WALLET
  await assert.rejects(run('transfer', 'Default', STRANGER, '--yes'), /Only that wallet can transfer or clear it/)
  chain.operator = null
  await assert.rejects(run('transfer', 'Default', STRANGER, '--yes'), /has no authorized wallet/)
  await assert.rejects(run('transfer', 'Default', STRANGER, '--clear', '--yes'), /Pass the new address, or --clear/)
})

test('authorize refuses to sign when the running buyer pays from another wallet', async () => {
  const live = `0x${'0e'.repeat(20)}`
  gatewayCliRuntime.buyerAddresses = async () => new Map([['default', live]])
  try {
    answers = [true]
    await assert.rejects(run('authorize', 'Default', MEMBER_WALLET, '--yes'), (err: Error) => {
      assert.match(err.message, /running buyer pays from 0x0e/i)
      return true
    })
    // Reads follow the buyer's wallet, not the key in the data dir.
    assert.equal((JSON.parse(await run('show', 'Default', '--json')) as Record<string, unknown>)['buyer'], live)
  } finally {
    gatewayCliRuntime.buyerAddresses = async () => null
  }
})
