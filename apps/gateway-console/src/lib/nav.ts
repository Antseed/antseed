import type { MeResponse, OrgRole, WorkspaceRole } from '../api/types'

export type PageId =
  | 'overview' | 'activity' | 'logs' | 'keys' | 'members' | 'workspaces' | 'wallet'
  | 'rewards' | 'network' | 'routing' | 'presets' | 'audit' | 'settings'

export interface Viewer {
  orgRole: OrgRole
  /** Role in the workspace currently open; org owners/admins act as admins everywhere. */
  workspaceRole: WorkspaceRole | null
}

export function isOrgAdmin(viewer: Viewer): boolean {
  return viewer.orgRole === 'owner' || viewer.orgRole === 'admin'
}

export function isWorkspaceAdmin(viewer: Viewer): boolean {
  return isOrgAdmin(viewer) || viewer.workspaceRole === 'admin'
}

type Access = 'member' | 'workspaceAdmin' | 'orgAdmin'

export const NAV_ITEMS: Array<{ id: PageId; label: string; group: string; access: Access }> = [
  { id: 'overview', label: 'Overview', group: 'Workspace', access: 'member' },
  { id: 'activity', label: 'Activity', group: 'Workspace', access: 'member' },
  { id: 'logs', label: 'Logs', group: 'Workspace', access: 'member' },
  { id: 'keys', label: 'Keys', group: 'Workspace', access: 'member' },
  { id: 'presets', label: 'Presets', group: 'Workspace', access: 'member' },
  { id: 'wallet', label: 'Wallet & Funding', group: 'Money', access: 'workspaceAdmin' },
  { id: 'rewards', label: 'Rewards', group: 'Money', access: 'workspaceAdmin' },
  { id: 'network', label: 'Network', group: 'Routing', access: 'member' },
  { id: 'routing', label: 'Routing', group: 'Routing', access: 'workspaceAdmin' },
  { id: 'members', label: 'Members', group: 'Organization', access: 'workspaceAdmin' },
  { id: 'workspaces', label: 'Workspaces', group: 'Organization', access: 'workspaceAdmin' },
  { id: 'audit', label: 'Audit log', group: 'Organization', access: 'orgAdmin' },
  { id: 'settings', label: 'Settings', group: 'Organization', access: 'orgAdmin' },
]

export function canOpen(page: PageId, viewer: Viewer): boolean {
  const item = NAV_ITEMS.find((entry) => entry.id === page)
  if (!item) return false
  if (item.access === 'orgAdmin') return isOrgAdmin(viewer)
  if (item.access === 'workspaceAdmin') return isWorkspaceAdmin(viewer)
  return true
}

export function visibleNav(viewer: Viewer) {
  return NAV_ITEMS.filter((item) => canOpen(item.id, viewer))
}

/** The viewer for a member session in a given workspace; null for key sessions. */
export function viewerFor(me: MeResponse, workspaceId: string | null): Viewer | null {
  if (me.kind !== 'member') return null
  const entry = me.me.workspaces.find((item) => item.workspace.id === workspaceId)
  return { orgRole: me.me.member.orgRole, workspaceRole: entry?.role ?? null }
}

export const ROLE_LABELS: Record<OrgRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }
