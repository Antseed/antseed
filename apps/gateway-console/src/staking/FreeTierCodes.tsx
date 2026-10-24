/**
 * Staked free tier for the workspace buyer: stakers create a code in the
 * staking dashboard (My positions → Share free tier) and a workspace admin
 * pastes it here. The running buyer picks it up within a minute, and sellers
 * with a staked free tier then count that stake toward this workspace.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, DataTable, Modal, TextAreaField } from '@antseed/ui'
import { api, errorMessage } from '../api'
import type { FreeTierStaker } from '../api/types'
import { Icon } from '../components/icons'
import { Badge, CopyButton, EmptyState, Mono, Panel, QueryView } from '../components/ui'
import { formatDate, shortId } from '../lib/format'
import { useConsoleMutation } from '../lib/mutations'
import { qk } from '../lib/queries'

function AddCodeModal({ isOpen, workspaceId, onClose }: { isOpen: boolean; workspaceId: string; onClose: () => void }) {
  const [code, setCode] = useState('')
  const add = useConsoleMutation({
    mutationFn: () => api.wallet.addFreeTierCode(workspaceId, code.trim()),
    invalidate: [qk.freeTier(workspaceId)],
    toast: 'Stake added',
    onSuccess: () => { setCode(''); onClose() },
  })
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm" title="Add a free-tier code"
      subtitle="Paste the code a staker created for this workspace's buyer address under My positions → Share free tier.">
      <div className="gc-stack">
        <TextAreaField label="Code" placeholder="antseed-free-tier-…" value={code} onChange={(event) => { setCode(event.target.value); add.reset() }} spellCheck={false} rows={4} />
        {add.error ? <p className="gc-warn">{errorMessage(add.error)}</p> : null}
        <div className="gc-actions">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => add.mutate()} disabled={add.isPending || !code.trim()}>Add code</Button>
        </div>
      </div>
    </Modal>
  )
}

/** The staked free-tier panel on Staking. */
export function FreeTierCodesPanel({ workspaceId }: { workspaceId: string }) {
  const sharing = useQuery({ queryKey: qk.freeTier(workspaceId), queryFn: () => api.wallet.freeTier(workspaceId) })
  const [adding, setAdding] = useState(false)
  const remove = useConsoleMutation({
    mutationFn: (staker: string) => api.wallet.removeFreeTierStaker(workspaceId, staker),
    invalidate: [qk.freeTier(workspaceId)],
    toast: 'Staker removed',
  })
  return (
    <Panel flush title="Staked free tier"
      description={<>On each seller with a staked free tier, stake in that seller's pool raises this workspace's free limit there, including stake shared with it.
        {sharing.data ? <> Stakers create a code for this workspace's buyer address <Mono title={sharing.data.buyer}>{shortId(sharing.data.buyer)}</Mono> <CopyButton iconOnly value={sharing.data.buyer} label="Copy buyer address" /></> : null}</>}
      actions={<Button size="sm" variant="outline" onClick={() => setAdding(true)}>Add code</Button>}>
      {remove.error ? <p className="gc-warn">Could not remove {shortId(remove.variables ?? '')}: {errorMessage(remove.error)} Try again.</p> : null}
      <QueryView query={sharing}>
        {(loaded) => (
          <DataTable<FreeTierStaker> label="Stakers" rows={loaded.stakers} rowKey={(row) => row.staker}
            actions={(row) => [{ label: 'Remove', disabled: remove.isPending, onSelect: () => remove.mutate(row.staker) }]}
            empty={<EmptyState icon={<Icon.rewards size={18} />} title="No shared stake yet" body="Ask a staker for a free-tier code for this workspace's buyer address, then add it here." />}
            columns={[
              { key: 'staker', header: 'Staker', render: (row) => <Mono title={row.staker}>{shortId(row.staker)}</Mono> },
              { key: 'until', header: 'Valid until', render: (row) => formatDate(row.expiresAt * 1000) },
              { key: 'state', header: 'Status', render: (row) => row.expired ? <Badge tone="warning">Expired</Badge> : <Badge tone="success">Active</Badge> },
            ]} />
        )}
      </QueryView>
      <AddCodeModal isOpen={adding} workspaceId={workspaceId} onClose={() => setAdding(false)} />
    </Panel>
  )
}
