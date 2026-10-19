import { lazy, Suspense, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, DataTable, LoadingRows, Modal, TextField, useToast } from '@antseed/ui'
import { api, isApiError } from '../api'
import type { CreatedInvite, Referee, Referrals as ReferralsView } from '../api/types'
import { useConsole } from '../app/context'
import { ChainGate } from '../components/ChainGate'
import { Icon } from '../components/icons'
import { Badge, CodeBlock, CopyButton, EmptyState, ErrorAlert, Mono, PageHeader, PageLink, Panel, QueryView, StatTile } from '../components/ui'
import { antsIsPositive, formatAnts } from '../lib/ants'
import { isSetAddress } from '../lib/chain'
import { shortId } from '../lib/format'
import { useConsoleMutation } from '../lib/mutations'
import { useOperator } from '../lib/operator'
import { qk, useChain } from '../lib/queries'
import type { ClaimTarget } from '../wallet/ReferralClaim'

const ReferralClaim = lazy(() => import('../wallet/ReferralClaim'))

const NO_QUOTA = 'Invites unlock after at least 1 USDC of usage in the previous week.'

/**
 * Each buyer's share of the wallet's referral points, as a percentage.
 * On-chain points are fixed-point weights with no unit of their own, so the
 * share is what tells buyers apart.
 */
function pointShares(buyers: ReadonlyArray<{ buyer: string; points: string }>): Map<string, string> {
  const total = buyers.reduce((sum, row) => sum + toBigInt(row.points), 0n)
  return new Map(buyers.map((row) => {
    if (total === 0n) return [row.buyer, '—']
    const basisPoints = Number((toBigInt(row.points) * 10_000n) / total)
    return [row.buyer, `${(basisPoints / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`]
  }))
}

function toBigInt(value: string): bigint {
  try { return BigInt(value) } catch { return 0n }
}

export default function Referrals() {
  const { workspace } = useConsole()
  // The console keeps this page mounted across workspace switches; keying the body
  // by workspace drops the invite draft, mutation feedback, created invite and claim
  // selection together, so nothing typed or chosen in one workspace acts on another.
  return <WorkspaceReferrals key={workspace.id} />
}

function WorkspaceReferrals() {
  const { workspace } = useConsole()
  const queryClient = useQueryClient()
  const toast = useToast()
  const referrals = useQuery({ queryKey: qk.referrals(workspace.id), queryFn: () => api.referrals.get(workspace.id) })
  const operator = useOperator(workspace.id)
  const chain = useChain()
  const [created, setCreated] = useState<CreatedInvite | null>(null)
  const [claim, setClaim] = useState<{ target: ClaimTarget; recipient: string | null; title: string } | null>(null)

  const createInvite = useConsoleMutation({
    mutationFn: () => api.referrals.createInvite(workspace.id),
    onSuccess: (invite) => setCreated(invite),
    invalidate: [qk.referrals(workspace.id)],
  })

  const authorized = operator.data && isSetAddress(operator.data.operator) ? operator.data.operator : null

  return (
    <div className="gc-page">
      <PageHeader title="Referrals"
        description="Invite new buyers with this workspace's wallet. You earn ANTS on their usage; they earn a bonus on it for 12 weeks." />
      <QueryView query={referrals} rows={4}>
        {(data) => !data.invitesAvailable ? (
          <EmptyState icon={<Icon.referrals size={18} />} title="Referrals are not available here"
            body="This network has no referrals contract." />
        ) : (
          <>
            <div className="gc-grid gc-grid--3">
              <StatTile label="Invites left this week" value={data.invites ? `${data.invites.left} of ${data.invites.quota}` : '—'}
                sub={data.invites ? `Epoch ${data.invites.epoch}` : undefined} />
              <StatTile label="Referred buyers" value={data.available ? String(data.referredCount) : '—'} />
              <StatTile label="Ready to claim" value={data.available ? formatAnts(data.payableAnts) : '—'} />
            </div>
            {!data.available && (
              <p className="gc-muted" role="status">Referred buyers and rewards need an explorer (Antscan) that indexes referrals; invites still work.</p>
            )}

            <Panel title="Invite someone" description="Each invite is single use and works for 4 weeks, for a buyer that is new to Antseed.">
              <div className="gc-summary-row">
                <div className="gc-summary-row__text">
                  <span className="gc-strong">
                    {data.invites && data.invites.quota === 0 ? 'No invites this week' : data.invites ? `${data.invites.left} invites left this week` : 'Create an invite link'}
                  </span>
                  <span className="gc-fineprint">
                    {data.invites && data.invites.quota === 0
                      ? NO_QUOTA
                      : 'Signed with the workspace wallet; nothing is sent on-chain until the buyer\'s first request.'}
                  </span>
                </div>
                <Button size="sm" leadingIcon={<Icon.plus size={14} />} disabled={createInvite.isPending || data.invites?.left === 0}
                  onClick={() => createInvite.mutate()}>
                  {createInvite.isPending ? 'Signing…' : 'Create invite'}
                </Button>
              </div>
              {createInvite.error
                ? isApiError(createInvite.error, 'no_invites_left')
                  ? <Alert tone="warning">{createInvite.error.message}</Alert>
                  : <ErrorAlert error={createInvite.error} title="Could not create the invite" />
                : null}
            </Panel>

            {data.available && (
              <>
                <Panel>
                  <div className="gc-summary-row">
                    <div className="gc-summary-row__text">
                      <span className="gc-strong">{antsIsPositive(data.payableAnts) ? `${formatAnts(data.payableAnts)} referral rewards ready` : 'No referral rewards to claim yet'}</span>
                      <span className="gc-fineprint">
                        {authorized
                          ? <>Paid to the authorized wallet {shortId(authorized)}.</>
                          : <>Referral rewards are paid only to an authorized wallet, and none is set. Authorize one on <PageLink to="wallet">Wallet &amp; Funding</PageLink>.</>}
                      </span>
                    </div>
                    <Button size="sm" variant="outline" disabled={!authorized || data.claimableEpochs.length === 0}
                      onClick={() => setClaim({
                        target: { kind: 'referrer', address: data.address, epochs: data.claimableEpochs },
                        recipient: authorized,
                        title: 'Claim referral rewards',
                      })}>
                      Claim
                    </Button>
                  </div>
                </Panel>

                <Panel flush title="Referred buyers" description="Share is each buyer's part of your referral points, from their weighted usage. ANTS are earned once an epoch becomes claimable.">
                  <ReferredBuyers buyers={data.buyers} />
                </Panel>
              </>
            )}

            <RefereePanel data={data} authorized={authorized} onClaim={(referee) => setClaim({
              target: { kind: 'referee', address: data.address, epochs: referee.claimableEpochs },
              recipient: authorized,
              title: 'Claim the invite bonus',
            })} />

            <Modal isOpen={created !== null} onClose={() => setCreated(null)} title="Invite created"
              subtitle={created ? `Works until epoch ${created.expiresEpoch}. ${created.left} of ${created.quota} invites left this week.` : undefined}>
              {created && (
                <div className="gc-stack">
                  <div className="gc-address">
                    <Mono>{created.link}</Mono>
                    <CopyButton value={created.link} label="Copy link" />
                  </div>
                  <p className="gc-fineprint">The buyer opens the link, or pastes the code into Antseed (Desktop, <code>antseed referral redeem</code>, or a gateway console).</p>
                  <CodeBlock code={created.invite} label="Invite code" />
                  <div className="gc-actions"><Button onClick={() => setCreated(null)}>Done</Button></div>
                </div>
              )}
            </Modal>

            <Modal isOpen={claim !== null} onClose={() => setClaim(null)} title={claim?.title ?? 'Claim'}>
              {claim && (
                <ChainGate chain={chain.data} error={chain.error}>
                  {(info) => (
                    <Suspense fallback={<LoadingRows rows={2} />}>
                      <ReferralClaim target={claim.target} chain={info} recipient={claim.recipient} onClaimed={(complete) => {
                        if (complete) {
                          toast('Rewards claimed')
                          setClaim(null)
                        }
                        // Skip the gateway's one-minute cache so the claimed epochs drop out now.
                        void api.referrals.get(workspace.id, true).then((fresh) => queryClient.setQueryData(qk.referrals(workspace.id), fresh), () => undefined)
                      }} />
                    </Suspense>
                  )}
                </ChainGate>
              )}
            </Modal>
          </>
        )}
      </QueryView>
    </div>
  )
}

function ReferredBuyers({ buyers }: { buyers: ReferralsView['buyers'] }) {
  const shares = pointShares(buyers)
  return (
    <DataTable label="Referred buyers" rows={buyers} rowKey={(row) => row.buyer}
      empty={<EmptyState icon={<Icon.referrals size={18} />} title="No referred buyers yet" body="Buyers appear here once their first request binds your invite." />}
      columns={[
        { key: 'buyer', header: 'Buyer', render: (row) => <Mono title={row.buyer}>{shortId(row.buyer)}</Mono> },
        { key: 'since', header: 'Since epoch', secondary: true, optional: true, render: (row) => row.boundEpoch ?? '—' },
        { key: 'share', header: 'Share', align: 'right', render: (row) => shares.get(row.buyer) ?? '—' },
        { key: 'pending', header: 'This epoch', align: 'right', secondary: true, render: (row) => row.pendingPoints === '0' ? '—' : <Badge>Earning</Badge> },
        { key: 'ants', header: 'Earned', align: 'right', render: (row) => formatAnts(row.ants) },
      ]} />
  )
}

/** The workspace wallet as an invited buyer: redeem an invite, see it carried, then the bonus once bound. */
function RefereePanel({ data, authorized, onClaim }: { data: ReferralsView; authorized: string | null; onClaim: (referee: Referee) => void }) {
  const { workspace } = useConsole()
  const [invite, setInvite] = useState('')
  const referee = data.referee
  const redeem = useConsoleMutation({
    mutationFn: () => api.referrals.redeem(workspace.id, invite.trim()),
    onSuccess: () => setInvite(''),
    invalidate: [qk.referrals(workspace.id)],
    toast: 'Invite saved',
  })
  const clear = useConsoleMutation({
    mutationFn: () => api.referrals.clearInvite(workspace.id),
    invalidate: [qk.referrals(workspace.id)],
    toast: 'Invite removed',
  })

  if (referee.state === 'bound') {
    return (
      <Panel title="Invited by" description="A referral binding is permanent. The bonus matches the inviter's share for 12 weeks.">
        <div className="gc-summary-row">
          <div className="gc-summary-row__text">
            <span className="gc-strong">
              {referee.referrer ? <Mono title={referee.referrer}>{shortId(referee.referrer)}</Mono> : 'Unknown referrer'}
              {' '}{referee.weeksLeft !== null && referee.weeksLeft > 0 ? <Badge tone="success">{referee.weeksLeft} bonus weeks left</Badge> : <Badge>Bonus window over</Badge>}
            </span>
            <span className="gc-fineprint">
              {antsIsPositive(referee.payableAnts) ? `${formatAnts(referee.payableAnts)} bonus ready. ` : 'No bonus to claim yet. '}
              {authorized
                ? <>Paid to the authorized wallet {shortId(authorized)}.</>
                : <>The bonus is paid only to an authorized wallet, and none is set. Authorize one on <PageLink to="wallet">Wallet &amp; Funding</PageLink>.</>}
            </span>
          </div>
          <Button size="sm" variant="outline" disabled={!authorized || referee.claimableEpochs.length === 0} onClick={() => onClaim(referee)}>Claim bonus</Button>
        </div>
      </Panel>
    )
  }

  if (referee.state === 'invited') {
    return (
      <Panel title="Invite carried" description="The workspace wallet signs the invite into its payments until a settlement binds it.">
        <div className="gc-summary-row">
          <div className="gc-summary-row__text">
            <span className="gc-strong">From {referee.referrer ? <Mono title={referee.referrer}>{shortId(referee.referrer)}</Mono> : 'an inviter'}</span>
            <span className="gc-fineprint">
              Binds with this workspace's next paid or free request{referee.inviteExpiresEpoch !== null ? `, before epoch ${referee.inviteExpiresEpoch}` : ''}.
            </span>
          </div>
          <Button size="sm" variant="ghost" disabled={clear.isPending} onClick={() => clear.mutate()}>Remove</Button>
        </div>
        {clear.error ? <ErrorAlert error={clear.error} title="Could not remove the invite" /> : null}
      </Panel>
    )
  }

  // Only a wallet new to Antseed can be invited.
  if (referee.canRedeem === false) return null

  return (
    <Panel title="Have an invite?" description="A wallet new to Antseed can redeem one invite and earn a bonus on its usage for 12 weeks.">
      <form className="gc-stack" onSubmit={(event) => { event.preventDefault(); redeem.mutate() }}>
        <TextField label="Invite code or link" value={invite} onChange={(event) => setInvite(event.target.value)}
          placeholder="https://antseed.com/invite/…" />
        {redeem.error ? <ErrorAlert error={redeem.error} title="Can't use this invite" /> : null}
        <div className="gc-actions">
          <Button type="submit" variant="outline" disabled={redeem.isPending || !invite.trim()}>{redeem.isPending ? 'Checking…' : 'Redeem'}</Button>
        </div>
      </form>
    </Panel>
  )
}
