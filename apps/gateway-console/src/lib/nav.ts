import type { MeResponse, OrgRole, WorkspaceRole } from '../api/types'

export type PageId =
  | 'overview' | 'chat' | 'activity' | 'logs' | 'keys' | 'members' | 'workspaces' | 'wallet'
  | 'rewards' | 'staking' | 'providers' | 'models' | 'routing' | 'presets' | 'audit' | 'settings'
  | 'seller' | 'seller-logs' | 'seller-market' | 'seller-reputation' | 'seller-promote' | 'seller-settings'

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
  { id: 'chat', label: 'Chat', group: 'Workspace', access: 'member' },
  { id: 'activity', label: 'Activity', group: 'Workspace', access: 'member' },
  { id: 'logs', label: 'Logs', group: 'Workspace', access: 'member' },
  { id: 'keys', label: 'Keys', group: 'Workspace', access: 'member' },
  { id: 'presets', label: 'Presets', group: 'Workspace', access: 'member' },
  { id: 'wallet', label: 'Wallet & Funding', group: 'Money', access: 'workspaceAdmin' },
  { id: 'rewards', label: 'Rewards', group: 'Money', access: 'workspaceAdmin' },
  { id: 'staking', label: 'Staking', group: 'Money', access: 'workspaceAdmin' },
  { id: 'providers', label: 'Providers', group: 'Routing', access: 'member' },
  { id: 'models', label: 'Models', group: 'Routing', access: 'member' },
  { id: 'routing', label: 'Routing', group: 'Routing', access: 'workspaceAdmin' },
  { id: 'members', label: 'Members', group: 'Organization', access: 'workspaceAdmin' },
  { id: 'workspaces', label: 'Workspaces', group: 'Organization', access: 'workspaceAdmin' },
  { id: 'audit', label: 'Audit log', group: 'Organization', access: 'orgAdmin' },
  { id: 'settings', label: 'Settings', group: 'Organization', access: 'orgAdmin' },
  // Shown only when a seller runs on the gateway host (see `hasSeller` in visibleNav).
  { id: 'seller', label: 'Seller', group: 'Selling', access: 'orgAdmin' },
  { id: 'seller-logs', label: 'Seller logs', group: 'Selling', access: 'orgAdmin' },
  { id: 'seller-market', label: 'Market', group: 'Selling', access: 'orgAdmin' },
  { id: 'seller-reputation', label: 'Reputation', group: 'Selling', access: 'orgAdmin' },
  { id: 'seller-promote', label: 'Promote', group: 'Selling', access: 'orgAdmin' },
  { id: 'seller-settings', label: 'Seller settings', group: 'Selling', access: 'orgAdmin' },
]

export function canOpen(page: PageId, viewer: Viewer): boolean {
  const item = NAV_ITEMS.find((entry) => entry.id === page)
  if (!item) return false
  if (item.access === 'orgAdmin') return isOrgAdmin(viewer)
  if (item.access === 'workspaceAdmin') return isWorkspaceAdmin(viewer)
  return true
}

export const SELLER_PAGES = ['seller', 'seller-logs', 'seller-market', 'seller-reputation', 'seller-promote', 'seller-settings'] as const

export function isSellerPage(id: string): boolean {
  return (SELLER_PAGES as readonly string[]).includes(id)
}

/** The nav for a viewer; the Seller page only when the gateway host runs a seller. */
export function visibleNav(viewer: Viewer, options: { hasSeller?: boolean } = {}) {
  return NAV_ITEMS.filter((item) => canOpen(item.id, viewer) && (!isSellerPage(item.id) || options.hasSeller === true))
}

/** The viewer for a member session in a given workspace; null for key sessions. */
export function viewerFor(me: MeResponse, workspaceId: string | null): Viewer | null {
  if (me.kind !== 'member') return null
  const entry = me.me.workspaces.find((item) => item.workspace.id === workspaceId)
  return { orgRole: me.me.member.orgRole, workspaceRole: entry?.role ?? null }
}

export const ROLE_LABELS: Record<OrgRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }

/** Pages whose list opens an item in a side panel at `<page>/<id>`. */
export type PanelPage = 'providers' | 'models'

/** The path of a panel page with `id` open (URI-encoded, so ids with `/` stay one segment), or the bare list. */
export function panelPath(page: PanelPage, id: string | null): string {
  return id ? `${page}/${encodeURIComponent(id)}` : page
}

/** The id a panel page has open: the rest of the path, rejoined (old links may carry an unencoded `/`). */
export function panelSelection(rest: readonly string[]): string | null {
  const id = rest.join('/')
  return id === '' ? null : id
}

/** Where an old console path now lives: `network[/<peerId>]` became `providers[/<peerId>]`; null if not moved. */
export function movedPagePath(page: string, rest: readonly string[]): string | null {
  if (page === 'network') return panelPath('providers', panelSelection(rest))
  return null
}
