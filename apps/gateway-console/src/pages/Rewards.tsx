import { lazy, Suspense, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, DataTable, LoadingRows, Modal, useToast } from '@antseed/ui'
import { api } from '../api'
import { useConsole } from '../app/context'
import { ChainGate } from '../components/ChainGate'
import { Icon } from '../components/icons'
import { Badge, EmptyState, Mono, PageHeader, PageLink, Panel, QueryView, StaleHint, StatTile } from '../components/ui'
import { antsIsPositive, formatAnts } from '../lib/ants'
import { isSetAddress } from '../lib/chain'
import { shortId } from '../lib/format'
import { useOperator } from '../lib/operator'
import { qk, useChain } from '../lib/queries'

const RewardsClaim = lazy(() => import('../wallet/RewardsClaim'))

export default function Rewards() {
  const { workspace } = useConsole()
  const queryClient = useQueryClient()
  const toast = useToast()
  const rewards = useQuery({ queryKey: qk.rewards(workspace.id), queryFn: () => api.wallet.rewards(workspace.id) })
  const chain = useChain()
  // The gateway's cached operator read (shared with the wallet page), which a
  // sync after a transaction updates at once; the rewards' copy can lag.
  const operator = useOperator(workspace.id)
  const [claiming, setClaiming] = useState(false)

  return (
    <div className="gc-page">
      <PageHeader title="Rewards" description="ANTS earned by this workspace's usage. Claimed ANTS go to the authorized wallet." />
      <QueryView query={rewards} rows={3}>
        {(loaded) => {
          const authorized = operator.data ? operator.data.operator : loaded.operator
          const data = { ...loaded, operator: authorized }
          return (
          <>
            <StaleHint stale={loaded.stale} />
            <div className="gc-grid gc-grid--3">
              <StatTile label="Ready to claim" value={formatAnts(data.pendingAnts)} />
              <StatTile label="From the legacy program" value={formatAnts(data.legacy?.pendingAnts ?? '0')}
                sub={data.legacy ? 'Claimed together with the rest' : undefined} />
              <StatTile label="Authorized wallet" value={isSetAddress(data.operator) ? <Mono title={data.operator}>{shortId(data.operator)}</Mono> : 'Not set'} />
            </div>
            <Panel>
              <div className="gc-summary-row">
                <div className="gc-summary-row__text">
                  <span className="gc-strong">{antsIsPositive(data.pendingAnts) ? `${formatAnts(data.pendingAnts)} ready to claim` : 'Nothing to claim yet'}</span>
                  <span className="gc-fineprint">
                    {isSetAddress(data.operator)
                      ? <>Claimed ANTS go to the authorized wallet {shortId(data.operator)}, which signs the claim.</>
                      : <>Only the authorized wallet can claim, and none is set. Authorize one on <PageLink to="wallet">Wallet &amp; Funding</PageLink>.</>}
                  </span>
                </div>
                <Button size="sm" variant="outline" disabled={!isSetAddress(data.operator)} onClick={() => setClaiming(true)}>Claim rewards</Button>
              </div>
            </Panel>
            <Modal isOpen={claiming} onClose={() => setClaiming(false)} title="Claim rewards"
              subtitle={`${formatAnts(data.pendingAnts)} ready. Sent to the authorized wallet${isSetAddress(data.operator) ? ` ${shortId(data.operator)}` : ''}.`}>
              <ChainGate chain={chain.data} error={chain.error}>
                {(info) => (
                  <Suspense fallback={<LoadingRows rows={2} />}>
                    <RewardsClaim rewards={data} chain={info} onDone={() => {
                      toast('Rewards claimed')
                      setClaiming(false)
                      void queryClient.invalidateQueries({ queryKey: qk.rewards(workspace.id) })
                    }} />
                  </Suspense>
                )}
              </ChainGate>
            </Modal>
            <Panel flush title="Current program by epoch" description="Rewards accrue at each epoch boundary from this workspace's paid usage.">
              <DataTable label="Reward epochs" rows={[...data.epochs].sort((a, b) => b.epoch - a.epoch)} rowKey={(row) => String(row.epoch)}
                empty={<EmptyState icon={<Icon.rewards size={18} />} title="No rewards yet" body="Rewards accrue per epoch as this workspace's keys are used." />}
                columns={[
                  { key: 'epoch', header: 'Epoch', render: (row) => row.epoch },
                  { key: 'amount', header: 'Amount', align: 'right', render: (row) => formatAnts(row.pendingAnts) },
                  { key: 'state', header: 'Status', render: (row) => row.claimed ? <Badge tone="success">Claimed</Badge> : <Badge tone="warning">Unclaimed</Badge> },
                ]} />
            </Panel>
          </>
          )
        }}
      </QueryView>
    </div>
  )
}
