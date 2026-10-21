import type { BuilderAgent, Builders, CreatedInvite, Referee, ReferralClaimables, Referrals } from '../api/types'
import { fakeAddress } from './data'

/** In-memory referral state per workspace for the mock API. */
interface MockReferralState {
  issued: number
  referee: Referee
}

const QUOTA = 5
const EPOCH = 15
const states = new Map<string, MockReferralState>()

function state(workspaceId: string): MockReferralState {
  let found = states.get(workspaceId)
  if (!found) {
    // The default workspace is already bound (bonus window running); others start with no invite.
    const bound = workspaceId === 'ws_default'
    found = {
      issued: 1,
      referee: bound
        ? { state: 'bound', referrer: fakeAddress(201), pendingInvite: null, inviteExpiresEpoch: null, boundEpoch: 10, windowEnd: 22, weeksLeft: 8, payableAnts: '6.4', claimableEpochs: [12, 13], canRedeem: false, indexed: true }
        : { state: 'none', referrer: null, pendingInvite: null, inviteExpiresEpoch: null, boundEpoch: null, windowEnd: null, weeksLeft: null, payableAnts: '0', claimableEpochs: [], canRedeem: true, indexed: true },
    }
    states.set(workspaceId, found)
  }
  return found
}

/** `indexed: false` plays a gateway without an explorer: counts and rewards unknown, the bonus window too. */
export function mockReferrals(workspaceId: string, address: string, indexed = true): Referrals {
  const current = state(workspaceId)
  const view: Referrals = {
    available: true,
    invitesAvailable: true,
    address,
    invites: { epoch: EPOCH, quota: QUOTA, used: current.issued, left: Math.max(0, QUOTA - current.issued) },
    referredCount: 2,
    payableAnts: '12.5',
    claimableEpochs: [12, 13],
    buyers: [
      { buyer: fakeAddress(301), boundEpoch: 9, points: '184000', ants: '9.75', pendingPoints: '21000' },
      { buyer: fakeAddress(302), boundEpoch: 13, points: '52000', ants: '2.75', pendingPoints: '0' },
    ],
    referee: current.referee,
  }
  if (indexed) return view
  return {
    ...view, available: false, referredCount: 0, payableAnts: '0', claimableEpochs: [], buyers: [],
    referee: { ...current.referee, boundEpoch: null, windowEnd: null, weeksLeft: null, payableAnts: '0', claimableEpochs: [], indexed: false },
  }
}

/** What the on-chain discovery finds for the workspace wallet: the same rewards the explorer would list. */
export function mockReferralClaimables(workspaceId: string): ReferralClaimables {
  const { referee } = state(workspaceId)
  return {
    referrer: { payableAnts: '12.5', claimableEpochs: [12, 13] },
    referee: referee.state === 'bound' ? { payableAnts: '6.4', claimableEpochs: [12, 13] } : { payableAnts: '0', claimableEpochs: [] },
  }
}

export function mockCreateInvite(workspaceId: string): CreatedInvite | null {
  const current = state(workspaceId)
  if (current.issued >= QUOTA) return null
  const index = current.issued
  current.issued += 1
  const invite = `AQAP${String(index).padStart(2, '0')}mockInviteSignature${'x'.repeat(64)}`
  return { invite, link: `https://antseed.com/invite/${invite}`, epoch: EPOCH, index, quota: QUOTA, left: QUOTA - current.issued, expiresEpoch: EPOCH + 4 }
}

/** Accepts anything that looks like an invite; "used" in it reproduces the contract's refusal. */
export function mockRedeem(workspaceId: string, value: string): string | null {
  const current = state(workspaceId)
  if (current.referee.state === 'bound') return 'This wallet is already bound to a referrer.'
  if (value.includes('used')) return 'This invite was already used.'
  if (value.length < 20) return 'Not a valid invite.'
  current.referee = { ...current.referee, state: 'invited', referrer: fakeAddress(202), pendingInvite: value, inviteExpiresEpoch: EPOCH + 3 }
  return null
}

export function mockClearInvite(workspaceId: string): void {
  const current = state(workspaceId)
  if (current.referee.state === 'invited') {
    current.referee = { ...current.referee, state: 'none', referrer: null, pendingInvite: null, inviteExpiresEpoch: null }
  }
}

let builderAgentId: number | null = null
const CLI_AGENT = 1

function builderAgent(): BuilderAgent {
  const agentId = builderAgentId ?? CLI_AGENT
  const firstParty = agentId === CLI_AGENT ? 'cli' as const : null
  return {
    agentId,
    owner: firstParty ? fakeAddress(401) : fakeAddress(8),
    firstParty,
    payableAnts: firstParty ? '310.2' : '18.6',
    claimableEpochs: [12, 13, 14],
  }
}

/** `indexed: false` plays a gateway without an explorer: the agent's rewards are unknown. */
export function mockBuilders(indexed = true): Builders {
  const effective: Builders['effective'] = builderAgentId !== null
    ? { agentId: builderAgentId, source: 'config', client: 'cli', runtime: true }
    : { agentId: CLI_AGENT, source: 'default', client: 'cli', runtime: true }
  const agent = builderAgent()
  return {
    available: true,
    indexed,
    agentId: builderAgentId,
    effective,
    agent: indexed ? agent : { ...agent, payableAnts: '0', claimableEpochs: [] },
  }
}

/** What the on-chain discovery finds for the effective agent. */
export function mockBuilderClaimable(): BuilderAgent {
  return builderAgent()
}

export function mockSetBuilderAgent(agentId: number | null): void {
  builderAgentId = agentId
}
