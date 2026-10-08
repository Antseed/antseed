import { useState } from 'react'
import { Button, DataTable, Modal, TextField } from '@antseed/ui'
import { api } from '../api'
import type { Peer, PeerList } from '../api/types'
import { useConsoleMutation } from '../lib/mutations'
import { isOrgAdmin } from '../lib/nav'
import { qk, usePeerLists } from '../lib/queries'
import { useConsole } from '../app/context'
import { Icon } from './icons'
import { PeerPicker } from './PeerPicker'
import { ConfirmDialog, EmptyState, ErrorAlert, Panel, QueryView } from './ui'

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
    <form className="gc-stack" onSubmit={(event) => { event.preventDefault(); save.mutate() }}>
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

/** Named sets of sellers, used by policy editors (allow/block) and the "Own peers only" template. */
export function PeerListsPanel({ peers }: { peers?: readonly Peer[] }) {
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
    <Panel flush title="Peer lists" description="Named groups of sellers to allow or block in one step."
      actions={canEdit && <Button size="sm" variant="outline" leadingIcon={<Icon.plus size={14} />} onClick={() => setEditing('new')}>New list</Button>}>
      <QueryView query={lists}>
        {(rows) => (
          <DataTable<PeerList> label="Peer lists" rows={rows} rowKey={(list) => list.id} rowLabel={(list) => list.name}
            actions={(list) => canEdit ? [
              { label: 'Edit', onSelect: () => setEditing(list) },
              { label: 'Delete', tone: 'danger' as const, onSelect: () => setDeleting(list) },
            ] : []}
            empty={<EmptyState icon={<Icon.network size={18} />} title="No peer lists" body="Group sellers you trust, or ones you run yourself." />}
            columns={[
              { key: 'name', header: 'Name', render: (list) => <span className="gc-strong">{list.name}</span> },
              { key: 'desc', header: 'Description', secondary: true, render: (list) => <span className="gc-muted">{list.description ?? '—'}</span> },
              { key: 'count', header: 'Sellers', align: 'right', render: (list) => list.peerIds.length },
            ]} />
        )}
      </QueryView>
      <Modal isOpen={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'New peer list' : 'Edit peer list'} size="lg">
        {editing !== null && <PeerListForm initial={editing === 'new' ? null : editing} peers={peers} onDone={() => setEditing(null)} />}
      </Modal>
      <ConfirmDialog isOpen={deleting !== null} busy={remove.isPending} error={remove.error} onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting)} title="Delete this list?" confirmLabel="Delete"
        body="Policies refer to lists by reference: once deleted, the list adds no sellers to them. An allow list made only of deleted lists lets no seller serve." />
    </Panel>
  )
}
