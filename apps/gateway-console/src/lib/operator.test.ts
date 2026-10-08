import { describe, expect, it } from 'vitest'
import { BaseError, ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult } from 'viem'
import { seed } from '../mock/data'
import { mockOperatorState, OPERATOR_SCENARIOS, scenarioOperator, UNKNOWN_OPERATOR } from '../mock/operator'
import { DEPOSITS_OPERATOR_ABI } from '../wallet/operator-abi'
import {
  authorizeBlocker, checkAuthorization, eligibleWallets, OperatorPreflightError, operatorGate, operatorTxError, operatorView, relationFor, revertErrorName,
  type OperatorState,
} from './operator'

const BUYER = `0x${'11'.repeat(20)}`
const MINE = `0x${'0a'.repeat(20)}`
const NEW_WALLET = `0x${'0d'.repeat(20)}`
const OTHER = `0x${'0b'.repeat(20)}`
const NOW = 1_700_000_000_000
const HOUR = 3_600_000

function state(extra: Partial<OperatorState>): OperatorState {
  return { buyer: BUYER, operator: null, relation: 'none', memberLabel: null, canAuthorize: false, eligibleWallets: [], checkedAt: NOW, ...extra }
}

describe('operatorView', () => {
  it('none: the owner can authorize, everyone else reads only', () => {
    const owner = operatorView(state({ canAuthorize: true }), null)
    expect(owner).toMatchObject({ tone: 'warning', canAuthorize: true, canManage: false })
    expect(owner.body).toMatch(/authorize one of your wallets/)
    const member = operatorView(state({}), MINE)
    expect(member.canAuthorize).toBe(false)
    expect(member.body).toMatch(/Only the organization owner/)
  })

  it('yours: manage only with that wallet connected', () => {
    const yours = state({ operator: MINE, relation: 'yours' })
    expect(operatorView(yours, null)).toMatchObject({ tone: 'success', canManage: false })
    expect(operatorView(yours, null).manageHint).toMatch(/connect 0x0a0a/)
    expect(operatorView(yours, MINE.toUpperCase().replace('0X', '0x'))).toMatchObject({ canManage: true, manageHint: null })
  })

  it('member: names the member when the gateway says whose it is', () => {
    expect(operatorView(state({ operator: OTHER, relation: 'member', memberLabel: 'Ali' }), MINE).title).toMatch(/^Ali's wallet/)
    expect(operatorView(state({ operator: OTHER, relation: 'member' }), MINE).title).toMatch(/^Another member's wallet/)
  })

  it('unknown: calm summary with a link action; the full warning stays in the details', () => {
    const view = operatorView(state({ operator: OTHER, relation: 'unknown' }), MINE)
    expect(view.tone).toBe('info')
    expect(view.title).toMatch(/^Authorized wallet 0x0b0b/)
    expect(view.badge).toBe('Not linked to a console member')
    expect(view.canLink).toBe(true)
    expect(view.summary).toMatch(/link it to your account/)
    expect(view.body).toMatch(/only it can transfer or remove the role: not the gateway, not the organization owner/)
    expect(view.body).toMatch(/cannot be withdrawn/)
    // Whoever does control it can still manage it here.
    expect(operatorView(state({ operator: OTHER, relation: 'unknown' }), OTHER).canManage).toBe(true)
  })

  it('self: no browser actions; points at the CLI', () => {
    const view = operatorView(state({ operator: BUYER, relation: 'self' }), BUYER)
    expect(view).toMatchObject({ canAuthorize: false, canManage: false })
    expect(view.body).toMatch(/antseed gateway workspace operator transfer/)
  })
})

describe('operatorGate (withdraw, claim)', () => {
  it('explains each blocked state and passes only the connected operator', () => {
    expect(operatorGate(undefined, MINE, 'withdraw').ok).toBe(false)
    expect(operatorGate(state({ canAuthorize: true }), MINE, 'withdraw').reason).toMatch(/none is set\. Authorize one of your wallets/)
    expect(operatorGate(state({}), MINE, 'claim rewards').reason).toMatch(/Ask the organization owner/)
    expect(operatorGate(state({ operator: BUYER, relation: 'self' }), BUYER, 'withdraw').reason).toMatch(/gateway-held wallet itself/)
    expect(operatorGate(state({ operator: MINE, relation: 'yours' }), null, 'withdraw').reason).toMatch(/^Connect the authorized wallet 0x0a0a/)
    expect(operatorGate(state({ operator: MINE, relation: 'yours' }), OTHER, 'claim rewards').reason).toMatch(/is not the authorized wallet/)
    expect(operatorGate(state({ operator: MINE, relation: 'yours' }), MINE, 'withdraw')).toEqual({ ok: true, reason: null, operator: MINE })
  })
})

describe('authorization rules in the browser', () => {
  const owner = state({ canAuthorize: true, eligibleWallets: [{ address: MINE, eligibleAt: NOW - HOUR }, { address: NEW_WALLET, eligibleAt: NOW + 5 * HOUR }] })

  it('the connected wallet must be one of the owner\'s sign-in wallets, 24 h old', () => {
    expect(authorizeBlocker(owner, MINE, NOW)).toBeNull()
    expect(authorizeBlocker(owner, NEW_WALLET, NOW)).toMatch(/can be authorized from/)
    expect(authorizeBlocker(owner, OTHER, NOW)).toMatch(/not one of your sign-in methods/)
    expect(authorizeBlocker(owner, null, NOW)).toMatch(/Connect the wallet/)
    expect(authorizeBlocker(state({}), MINE, NOW)).toMatch(/Only the organization owner/)
    expect(eligibleWallets(owner, NOW).map((wallet) => wallet.ready)).toEqual([true, false])
  })

  it('checkAuthorization: operator set meanwhile, nonce moved, wrong chain or contract', () => {
    const auth = { buyer: BUYER, nonce: '3', signature: '0xsig', operator: MINE, depositsContract: OTHER, chainId: 8453 }
    const expected = { depositsContract: OTHER, chainId: 8453, operator: MINE }
    expect(() => checkAuthorization(auth, { operator: null, nonce: 3n }, expected)).not.toThrow()
    const set = (() => { try { checkAuthorization(auth, { operator: OTHER, nonce: 4n }, expected) } catch (error) { return error } })()
    expect(set).toBeInstanceOf(OperatorPreflightError)
    expect(set).toMatchObject({ refresh: true, retryAuth: false })
    const moved = (() => { try { checkAuthorization(auth, { operator: null, nonce: 4n }, expected) } catch (error) { return error } })()
    expect(moved).toMatchObject({ refresh: true, retryAuth: true })
    expect(() => checkAuthorization(auth, { operator: null, nonce: 3n }, { ...expected, chainId: 84532 })).toThrow(/chain 8453/)
    expect(() => checkAuthorization(auth, { operator: null, nonce: 3n }, { ...expected, depositsContract: MINE })).toThrow(/different deposits contract/)
    expect(() => checkAuthorization(auth, { operator: null, nonce: 3n }, { ...expected, operator: OTHER })).toThrow(/is for/)
  })
})

describe('revert decoding', () => {
  const reverted = (errorName: 'OperatorAlreadySet' | 'InvalidNonce' | 'NotAuthorized') => new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi: DEPOSITS_OPERATOR_ABI, data: encodeErrorResult({ abi: DEPOSITS_OPERATOR_ABI, errorName }), functionName: 'setOperator' }),
    { abi: DEPOSITS_OPERATOR_ABI, functionName: 'setOperator', args: [] },
  )

  it('names custom errors from a viem error chain and asks for a refresh', () => {
    expect(revertErrorName(reverted('OperatorAlreadySet'))).toBe('OperatorAlreadySet')
    expect(operatorTxError(reverted('OperatorAlreadySet'))).toMatchObject({ refresh: true, message: expect.stringMatching(/Another wallet was authorized/) })
    expect(operatorTxError(reverted('InvalidNonce'))?.message).toMatch(/nonce changed/)
    expect(operatorTxError(reverted('NotAuthorized'))?.message).toMatch(/not \(or no longer\) the authorized wallet/)
    expect(revertErrorName(new BaseError('reverted with NotRewardRecipient()'))).toBe('NotRewardRecipient')
    expect(operatorTxError(new Error('User rejected the request.'))).toBeNull()
  })
})

describe('mock operator states', () => {
  const db = seed()
  const owner = db.members.find((member) => member.id === 'mem_owner')!
  const sam = db.members.find((member) => member.id === 'mem_sam')!
  const workspace = db.workspaces[0]!

  it('every scenario yields its relation for the owner', () => {
    for (const scenario of OPERATOR_SCENARIOS) {
      const operator = scenarioOperator(scenario, workspace, owner, db.members)
      const result = mockOperatorState({ operator, workspace, viewer: owner, members: db.members, checkedAt: NOW })
      expect(result.relation).toBe(scenario)
      expect(result.canAuthorize).toBe(scenario === 'none')
      expect(result.eligibleWallets.length).toBe(2)
    }
    expect(scenarioOperator('unknown', workspace, owner, db.members)).toBe(UNKNOWN_OPERATOR)
  })

  it('plain members see read-only state without whose wallet it is', () => {
    const operator = scenarioOperator('member', workspace, owner, db.members)
    const result = mockOperatorState({ operator, workspace, viewer: sam, members: db.members, checkedAt: NOW })
    expect(result).toMatchObject({ relation: 'member', memberLabel: null, canAuthorize: false, eligibleWallets: [] })
  })

  it('relationFor mirrors the gateway', () => {
    const wallets = [{ memberId: 'm1', label: 'One', address: MINE }]
    expect(relationFor(null, BUYER, 'm1', wallets).relation).toBe('none')
    expect(relationFor(BUYER, BUYER, 'm1', wallets).relation).toBe('self')
    expect(relationFor(MINE, BUYER, 'm1', wallets).relation).toBe('yours')
    expect(relationFor(MINE, BUYER, 'm2', wallets)).toEqual({ relation: 'member', memberLabel: 'One' })
    expect(relationFor(OTHER, BUYER, 'm1', wallets).relation).toBe('unknown')
  })
})
