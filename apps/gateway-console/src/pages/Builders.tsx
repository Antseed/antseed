import { lazy, Suspense, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, LoadingRows, Modal, TextField, useToast } from '@antseed/ui'
import { api } from '../api'
import type { BuilderAgent, Builders as BuildersView, ClaimableRewards } from '../api/types'
import { ChainGate } from '../components/ChainGate'
import { Badge, DetailList, ErrorAlert, Mono, PageHeader, Panel, QueryView, StatTile } from '../components/ui'
import { antsIsPositive, formatAnts } from '../lib/ants'
import { shortId } from '../lib/format'
import { useConsoleMutation } from '../lib/mutations'
import { qk, useChain } from '../lib/queries'

const ReferralClaim = lazy(() => import('../wallet/ReferralClaim'))

function sourceLabel(effective: BuildersView['effective']): string {
  const label = {
    env: 'ANTSEED_CLIENT_AGENT_ID on the buyer',
    config: 'Set for this gateway',
    default: `Antseed ${effective.client === 'desktop' ? 'Desktop' : 'CLI'} default`,
    none: 'Not set',
  }[effective.source]
  return effective.runtime ? label : `${label} (estimated)`
}

export default function Builders() {
  const queryClient = useQueryClient()
  const toast = useToast()
  const builders = useQuery({ queryKey: qk.builders, queryFn: () => api.referrals.builders() })
  const chain = useChain()
  const [editing, setEditing] = useState(false)
  const [claiming, setClaiming] = useState(false)
  // Without an explorer the agent's payable epochs are found on-chain on request.
  const [found, setFound] = useState<BuilderAgent | null>(null)
  const discover = useConsoleMutation({
    mutationFn: () => api.referrals.builderClaimable(),
    onSuccess: (result) => {
      setFound(result)
      if (result.owner && result.claimableEpochs.length > 0) setClaiming(true)
    },
  })

  return (
    <div className="gc-page">
      <PageHeader title="Builders program"
        description="Credit this gateway's usage to your ERC-8004 client agent. Each epoch, the builders bucket is split by the usage each client brought in, and paid to the agent's owner." />
      <QueryView query={builders} rows={3}>
        {(data) => {
          const agent = data.agent
          // The explorer's rewards when it indexes them, else what "Find rewards" found on-chain for this agent; null while unknown.
          const rewards: ClaimableRewards | null = !agent ? null
            : data.indexed ? { payableAnts: agent.payableAnts, claimableEpochs: agent.claimableEpochs }
            : found?.agentId === agent.agentId ? found : null
          return (
            <>
              {data.restartRequired && <Alert tone="warning">Saved. The buyer could not restart itself: restart it to start signing the new client agent.</Alert>}
              <div className="gc-grid gc-grid--3">
                <StatTile label="Client agent" value={data.effective.agentId !== null ? `#${data.effective.agentId}` : 'None'} sub={sourceLabel(data.effective)} />
                <StatTile label="Paid to" value={agent?.owner ? <Mono title={agent.owner}>{shortId(agent.owner)}</Mono> : '—'}
                  sub={agent && !agent.owner ? 'Not registered' : 'The agent owner'} />
                <StatTile label="Ready to claim" value={rewards ? formatAnts(rewards.payableAnts) : '—'} />
              </div>

              <Panel title="Client agent" description="Every request through this gateway signs this agent id into its settlement metadata."
                actions={<Button size="sm" variant="outline" onClick={() => setEditing(true)}>{data.agentId !== null ? 'Change' : 'Set agent'}</Button>}>
                <DetailList items={[
                  ['Agent', data.effective.agentId !== null ? <>#{data.effective.agentId} {agent?.firstParty ? <Badge>Antseed {agent.firstParty === 'cli' ? 'CLI' : 'Desktop'}</Badge> : null}</> : 'None'],
                  ['Source', sourceLabel(data.effective)],
                  ['Owner', agent?.owner ? <Mono title={agent.owner}>{agent.owner}</Mono> : '—'],
                ]} />
                {!data.effective.runtime && (
                  <p className="gc-fineprint">Estimated from this gateway's settings: the buyer did not report the agent it signs.</p>
                )}
                {data.effective.source === 'default' && (
                  <p className="gc-fineprint">This gateway's usage currently credits Antseed's own {data.effective.client === 'desktop' ? 'Desktop' : 'CLI'} agent. Set your agent to earn the builders share yourself.</p>
                )}
                {data.effective.source === 'env' && data.agentId !== data.effective.agentId && (
                  <p className="gc-fineprint">ANTSEED_CLIENT_AGENT_ID on the buyer overrides {data.agentId !== null ? <>the agent set here (#{data.agentId})</> : 'the default'}; remove it there and restart the buyer to use the saved agent.</p>
                )}
              </Panel>

              {!data.available ? (
                <Alert tone="info">The builders program is not available on this network (no rewards contract).</Alert>
              ) : agent ? (
                <Panel>
                  <div className="gc-summary-row">
                    <div className="gc-summary-row__text">
                      <span className="gc-strong">
                        {!rewards ? 'Rewards not checked yet' : antsIsPositive(rewards.payableAnts) ? `${formatAnts(rewards.payableAnts)} ready to claim` : 'Nothing to claim yet'}
                      </span>
                      <span className="gc-fineprint">
                        {agent.owner ? <>Anyone can send the claim; the ANTS go to the agent owner {shortId(agent.owner)}.</> : 'The agent is not registered, so nothing can be paid.'}
                        {agent.firstParty ? ' This is an Antseed agent, so its rewards are Antseed\'s.' : ''}
                      </span>
                    </div>
                    {/* An on-chain lookup that found nothing offers "Check again": weeks become payable later. */}
                    {rewards && (data.indexed || rewards.claimableEpochs.length > 0) ? (
                      <Button size="sm" variant="outline" disabled={!agent.owner || rewards.claimableEpochs.length === 0} onClick={() => setClaiming(true)}>Claim</Button>
                    ) : (
                      <Button size="sm" variant="outline" disabled={!agent.owner || discover.isPending} onClick={() => discover.mutate()}>
                        {discover.isPending ? 'Finding…' : rewards ? 'Check again' : 'Find rewards'}
                      </Button>
                    )}
                  </div>
                  {!data.indexed && <p className="gc-fineprint">No explorer indexes builders rewards here; Find rewards checks the chain.</p>}
                  {discover.error ? <ErrorAlert error={discover.error} title="Could not find rewards" /> : null}
                </Panel>
              ) : null}

              {/* Mounted only while open, so each open starts from the saved agent with no stale draft or error. */}
              {editing && <AgentDialog current={data.agentId} onClose={() => setEditing(false)} />}

              <Modal isOpen={claiming} onClose={() => setClaiming(false)} title="Claim builders rewards"
                subtitle={agent && rewards ? `${formatAnts(rewards.payableAnts)} for agent #${agent.agentId}.` : undefined}>
                {agent && rewards && (
                  <ChainGate chain={chain.data} error={chain.error}>
                    {(info) => (
                      <Suspense fallback={<LoadingRows rows={2} />}>
                        <ReferralClaim target={{ kind: 'builder', agentId: agent.agentId, epochs: rewards.claimableEpochs }} chain={info} recipient={agent.owner}
                          onClaimed={(complete) => {
                            if (complete) {
                              toast('Rewards claimed')
                              setClaiming(false)
                              // What was found on-chain is claimed now; Find rewards checks again.
                              setFound(null)
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
