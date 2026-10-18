// A run's own Herdr workspace. The factory creates it, records its id in the run state, and only ever acts on
// panes and tabs inside it; other workspaces are listed (to refuse a label clash) but never changed.
import { herdr } from './common.mjs'

export const workspaceExists = (id) => Boolean(id && herdr(['workspace', 'get', id])?.workspace)

// ensureWorkspace(label, cwd, ownedId): reuse ownedId if it still exists; refuse a label someone else's workspace
// has; else create it. Returns { id, tab, rootPane, created }.
export function ensureWorkspace(label, cwd, ownedId) {
  if (workspaceExists(ownedId)) return { id: ownedId, created: false }
  const clash = (herdr(['workspace', 'list'])?.workspaces ?? []).find((w) => w.label === label)
  if (clash) throw new Error(`a Herdr workspace labelled "${label}" already exists (${clash.workspace_id}) and is not this run's; pass --workspace <another name>`)
  const r = herdr(['workspace', 'create', '--label', label, '--cwd', cwd, '--no-focus'])
  if (!r?.workspace?.workspace_id || !r?.root_pane?.pane_id) throw new Error(`could not create workspace "${label}"`)
  return { id: r.workspace.workspace_id, tab: r.tab?.tab_id ?? r.root_pane.tab_id, rootPane: r.root_pane.pane_id, created: true }
}
