/**
 * What needs the viewer's attention about money, for markers outside the
 * Wallet page: workspaces without an authorized wallet (nobody can withdraw
 * or claim rewards) and channels whose reserve is ready to withdraw.
 * Workspace admins and org admins only: plain members cannot act on either.
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '../api'
import { useConsole } from '../app/context'
import { withdrawableSummary } from './channels'
import { isWorkspaceAdmin } from './nav'
import { lacksOperator, useWorkspaceOperators } from './operator'
import { qk } from './queries'

/** The open channels of a workspace (shared by the balance figures, the banners and the table). */
export function useOpenChannels(workspaceId: string, enabled = true) {
  return useQuery({ queryKey: qk.channels(workspaceId, false), queryFn: () => api.wallet.channels(workspaceId, false), enabled })
}

export interface WalletAttention {
  /** Workspace ids (of those the viewer can open) with no authorized wallet. */
  missingOperator: ReadonlySet<string>
  /** The open workspace has no authorized wallet. */
  currentMissingOperator: boolean
  /** The viewer may authorize one (org owner). */
  canAuthorize: boolean
  /** The open workspace's channels ready to withdraw. */
  withdrawable: { count: number; amount: number }
  /** Any of the above for the open workspace: the Wallet nav item gets a dot. */
  wallet: boolean
}

export function useWalletAttention(): WalletAttention {
  const { workspace, viewer } = useConsole()
  const admin = isWorkspaceAdmin(viewer)
  const operators = useWorkspaceOperators(admin)
  const channels = useOpenChannels(workspace.id, admin)
  const rows = operators.data ?? []
  const missingOperator = new Set(rows.filter(lacksOperator).map((row) => row.workspaceId))
  const current = rows.find((row) => row.workspaceId === workspace.id)
  const withdrawable = withdrawableSummary(channels.data ?? [])
  const currentMissingOperator = missingOperator.has(workspace.id)
  return {
    missingOperator,
    currentMissingOperator,
    canAuthorize: current?.canAuthorize ?? false,
    withdrawable,
    wallet: currentMissingOperator || withdrawable.count > 0,
  }
}
