import { lazy, Suspense, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, LoadingRows, Modal, TextField, useToast } from '@antseed/ui'
import { api } from '../api'
import type { Builders as BuildersView } from '../api/types'
import { ChainGate } from '../components/ChainGate'
import { Badge, DetailList, ErrorAlert, Mono, PageHeader, Panel, QueryView, StatTile } from '../components/ui'
import { antsIsPositive, formatAnts } from '../lib/ants'
import { shortId } from '../lib/format'
import { useConsoleMutation } from '../lib/mutations'
import { qk, useChain } from '../lib/queries'

const ReferralClaim = lazy(() => import('../wallet/ReferralClaim'))

const SOURCE_LABELS: Record<BuildersView['effective']['source'], string> = {
  env: 'ANTSEED_CLIENT_AGENT_ID on the gateway host',
  config: 'Set for this gateway',
  default: 'Antseed CLI default',
  none: 'Not set',
}

export default function Builders() {
  const queryClient = useQueryClient()
  const toast = useToast()
  const builders = useQuery({ queryKey: qk.builders, queryFn: () => api.referrals.builders() })
  const chain = useChain()
  const [editing, setEditing] = useState(false)
  const [claiming, setClaiming] = useState(false)

  return (
    <div className="gc-page">
      <PageHeader title="Builders program"
        description="Credit this gateway's usage to your ERC-8004 client agent. Each epoch, the builders bucket is split by the usage each client brought in, and paid to the agent's owner." />
      <QueryView query={builders} rows={3}>
        {(data) => {
          const agent = data.agent
          return (
            <>
              {data.restartRequired && <Alert tone="warning">Saved. The buyer could not restart itself: restart it to start signing the new client agent.</Alert>}
              <div className="gc-grid gc-grid--3">
                <StatTile label="Client agent" value={data.effective.agentId !== null ? `#${data.effective.agentId}` : 'None'} sub={SOURCE_LABELS[data.effective.source]} />
                <StatTile label="Paid to" value={agent?.owner ? <Mono title={agent.owner}>{shortId(agent.owner)}</Mono> : '—'}
                  sub={agent && !agent.owner ? 'Not registered' : 'The agent owner'} />
                <StatTile label="Ready to claim" value={data.available && agent ? formatAnts(agent.payableAnts) : '—'} />
              </div>

              <Panel title="Client agent" description="Every request through this gateway signs this agent id into its settlement metadata."
                actions={<Button size="sm" variant="outline" onClick={() => setEditing(true)}>{data.agentId !== null ? 'Change' : 'Set agent'}</Button>}>
                <DetailList items={[
                  ['Agent', data.effective.agentId !== null ? <>#{data.effective.agentId} {agent?.firstParty ? <Badge>Antseed {agent.firstParty === 'cli' ? 'CLI' : 'Desktop'}</Badge> : null}</> : 'None'],
                  ['Source', SOURCE_LABELS[data.effective.source]],
                  ['Owner', agent?.owner ? <Mono title={agent.owner}>{agent.owner}</Mono> : '—'],
                ]} />
                {data.effective.source === 'default' && (
                  <p className="gc-fineprint">This gateway's usage currently credits Antseed's own CLI agent. Set your agent to earn the builders share yourself.</p>
                )}
                {data.effective.source === 'env' && data.agentId !== null && data.agentId !== data.effective.agentId && (
                  <p className="gc-fineprint">ANTSEED_CLIENT_AGENT_ID overrides the agent set here (#{data.agentId}).</p>
                )}
              </Panel>

              {data.available && agent ? (
                <Panel>
                  <div className="gc-summary-row">
                    <div className="gc-summary-row__text">
                      <span className="gc-strong">{antsIsPositive(agent.payableAnts) ? `${formatAnts(agent.payableAnts)} ready to claim` : 'Nothing to claim yet'}</span>
                      <span className="gc-fineprint">
                        {agent.owner ? <>Anyone can send the claim; the ANTS go to the agent owner {shortId(agent.owner)}.</> : 'The agent is not registered, so nothing can be paid.'}
                        {agent.firstParty ? ' This is an Antseed agent, so its rewards are Antseed\'s.' : ''}
                      </span>
                    </div>
                    <Button size="sm" variant="outline" disabled={!agent.owner || agent.claimableEpochs.length === 0} onClick={() => setClaiming(true)}>Claim</Button>
                  </div>
                </Panel>
              ) : (
                <Alert tone="info">Builders program data is not available on this network (no rewards contract, or no explorer to read it from).</Alert>
              )}

              {/* Mounted only while open, so each open starts from the saved agent with no stale draft or error. */}
              {editing && <AgentDialog current={data.agentId} onClose={() => setEditing(false)} />}

              <Modal isOpen={claiming} onClose={() => setClaiming(false)} title="Claim builders rewards"
                subtitle={agent ? `${formatAnts(agent.payableAnts)} for agent #${agent.agentId}.` : undefined}>
                {agent && (
                  <ChainGate chain={chain.data} error={chain.error}>
                    {(info) => (
                      <Suspense fallback={<LoadingRows rows={2} />}>
                        <ReferralClaim target={{ kind: 'builder', agentId: agent.agentId, epochs: agent.claimableEpochs }} chain={info} recipient={agent.owner}
                          onClaimed={(complete) => {
                            if (complete) {
                              toast('Rewards claimed')
                              setClaiming(false)
                            }
                            // Part way too: the epochs that confirmed drop out of the view.
                            void api.referrals.builders(true).then((fresh) => queryClient.setQueryData(qk.builders, fresh), () => undefined)
                          }} />
                      </Suspense>
                    )}
                  </ChainGate>
                )}
              </Modal>
            </>
          )
        }}
      </QueryView>
    </div>
  )
}

function AgentDialog({ current, onClose }: { current: number | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [value, setValue] = useState(current !== null ? String(current) : '')
  const trimmed = value.trim()
  const valid = trimmed === '' || /^[1-9]\d*$/.test(trimmed)
  const save = useConsoleMutation({
    mutationFn: (agentId: number | null) => api.referrals.setBuilderAgent(agentId),
    onSuccess: (view) => { queryClient.setQueryData(qk.builders, view); onClose() },
    toast: (view) => view.restartRequired ? null : 'Client agent saved; the buyer is restarting',
  })
  return (
    <Modal isOpen onClose={onClose} title="Client agent"
      subtitle="Your app's ERC-8004 agent id. Changing it restarts the buyer, which briefly interrupts requests.">
      <form className="gc-stack" onSubmit={(event) => { event.preventDefault(); save.mutate(trimmed === '' ? null : Number(trimmed)) }}>
        <TextField label="Agent id" inputMode="numeric" value={value} onChange={(event) => setValue(event.target.value)}
          error={valid ? undefined : 'A positive whole number'} hint="Leave empty to use the Antseed CLI default." />
        {save.error ? <ErrorAlert error={save.error} title="Could not save the agent" /> : null}
        <div className="gc-actions">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={save.isPending || !valid}>{save.isPending ? 'Saving…' : 'Save and restart buyer'}</Button>
        </div>
      </form>
    </Modal>
  )
}
