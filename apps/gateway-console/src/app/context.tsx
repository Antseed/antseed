import { createContext, useContext } from 'react'
import type { Me, WorkspaceSummary, WorkspaceRole } from '../api/types'
import { isWorkspaceAdmin, type Viewer } from '../lib/nav'

export interface ConsoleContextValue {
  me: Me
  workspace: WorkspaceSummary
  workspaceRole: WorkspaceRole | null
  viewer: Viewer
  setWorkspaceId: (workspaceId: string) => void
}

export const ConsoleContext = createContext<ConsoleContextValue | null>(null)

export function useConsole(): ConsoleContextValue {
  const value = useContext(ConsoleContext)
  if (!value) throw new Error('useConsole outside the console shell')
  return value
}

const WORKSPACE_KEY = 'antseed-console-workspace'

export function rememberedWorkspace(): string | null {
  try { return localStorage.getItem(WORKSPACE_KEY) } catch { return null }
}

export function rememberWorkspace(workspaceId: string): void {
  try { localStorage.setItem(WORKSPACE_KEY, workspaceId) } catch { /* storage unavailable */ }
}

/** Picks the remembered workspace if still accessible, else the default, else the first. */
export function pickWorkspace(me: Me, remembered: string | null): WorkspaceSummary | null {
  const entries = me.workspaces.map((entry) => entry.workspace)
  return entries.find((ws) => ws.id === remembered) ?? entries.find((ws) => ws.isDefault) ?? entries[0] ?? null
}

/** Usage/log filter for the current scope: the open workspace, narrowed to the member unless they administer it. */
export function useScopeFilter(): { workspace: string; member?: string } {
  const { workspace, viewer, me } = useConsole()
  if (isWorkspaceAdmin(viewer)) return { workspace: workspace.id }
  return { workspace: workspace.id, member: me.member.id }
}
