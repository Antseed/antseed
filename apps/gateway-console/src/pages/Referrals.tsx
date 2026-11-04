import { lazy, Suspense, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, DataTable, LoadingRows, Modal, TextField, useToast } from '@antseed/ui'
import { api, isApiError } from '../api'
import type { ClaimableRewards, CreatedInvite, ReferralClaimables, Referrals as ReferralsView } from '../api/types'
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

type RewardKind = 'referrer' | 'referee'

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
  // Without an explorer the payable epochs are found on-chain on request.
  const [found, setFound] = useState<ReferralClaimables | null>(null)

  const createInvite = useConsoleMutation({
    mutationFn: () => api.referrals.createInvite(workspace.id),
    onSuccess: (invite) => setCreated(invite),
    invalidate: [qk.referrals(workspace.id)],
  })

  const authorized = operator.data && isSetAddress(operator.data.operator) ? operator.data.operator : null

  const openClaim = (kind: RewardKind, address: string, epochs: number[]) => setClaim({
    target: { kind, address, epochs },
    recipient: authorized,
    title: kind === 'referrer' ? 'Claim referral rewards' : 'Claim the invite bonus',
  })
  // Finds both rewards at once, then opens the claim the user asked for when it has anything to pay.
  const discover = useConsoleMutation({
    mutationFn: (_find: { kind: RewardKind; address: string }) => api.referrals.claimable(workspace.id),
    onSuccess: (result, { kind, address }) => {
      setFound(result)
      if (authorized && result[kind].claimableEpochs.length > 0) openClaim(kind, address, result[kind].claimableEpochs)
    },
  })

  return (
    <div className="gc-page">
      <PageHeader title="Referrals"
        description="Invite new buyers with this workspace's wallet. You earn ANTS on their usage; they earn a bonus on it for 12 weeks." />
      <QueryView query={referrals} rows={4}>
        {(data) => {
          // The explorer's rewards when it indexes them, else what "Find rewards" found on-chain; null while unknown.
          const referrerRewards: ClaimableRewards | null = data.available ? { payableAnts: data.payableAnts, claimableEpochs: data.claimableEpochs } : found?.referrer ?? null
          const refereeRewards: ClaimableRewards | null = data.referee.indexed
            ? { payableAnts: data.referee.payableAnts, claimableEpochs: data.referee.claimableEpochs }
            : found?.referee ?? null
          return !data.invitesAvailable ? (
            <EmptyState icon={<Icon.referrals size={18} />} title="Referrals are not available here"
              body="This network has no referrals contract." />
          ) : (
            <>
              <div className="gc-grid gc-grid--3">
                <StatTile label="Invites left this week" value={data.invites ? `${data.invites.left} of ${data.invites.quota}` : '—'}
                  sub={data.invites ? `Epoch ${data.invites.epoch}` : undefined} />
                <StatTile label="Referred buyers" value={data.available ? String(data.referredCount) : '—'} />
                <StatTile label="Ready to claim" value={referrerRewards ? formatAnts(referrerRewards.payableAnts) : '—'} />
              </div>
              {!data.available && (
                <p className="gc-muted" role="status">Referred buyers need an explorer (Antscan) that indexes referrals; invites work without one, and Find rewards checks the chain for claims.</p>
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

              <Panel>
                <div className="gc-summary-row">
                  <div className="gc-summary-row__text">
                    <span className="gc-strong">
                      {!referrerRewards ? 'Referral rewards not checked yet'
                        : antsIsPositive(referrerRewards.payableAnts) ? `${formatAnts(referrerRewards.payableAnts)} referral rewards ready` : 'No referral rewards to claim yet'}
                    </span>
                    <span className="gc-fineprint">
                      {authorized
                        ? <>Paid to the authorized wallet {shortId(authorized)}.</>
                        : <>Referral rewards are paid only to an authorized wallet, and none is set. Authorize one on <PageLink to="wallet">Wallet &amp; Funding</PageLink>.</>}
                    </span>
                  </div>
                  <RewardAction rewards={referrerRewards} onChain={!data.available} authorized={authorized} finding={discover.isPending} label="Claim"
                    onFind={() => discover.mutate({ kind: 'referrer', address: data.address })} onClaim={(epochs) => openClaim('referrer', data.address, epochs)} />
                </div>
                {discover.error && discover.variables?.kind === 'referrer' ? <ErrorAlert error={discover.error} title="Could not find rewards" /> : null}
              </Panel>

              {data.available && (
                <Panel flush title="Referred buyers" description="Share is each buyer's part of your referral points, from their weighted usage. ANTS are earned once an epoch becomes claimable.">
                  <ReferredBuyers buyers={data.buyers} />
                </Panel>
              )}

              <RefereePanel data={data} rewards={refereeRewards} authorized={authorized}
                finding={discover.isPending} findError={discover.variables?.kind === 'referee' ? discover.error : null}
                onFind={() => discover.mutate({ kind: 'referee', address: data.address })} onClaim={(epochs) => openClaim('referee', data.address, epochs)} />

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
                            // What was found on-chain is claimed now; Find rewards checks again.
                            setFound(null)
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
          )
        }}
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

/**
 * Claim when the rewards are known (from the explorer, or found on-chain);
 * otherwise "Find rewards", which looks them up on-chain first. An on-chain
 * lookup that found nothing offers "Check again": weeks become payable later.
 */
function RewardAction({ rewards, onChain, authorized, finding, label, onFind, onClaim }: {
  rewards: ClaimableRewards | null
  /** The rewards come from the on-chain lookup (no explorer indexes them). */
  onChain: boolean
  authorized: string | null
  finding: boolean
  label: string
  onFind: () => void
  onClaim: (epochs: number[]) => void
}) {
  if (!rewards || (onChain && rewards.claimableEpochs.length === 0)) {
    return (
      <Button size="sm" variant="outline" disabled={finding} onClick={onFind}>
        {finding ? 'Finding…' : rewards ? 'Check again' : 'Find rewards'}
      </Button>
    )
  }
  return (
    <Button size="sm" variant="outline" disabled={!authorized || rewards.claimableEpochs.length === 0} onClick={() => onClaim(rewards.claimableEpochs)}>
      {label}
    </Button>
  )
}

/** The workspace wallet as an invited buyer: redeem an invite, see it carried, then the bonus once bound. */
function RefereePanel({ data, rewards, authorized, finding, findError, onFind, onClaim }: {
  data: ReferralsView
  /** The bonus payable now; null while unknown (no explorer, and not looked up on-chain yet). */
  rewards: ClaimableRewards | null
  authorized: string | null
  finding: boolean
  findError: Error | null
  onFind: () => void
  onClaim: (epochs: number[]) => void
}) {
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
              {referee.weeksLeft === null ? null
                : <>{' '}{referee.weeksLeft > 0 ? <Badge tone="success">{referee.weeksLeft} bonus weeks left</Badge> : <Badge>Bonus window over</Badge>}</>}
            </span>
            <span className="gc-fineprint">
              {!rewards ? 'Bonus not checked yet. ' : antsIsPositive(rewards.payableAnts) ? `${formatAnts(rewards.payableAnts)} bonus ready. ` : 'No bonus to claim yet. '}
              {authorized
                ? <>Paid to the authorized wallet {shortId(authorized)}.</>
                : <>The bonus is paid only to an authorized wallet, and none is set. Authorize one on <PageLink to="wallet">Wallet &amp; Funding</PageLink>.</>}
            </span>
          </div>
          <RewardAction rewards={rewards} onChain={!data.referee.indexed} authorized={authorized} finding={finding} label="Claim bonus" onFind={onFind} onClaim={onClaim} />
        </div>
        {findError ? <ErrorAlert error={findError} title="Could not find the bonus" /> : null}
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
