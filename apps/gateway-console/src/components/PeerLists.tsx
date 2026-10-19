import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, DataTable, Modal, TextField } from '@antseed/ui'
import { api } from '../api'
import type { Peer, PeerList } from '../api/types'
import { submitOnly } from '../lib/forms'
import { useConsoleMutation } from '../lib/mutations'
import { isOrgAdmin } from '../lib/nav'
import { qk, usePeerLists } from '../lib/queries'
import { useConsole } from '../app/context'
import { Icon } from './icons'
import { PeerPicker, peerName } from './PeerPicker'
import { ConfirmDialog, EmptyState, ErrorAlert, Mono, Panel, QueryView } from './ui'
import { shortId } from '../lib/format'

function PeerListForm({ initial, peers, onDone }: { initial: PeerList | null; peers?: readonly Peer[]; onDone: () => void }) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [peerIds, setPeerIds] = useState<string[]>(initial?.peerIds ?? [])
  const save = useConsoleMutation({
    mutationFn: () => {
      const input = { name: name.trim(), description: description.trim() || null, peerIds }
      return initial ? api.network.updatePeerList(initial.id, input) : api.network.createPeerList(input)
    },
    onSuccess: onDone,
    invalidate: [qk.peerLists],
  })
  return (
    <form className="gc-stack" onSubmit={submitOnly(() => save.mutate())}>
      <TextField label="Name" required placeholder="e.g. Our own sellers" value={name} onChange={(event) => setName(event.target.value)} />
      <TextField label="Description" value={description} onChange={(event) => setDescription(event.target.value)} />
      <PeerPicker label="Sellers" value={peerIds} onChange={setPeerIds} peers={peers} />
      <p className="gc-fineprint">Policies refer to a list by name, so editing it changes every policy that uses it.</p>
      {save.error ? <ErrorAlert error={save.error} title="Could not save the list" /> : null}
      <div className="gc-actions">
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
        <Button type="submit" disabled={save.isPending || !name.trim()}>{save.isPending ? 'Saving…' : 'Save list'}</Button>
      </div>
    </form>
  )
}

const LISTS_HELP = 'Named groups of sellers that routing rules allow or block in one step. Editing a list changes every rule that uses it.'

function sellerNames(list: PeerList, peers: readonly Peer[] | undefined): string {
  const names = list.peerIds.map((peerId) => peerName(peers, peerId))
  return names.length <= 4 ? names.join(', ') : `${names.slice(0, 4).join(', ')} and ${names.length - 4} more`
}

/**
 * Named sets of sellers ("peer lists" in the CLI and API), which routing
 * policies allow or block in one step. Organization admins edit them.
 */
export function PeerListsPanel({ peers, inDialog = false }: { peers?: readonly Peer[]; inDialog?: boolean }) {
  const { viewer } = useConsole()
  // The API lets only organization admins create, edit or delete lists.
  const canEdit = isOrgAdmin(viewer)
  const lists = usePeerLists()
  const [editing, setEditing] = useState<PeerList | 'new' | null>(null)
  const [deleting, setDeleting] = useState<PeerList | null>(null)
  const remove = useConsoleMutation({
    mutationFn: (list: PeerList) => api.network.removePeerList(list.id),
    onSuccess: () => setDeleting(null),
    invalidate: [qk.peerLists],
  })
  return (
    <Panel flush={!inDialog} title={inDialog ? undefined : 'Seller lists'} description={inDialog ? undefined : `${LISTS_HELP}${canEdit ? '' : ' Organization admins edit them.'}`}
      actions={canEdit && <Button size="sm" variant="outline" leadingIcon={<Icon.plus size={14} />} onClick={() => setEditing('new')}>New list</Button>}>
      <QueryView query={lists}>
        {(rows) => (
          <DataTable<PeerList> label="Seller lists" rows={rows} rowKey={(list) => list.id} rowLabel={(list) => list.name}
            actions={(list) => canEdit ? [
              { label: 'Edit', onSelect: () => setEditing(list) },
              { label: 'Delete', tone: 'danger' as const, onSelect: () => setDeleting(list) },
            ] : []}
            empty={<EmptyState icon={<Icon.network size={18} />} title="No seller lists" body="Group sellers you trust, or ones you run yourself, then allow or block the whole group in a routing rule." />}
            columns={[
              { key: 'name', header: 'Name', render: (list) => <span className="gc-strong">{list.name}</span> },
              { key: 'sellers', header: 'Sellers', render: (list) => <span className="gc-muted">{list.peerIds.length ? sellerNames(list, peers) : 'Empty'}</span> },
              { key: 'count', header: 'Count', align: 'right', secondary: true, render: (list) => list.peerIds.length },
              { key: 'desc', header: 'Description', secondary: true, optional: true, render: (list) => <span className="gc-muted">{list.description ?? '—'}</span> },
            ]} />
        )}
      </QueryView>
      <Modal isOpen={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'New seller list' : 'Edit seller list'} size="lg">
        {editing !== null && <PeerListForm initial={editing === 'new' ? null : editing} peers={peers} onDone={() => setEditing(null)} />}
      </Modal>
      <ConfirmDialog isOpen={deleting !== null} busy={remove.isPending} error={remove.error} onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting)} title="Delete this list?" confirmLabel="Delete"
        body="Policies refer to lists by reference: once deleted, the list adds no sellers to them. An allow list made only of deleted lists lets no seller serve." />
    </Panel>
  )
}

/** "Manage seller lists": the lists in a dialog, over whatever opened it (a policy editor). */
export function SellerListsButton({ peers }: { peers?: readonly Peer[] }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="link" size="sm" onClick={() => setOpen(true)}>Manage seller lists</Button>
      {/* Outside any enclosing form (a key's policy editor): no nested forms. */}
      {createPortal(
        <Modal isOpen={open} onClose={() => setOpen(false)} title="Seller lists" subtitle={LISTS_HELP} size="lg">
          <PeerListsPanel peers={peers} inDialog />
        </Modal>,
        document.body,
      )}
    </>
  )
}

/**
 * A seller list's name as a link that opens the list: its editor for
 * organization admins, its sellers for everyone else.
 */
export function SellerListLink({ list, peers }: { list: PeerList; peers?: readonly Peer[] }) {
  const { viewer } = useConsole()
  const canEdit = isOrgAdmin(viewer)
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="gc-link-button" title={canEdit ? `Edit the “${list.name}” list` : `See the “${list.name}” list`} onClick={() => setOpen(true)}>
        {list.name}
      </button>
      {/* Outside any enclosing form (a key's policy editor): no nested forms. */}
      {createPortal(
        <Modal isOpen={open} onClose={() => setOpen(false)} title={canEdit ? 'Edit seller list' : list.name} size="lg"
          subtitle={canEdit ? undefined : `${list.peerIds.length} seller${list.peerIds.length === 1 ? '' : 's'}. Organization admins edit seller lists.`}>
          {canEdit
            ? <PeerListForm initial={list} peers={peers} onDone={() => setOpen(false)} />
            : list.peerIds.length
              ? <ul className="gc-plain-list">{list.peerIds.map((peerId) => <li key={peerId}>{peerName(peers, peerId)} <Mono>{shortId(peerId, 6, 4)}</Mono></li>)}</ul>
              : <p className="gc-muted">No sellers yet.</p>}
        </Modal>,
        document.body,
      )}
    </>
  )
}
