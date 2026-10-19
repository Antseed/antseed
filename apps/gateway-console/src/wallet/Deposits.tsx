/**
 * Deposit confirmations: every deposit credited to the workspace wallet, who
 * approved it, and a printable confirmation a finance team can keep with its
 * books. The gateway verifies each deposit against its transaction receipt;
 * the confirmation is a record of a transfer into the workspace's prepaid
 * credits, issued by this gateway, not an invoice.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Badge, Button, DataTable, EmptyState, Logo, Modal, Panel, TextField } from '@antseed/ui'
import { api, errorMessage } from '../api'
import type { DepositConfirmation } from '../api/types'
import { useConsole } from '../app/context'
import { Icon } from '../components/icons'
import { Mono, QueryView } from '../components/ui'
import { formatDateTime, formatUsd, shortId } from '../lib/format'
import { useConsoleMutation } from '../lib/mutations'
import { qk, useChain, useStatus } from '../lib/queries'
import { href, linkHandler, navigate } from '../lib/router'

const confirmationPath = (txHash: string) => `wallet/deposits/${txHash}`

/** "25.05 USDC" (more decimals only for amounts under a cent). */
function usdc(amount: string): string {
  const value = Number(amount)
  return `${value !== 0 && Math.abs(value) < 0.01 ? value.toFixed(6).replace(/0+$/, '') : value.toFixed(2)} USDC`
}

/**
 * Where the USDC came from, in a few words. Minted USDC comes straight from
 * the issuer: an exchange withdrawal (Coinbase mints on Base) or a card
 * purchase, which the chain cannot tell apart.
 */
function sourceSummary(deposit: DepositConfirmation): string {
  if (deposit.kind === 'direct') return deposit.sources[0] ? `Deposit from wallet ${shortId(deposit.sources[0].from)}` : 'Deposit from a connected wallet'
  if (deposit.sources.length === 0) return 'Sent to the workspace wallet'
  if (deposit.sources.every((source) => source.minted)) return 'Exchange or card (new USDC)'
  const wallets = [...new Set(deposit.sources.filter((source) => !source.minted).map((source) => shortId(source.from)))]
  return wallets.length === 1 ? `Wallet ${wallets[0]}` : `${wallets.length} transfers`
}

function useDeposits(workspaceId: string) {
  return useQuery({ queryKey: qk.deposits(workspaceId), queryFn: () => api.wallet.deposits(workspaceId) })
}

function ApproveModal({ deposit, workspaceId, onClose }: { deposit: DepositConfirmation | null; workspaceId: string; onClose: () => void }) {
  const [note, setNote] = useState('')
  const approve = useConsoleMutation({
    mutationFn: () => api.wallet.approveDeposit(workspaceId, deposit!.txHash, note.trim() || null),
    invalidate: [qk.deposits(workspaceId)],
    toast: 'Deposit approved',
    onSuccess: () => { setNote(''); onClose() },
  })
  return (
    <Modal isOpen={deposit !== null} onClose={onClose} size="sm" title="Approve this deposit"
      subtitle={deposit ? `${formatUsd(deposit.sent)} on ${formatDateTime(deposit.time)}. Your name and the time are recorded on its confirmation.` : undefined}>
      <div className="gc-stack">
        <TextField label="Note (optional)" placeholder="e.g. PO 1042, October AI budget" value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} />
        {approve.error ? <p className="gc-warn">{errorMessage(approve.error)}</p> : null}
        <div className="gc-actions">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => approve.mutate()} disabled={approve.isPending}>Approve</Button>
        </div>
      </div>
    </Modal>
  )
}

function AddDepositModal({ isOpen, workspaceId, onClose }: { isOpen: boolean; workspaceId: string; onClose: () => void }) {
  const [txHash, setTxHash] = useState('')
  const add = useConsoleMutation({
    mutationFn: () => api.wallet.addDeposit(workspaceId, txHash.trim()),
    invalidate: [qk.deposits(workspaceId)],
    toast: 'Deposit added',
    onSuccess: () => { setTxHash(''); onClose() },
  })
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm" title="Add a past deposit"
      subtitle="USDC sent to the workspace wallet is listed once it starts moving into the credits. For a missing one, paste the transaction that sent it to the wallet, or your deposit from a connected wallet.">
      <div className="gc-stack">
        <TextField label="Transaction hash" placeholder="0x…" value={txHash} onChange={(event) => setTxHash(event.target.value)} spellCheck={false} />
        {add.error ? <p className="gc-warn">{errorMessage(add.error)}</p> : null}
        <div className="gc-actions">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => add.mutate()} disabled={add.isPending || !txHash.trim()}>{add.isPending ? 'Checking the chain…' : 'Add deposit'}</Button>
        </div>
      </div>
    </Modal>
  )
}

/** The Deposits panel on Wallet & Funding. */
export function DepositsPanel({ workspaceId }: { workspaceId: string }) {
  const deposits = useDeposits(workspaceId)
  const [approving, setApproving] = useState<DepositConfirmation | null>(null)
  const [adding, setAdding] = useState(false)
  const unapprove = useConsoleMutation({
    mutationFn: (deposit: DepositConfirmation) => api.wallet.unapproveDeposit(workspaceId, deposit.txHash),
    invalidate: [qk.deposits(workspaceId)],
    toast: 'Approval removed',
  })
  return (
    <section id="gc-deposits" className="gc-anchor">
      <Panel flush title="Deposits" description="USDC sent to this workspace's wallet, and deposits from connected wallets. Approve one to record it as an expense, and keep its confirmation for your books."
        actions={<Button size="sm" variant="outline" onClick={() => setAdding(true)}>Add a past deposit</Button>}>
        <QueryView query={deposits}>
          {(list) => (
            <DataTable<DepositConfirmation> label="Deposits" rows={list} rowKey={(deposit) => deposit.txHash}
              rowLabel={(deposit) => `deposit of ${formatUsd(deposit.sent)} on ${formatDateTime(deposit.time)}`}
              actions={(deposit) => [
                { label: 'View confirmation', onSelect: () => navigate(confirmationPath(deposit.txHash)) },
                !deposit.approval && { label: 'Approve…', onSelect: () => setApproving(deposit) },
                deposit.approval && { label: 'Remove approval', onSelect: () => unapprove.mutate(deposit) },
              ]}
              empty={<EmptyState icon={<Icon.wallet size={18} />} title="No deposits yet" body="USDC sent to the workspace wallet shows up here once it starts moving into the credits, usually within a minute. Add a missing one by its transaction." />}
              columns={[
                { key: 'date', header: 'Date', render: (deposit) => formatDateTime(deposit.time) },
                {
                  key: 'amount', header: 'Amount', align: 'right',
                  render: (deposit) => <a className="gc-link" href={href(confirmationPath(deposit.txHash))} onClick={linkHandler(confirmationPath(deposit.txHash))}>{formatUsd(deposit.sent)}</a>,
                },
                { key: 'from', header: 'From', secondary: true, render: (deposit) => sourceSummary(deposit) },
                {
                  key: 'approval', header: 'Approval',
                  render: (deposit) => deposit.approval
                    ? <span title={deposit.approval.note ?? undefined}><Badge tone="success">Approved</Badge> <span className="gc-muted">by {deposit.approval.by.replace(/ \(.*\)$/, '')}</span></span>
                    : <Button size="sm" variant="outline" onClick={() => setApproving(deposit)}>Approve</Button>,
                },
              ]} />
          )}
        </QueryView>
      </Panel>
      <ApproveModal deposit={approving} workspaceId={workspaceId} onClose={() => setApproving(null)} />
      <AddDepositModal isOpen={adding} workspaceId={workspaceId} onClose={() => setAdding(false)} />
    </section>
  )
}

/** One row of the confirmation document. */
function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="gc-doc__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/**
 * The printable confirmation of one deposit (`/console/wallet/deposits/<tx>`).
 * "Print or save as PDF" uses the browser's print dialog; print styles leave
 * only the document on the page.
 */
export function DepositConfirmationPage({ txHash }: { txHash: string }) {
  const { workspace } = useConsole()
  const deposits = useDeposits(workspace.id)
  const chain = useChain()
  const status = useStatus()
  const [approving, setApproving] = useState<DepositConfirmation | null>(null)
  const explorer = chain.data?.explorerUrl ?? null
  const txLink = (hash: string) => (explorer ? <a className="gc-link" href={`${explorer.replace(/\/$/, '')}/tx/${hash}`} target="_blank" rel="noreferrer"><Mono>{hash}</Mono></a> : <Mono>{hash}</Mono>)
  const gatewayAddress = status.data?.publicUrl ?? window.location.origin
  return (
    <div className="gc-page">
      <div className="gc-inline gc-no-print">
        <Button variant="ghost" size="sm" leadingIcon={<Icon.left size={14} />} onClick={() => navigate('wallet')}>Wallet & Funding</Button>
      </div>
      <QueryView query={deposits}>
        {(list) => {
          const deposit = list.find((entry) => entry.txHash === txHash.toLowerCase())
          if (!deposit) return <EmptyState icon={<Icon.wallet size={18} />} title="Deposit not found" body="It is not a deposit of this workspace. Add it by its transaction on Wallet & Funding." />
          return (
            <>
              <article className="gc-doc" aria-label="Deposit confirmation">
                <header className="gc-doc__head">
                  <div>
                    <h1 className="gc-doc__title">Deposit confirmation</h1>
                    <p className="gc-doc__ref">{deposit.reference}</p>
                  </div>
                  <Logo />
                </header>
                <dl className="gc-doc__rows">
                  <Line label="Workspace">{deposit.workspaceName}</Line>
                  <Line label="Gateway">{gatewayAddress.replace(/^https?:\/\//, '')}</Line>
                  <Line label="Date">{new Date(deposit.time).toUTCString().replace('GMT', 'UTC')}</Line>
                  <Line label={deposit.kind === 'transfer' ? 'Amount received' : 'Amount sent'}>{usdc(deposit.sent)}</Line>
                  {deposit.kind === 'relay' && <Line label="Relay fee">{usdc(deposit.fee)}</Line>}
                  {deposit.kind !== 'transfer' && <Line label="Credited to the balance">{usdc(deposit.credited)}</Line>}
                  <Line label="Network">{chain.data?.name ?? 'Base'} · USDC</Line>
                  <Line label="Workspace wallet"><Mono>{deposit.wallet}</Mono></Line>
                  <Line label={deposit.kind === 'transfer' ? 'Transaction' : 'Deposit transaction'}>{txLink(deposit.txHash)}</Line>
                  <Line label="Funded from">
                    {deposit.sources.length === 0
                      ? <span className="gc-muted">Not found on-chain within the half hour before the deposit.</span>
                      : (
                        <ul className="gc-doc__sources">
                          {deposit.sources.map((source) => (
                            <li key={source.txHash}>
                              {usdc(source.amount)} {source.minted ? 'minted into the wallet by the USDC issuer (an exchange withdrawal or a card purchase)' : <>from <Mono>{source.from}</Mono></>}
                              <br />{txLink(source.txHash)}
                            </li>
                          ))}
                        </ul>
                      )}
                  </Line>
                  <Line label="Approval">
                    {deposit.approval
                      ? <>Approved by {deposit.approval.by} on {new Date(deposit.approval.at).toUTCString().replace('GMT', 'UTC')}{deposit.approval.note ? <><br />Note: {deposit.approval.note}</> : null}</>
                      : <span className="gc-muted">Not approved yet</span>}
                  </Line>
                </dl>
                <footer className="gc-doc__foot">
                  Issued by this Antseed gateway from the transaction records on {chain.data?.name ?? 'Base'}, which anyone can check with the links above.
                  {deposit.kind === 'transfer'
                    ? <>The USDC moves from the workspace wallet into its prepaid credits automatically, less a fixed relay fee per move; the credits pay AI providers per request. This is a confirmation of the transfer, not an invoice.</>
                    : <>The amount moved into the workspace's prepaid credits, which pay AI providers per request. This is a confirmation of the deposit, not an invoice.</>}
                </footer>
              </article>
              <div className="gc-inline gc-no-print">
                <Button leadingIcon={<Icon.download size={14} />} onClick={() => window.print()}>Print or save as PDF</Button>
                {!deposit.approval && <Button variant="outline" onClick={() => setApproving(deposit)}>Approve…</Button>}
              </div>
              <ApproveModal deposit={approving} workspaceId={workspace.id} onClose={() => setApproving(null)} />
            </>
          )
        }}
      </QueryView>
    </div>
  )
}
