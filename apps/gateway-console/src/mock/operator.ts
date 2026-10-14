/**
 * The mock's authorized-wallet states. Pick one for every workspace with
 * `?operator=none|self|yours|member|unknown` (remembered like `?as=`);
 * without it Default is authorized to Ali's wallet and Research has none.
 */
import type { Member, Workspace } from '../api/types'
import { relationFor, type OperatorRelation, type OperatorState } from '../lib/operator'

export const OPERATOR_SCENARIOS = ['none', 'self', 'yours', 'member', 'unknown'] as const
export type OperatorScenario = typeof OPERATOR_SCENARIOS[number]

/** An address no mock member signs in with. */
export const UNKNOWN_OPERATOR = `0x${'00'.repeat(18)}dead`
const OPERATOR_MIN_AGE_MS = 24 * 3600_000

function walletsOf(member: Member) {
  return member.credentials.filter((entry) => entry.kind === 'wallet').map((entry) => ({ address: entry.label, createdAt: entry.createdAt }))
}

/** The operator a scenario sets for `workspace`, seen by `viewer`. */
export function scenarioOperator(scenario: OperatorScenario, workspace: Workspace, viewer: Member, members: Member[]): string | null {
  switch (scenario) {
    case 'none': return null
    case 'self': return workspace.walletAddress
    case 'unknown': return UNKNOWN_OPERATOR
    case 'yours': return walletsOf(viewer)[0]?.address ?? scenarioOperator('member', workspace, viewer, members)
    case 'member': {
      const other = members.find((member) => member.id !== viewer.id && walletsOf(member).length > 0)
      return other ? walletsOf(other)[0]!.address : UNKNOWN_OPERATOR
    }
  }
}

export function mockOperatorState(input: { operator: string | null; workspace: Workspace; viewer: Member; members: Member[]; checkedAt: number }): OperatorState {
  const { viewer } = input
  const wallets = input.members.flatMap((member) => walletsOf(member).map((wallet) => ({ memberId: member.id, label: member.label, address: wallet.address })))
  const { relation, memberLabel } = relationFor(input.operator, input.workspace.walletAddress ?? '', viewer.id, wallets)
  const isOwner = viewer.orgRole === 'owner'
  return {
    buyer: input.workspace.walletAddress ?? '',
    operator: relation === 'none' ? null : input.operator,
    relation: relation as OperatorRelation,
    memberLabel: viewer.orgRole === 'member' ? null : memberLabel,
    canAuthorize: isOwner && relation === 'none',
    eligibleWallets: isOwner ? walletsOf(viewer).map((wallet) => ({ address: wallet.address, eligibleAt: wallet.createdAt + OPERATOR_MIN_AGE_MS })) : [],
    checkedAt: input.checkedAt,
  }
}
