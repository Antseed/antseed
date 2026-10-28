/**
 * Purchase statements: per month, what the workspace bought from which
 * sellers, with the settlement transactions that paid them and the money
 * that came in, as a printable document a finance team can keep with its
 * books. The workspace's billing details name the buyer on it. It is a record
 * of purchases, not an invoice: sellers are paid directly from the credits
 * and issue none.
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Badge, Button, DataTable, EmptyState, Logo, Modal, Panel, TextAreaField, TextField } from '@antseed/ui'
import { api, errorMessage } from '../api'
import type { BillingProfile, BillingProfileInput, PurchaseStatement, StatementSummary, StatementSupplier } from '../api/types'
import { useConsole } from '../app/context'
import { Icon } from '../components/icons'
import { Mono, QueryView } from '../components/ui'
import { csvCell } from '../lib/csv'
import { formatNumber, formatUsd, shortId } from '../lib/format'
import { useConsoleMutation } from '../lib/mutations'
import { qk, useChain, useStatus } from '../lib/queries'
import { href, linkHandler, navigate } from '../lib/router'

const statementPath = (period: string) => `wallet/statements/${period}`
/** Settlement transactions listed per seller on the page; the CSV has every one. */
const LISTED_SETTLEMENTS = 8

/** "October 2026". */
function monthName(period: string): string {
  const [year, month] = period.split('-').map(Number)
  return new Date(Date.UTC(year!, month! - 1, 1)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

const utcDate = (epochMs: number) => new Date(epochMs).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

/** "12.34" (more decimals only for amounts under a cent). */
function usdc(amount: string): string {
  const value = Number(amount)
  return value !== 0 && Math.abs(value) < 0.01 ? value.toFixed(6).replace(/0+$/, '') : value.toFixed(2)
}

function eur(amount: string, rate: PurchaseStatement['eurRate']): string {
  if (!rate) return '—'
  return (Number(amount) / rate.usdPerEur).toLocaleString('en-IE', { style: 'currency', currency: 'EUR' })
}

function supplierName(supplier: StatementSupplier): string {
  if (supplier.name) return supplier.name
  return supplier.peerId ? `Seller ${shortId(supplier.peerId)}` : 'Unknown seller'
}

function serviceLabel(line: StatementSupplier['lines'][number]): string {
  if (line.kind === 'routing') return `Routing fee${line.service ? ` (${line.service})` : ''}`
  return line.service ?? 'Unknown model'
}

/** Every line and settlement as CSV, for importing into bookkeeping software. */
function statementCsv(statement: PurchaseStatement): string {
  const eurValue = (amount: string) => (statement.eurRate ? (Number(amount) / statement.eurRate.usdPerEur).toFixed(2) : '')
  const rows: Array<Array<string | number>> = [['reference', 'period', 'type', 'seller', 'seller_address', 'service', 'requests', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'amount_usdc', 'amount_eur', 'tx_hash', 'date_utc']]
  for (const supplier of statement.suppliers) {
    for (const line of supplier.lines) {
      rows.push([statement.reference, statement.period, line.kind === 'routing' ? 'routing_fee' : 'purchase', supplierName(supplier), supplier.peerId, line.service ?? '',
        line.requests, line.inputTokens, line.cachedInputTokens, line.outputTokens, line.amount, eurValue(line.amount), '', ''])
    }
    for (const settlement of supplier.settlements ?? []) {
      rows.push([statement.reference, statement.period, 'settlement', supplierName(supplier), supplier.peerId, '', '', '', '', '', settlement.amount, eurValue(settlement.amount), settlement.txHash, new Date(settlement.time).toISOString()])
    }
  }
  for (const deposit of statement.funding.deposits) {
    rows.push([statement.reference, statement.period, 'deposit', '', '', '', '', '', '', '', deposit.amount, eurValue(deposit.amount), deposit.txHash, new Date(deposit.time).toISOString()])
  }
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`
}

function downloadCsv(statement: PurchaseStatement): void {
  const url = URL.createObjectURL(new Blob([statementCsv(statement)], { type: 'text/csv' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${statement.reference}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

function useBillingProfile(workspaceId: string) {
  return useQuery({ queryKey: qk.billingProfile(workspaceId), queryFn: () => api.wallet.billingProfile(workspaceId) })
}

const EMPTY_PROFILE: BillingProfileInput = { companyName: '', address: '', country: '', vatNumber: '', registrationNumber: '' }

function BillingModal({ isOpen, workspaceId, profile, onClose }: { isOpen: boolean; workspaceId: string; profile: BillingProfile | null; onClose: () => void }) {
  const [draft, setDraft] = useState<BillingProfileInput>(EMPTY_PROFILE)
  useEffect(() => {
    if (isOpen) setDraft(profile ? { ...profile, vatNumber: profile.vatNumber ?? '', registrationNumber: profile.registrationNumber ?? '' } : EMPTY_PROFILE)
  }, [isOpen, profile])
  const field = (key: keyof BillingProfileInput) => ({
    value: draft[key] ?? '',
    onChange: (event: { target: { value: string } }) => setDraft((current) => ({ ...current, [key]: event.target.value })),
  })
  const invalidate = [qk.billingProfile(workspaceId), qk.statements(workspaceId)]
  const save = useConsoleMutation({
    mutationFn: () => api.wallet.setBillingProfile(workspaceId, { ...draft, vatNumber: draft.vatNumber?.trim() || null, registrationNumber: draft.registrationNumber?.trim() || null }),
    invalidate,
    toast: 'Billing details saved',
    onSuccess: onClose,
  })
  const remove = useConsoleMutation({
    mutationFn: () => api.wallet.deleteBillingProfile(workspaceId),
    invalidate,
    toast: 'Billing details removed',
    onSuccess: onClose,
  })
  // One change at a time: a save still waiting on the VAT check must not land after a removal.
  const busy = save.isPending || remove.isPending
  const ready = draft.companyName.trim() && draft.address.trim() && /^[a-zA-Z]{2}$/.test(draft.country.trim())
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm" title="Billing details"
      subtitle="The company this workspace buys for, printed on its purchase statements. Statements already final keep the details they were issued with.">
      <div className="gc-stack">
        <TextField label="Company name" placeholder="Example B.V." maxLength={200} {...field('companyName')} />
        <TextAreaField label="Address" placeholder={'Street and number\nPostal code and city'} rows={3} maxLength={500} {...field('address')} />
        <TextField label="Country" hint="Two-letter code, e.g. NL" maxLength={2} {...field('country')} />
        <TextField label="VAT number (optional)" hint="An EU number is checked with the EU's VIES service." placeholder="NL000000000B01" maxLength={30} spellCheck={false} {...field('vatNumber')} />
        <TextField label="Company registration number (optional)" placeholder="e.g. KvK number" maxLength={50} {...field('registrationNumber')} />
        {save.error ? <p className="gc-warn">{errorMessage(save.error)}</p> : null}
        <div className="gc-actions">
          {profile && <Button variant="ghost" onClick={() => remove.mutate()} disabled={busy}>Remove</Button>}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={busy || !ready}>{save.isPending ? 'Saving…' : 'Save'}</Button>
        </div>
      </div>
    </Modal>
  )
}

function VatLine({ profile }: { profile: BillingProfile }) {
  if (!profile.vatNumber) return null
  const check = profile.vatCheck
  return (
    <>
      <Mono>{profile.vatNumber}</Mono>
      {check && <span className="gc-muted"> · {check.valid ? 'valid in VIES' : 'not found in VIES'} on {utcDate(check.at)}</span>}
    </>
  )
}

/** The Purchase statements panel on Wallet & Funding. */
export function StatementsPanel({ workspaceId }: { workspaceId: string }) {
  const statements = useQuery({ queryKey: qk.statements(workspaceId), queryFn: () => api.wallet.statements(workspaceId) })
  const profile = useBillingProfile(workspaceId)
  const [editing, setEditing] = useState(false)
  return (
    <section id="gc-statements" className="gc-anchor">
      <Panel flush title="Purchase statements" description="What this workspace bought each month, from which providers, with the payments on Base that paid them. A month's statement is final a day after the month ends."
        actions={<Button size="sm" variant="outline" onClick={() => setEditing(true)}>Billing details</Button>}>
        {profile.data === null && (
          <p className="gc-override gc-statements__notice">
            <span className="gc-attention" aria-hidden="true" />
            Add <button type="button" className="gc-link-button" onClick={() => setEditing(true)}>billing details</button> to name your company on the statements. A month stays a draft until they are set.
          </p>
        )}
        <QueryView query={statements}>
          {(list) => (
            <DataTable<StatementSummary> label="Purchase statements" rows={list} rowKey={(entry) => entry.period}
              rowLabel={(entry) => `statement for ${monthName(entry.period)}`}
              onRowClick={(entry) => navigate(statementPath(entry.period))}
              empty={<EmptyState icon={<Icon.wallet size={18} />} title="No purchases yet" body="A statement is listed for every month from the workspace's first paid request." />}
              columns={[
                { key: 'month', header: 'Month', render: (entry) => <a className="gc-link" href={href(statementPath(entry.period))} onClick={linkHandler(statementPath(entry.period))}>{monthName(entry.period)}</a> },
                { key: 'purchases', header: 'Purchases', align: 'right', render: (entry) => formatUsd(entry.purchases) },
                { key: 'status', header: 'Status', render: (entry) => (entry.status === 'final' ? <Badge tone="success">Final</Badge> : <Badge>Draft</Badge>) },
                { key: 'reference', header: 'Reference', secondary: true, render: (entry) => <Mono>{entry.reference}</Mono> },
              ]} />
          )}
        </QueryView>
      </Panel>
      <BillingModal isOpen={editing} workspaceId={workspaceId} profile={profile.data ?? null} onClose={() => setEditing(false)} />
    </section>
  )
}

function Supplier({ supplier, index, statement, network, txLink }: { supplier: StatementSupplier; index: number; statement: PurchaseStatement; network: string; txLink: (hash: string, label?: string) => React.ReactNode }) {
  const [all, setAll] = useState(false)
  const settlements = supplier.settlements ?? []
  const shown = all ? settlements : settlements.slice(0, LISTED_SETTLEMENTS)
  return (
    <section className="gc-statement__supplier">
      <div className="gc-statement__supplier-head">
        <div>
          <strong>{index + 1}. {supplierName(supplier)}</strong>
          <div><Mono>{supplier.peerId || '—'}</Mono></div>
        </div>
        <div className="gc-statement__claims">
          {supplier.verificationLinks.length
            ? supplier.verificationLinks.map((link) => <span key={link.href}><Badge tone="success">Verified {link.kind}</Badge> {link.label}</span>)
            : <span className="gc-muted">No verified identity</span>}
        </div>
      </div>
      <div className="gc-statement__table">
        <table>
          <thead>
            <tr><th>Service</th><th>Requests</th><th>Input tokens</th><th>Cached input</th><th>Output tokens</th><th>USDC</th><th>EUR</th></tr>
          </thead>
          <tbody>
            {supplier.lines.map((line) => (
              <tr key={`${line.kind}:${line.service}`}>
                <td><Mono>{serviceLabel(line)}</Mono></td>
                <td>{line.kind === 'routing' ? '—' : formatNumber(line.requests)}</td>
                <td>{formatNumber(line.inputTokens)}</td>
                <td>{formatNumber(line.cachedInputTokens)}</td>
                <td>{formatNumber(line.outputTokens)}</td>
                <td>{usdc(line.amount)}</td>
                <td>{eur(line.amount, statement.eurRate)}</td>
              </tr>
            ))}
            <tr className="gc-statement__subtotal">
              <td colSpan={5}>Subtotal {supplierName(supplier)}</td>
              <td>{usdc(supplier.total)}</td>
              <td>{eur(supplier.total, statement.eurRate)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="gc-statement__proof">
        {supplier.settlements === null
          ? <span className="gc-muted">Payment records could not be read from the chain explorer.</span>
          : settlements.length === 0
            ? <span className="gc-muted">No settlement on {network} this month: what was bought is settled with the provider's next settlement.</span>
            : (
              <>
                <span className="gc-muted">Paid on {network}, {settlements.length} settlement{settlements.length === 1 ? '' : 's'} this month:</span>
                {shown.map((settlement) => <span key={settlement.txHash}>{utcDate(settlement.time)} · {usdc(settlement.amount)} USDC · {txLink(settlement.txHash, shortId(settlement.txHash, 10, 8))}</span>)}
                {settlements.length > shown.length && (
                  <button type="button" className="gc-link-button gc-no-print" onClick={() => setAll(true)}>Show all {settlements.length}</button>
                )}
                {settlements.length > shown.length && <span className="gc-print-only gc-muted">and {settlements.length - shown.length} more, listed in the CSV export.</span>}
              </>
            )}
      </div>
    </section>
  )
}

/**
 * The printable statement of one month (`/console/wallet/statements/<YYYY-MM>`).
 * "Print or save as PDF" uses the browser's print dialog; print styles leave
 * only the document on the page.
 */
export function StatementPage({ period }: { period: string }) {
  const { workspace } = useConsole()
  const statement = useQuery({ queryKey: qk.statement(workspace.id, period), queryFn: () => api.wallet.statement(workspace.id, period) })
  const chain = useChain()
  const status = useStatus()
  const [editing, setEditing] = useState(false)
  const profile = useBillingProfile(workspace.id)
  const explorer = chain.data?.explorerUrl ?? null
  const txLink = (hash: string, label?: string) => (explorer
    ? <a className="gc-link" href={`${explorer.replace(/\/$/, '')}/tx/${hash}`} target="_blank" rel="noreferrer"><Mono>{label ?? hash}</Mono></a>
    : <Mono>{label ?? hash}</Mono>)
  const gatewayAddress = (status.data?.publicUrl ?? window.location.origin).replace(/^https?:\/\//, '')
  const network = chain.data?.name ?? 'Base'
  return (
    <div className="gc-page">
      <div className="gc-inline gc-no-print">
        <Button variant="ghost" size="sm" leadingIcon={<Icon.left size={14} />} onClick={() => navigate('wallet')}>Wallet & Funding</Button>
      </div>
      <QueryView query={statement}>
        {(doc) => (
          <>
            {doc.status === 'open' && (
              <p className="gc-override gc-no-print">
                <span className="gc-attention" aria-hidden="true" />
                {doc.buyer === null
                  ? <>Draft: add <button type="button" className="gc-link-button" onClick={() => setEditing(true)}>billing details</button> to name your company; the statement is final a day after the month ends.</>
                  : <>Draft: the figures can still change. The statement is final a day after the month ends.</>}
              </p>
            )}
            <article className="gc-doc gc-statement" aria-label="Purchase statement">
              <header className="gc-doc__head">
                <div>
                  <h1 className="gc-doc__title">Purchase statement{doc.status === 'open' ? ' (draft)' : ''}</h1>
                  <p className="gc-doc__ref">{doc.reference} · {monthName(doc.period)}</p>
                </div>
                <Logo />
              </header>

              <div className="gc-statement__parties">
                <div>
                  <h2 className="gc-statement__label">Buyer</h2>
                  {doc.buyer
                    ? (
                      <>
                        <strong>{doc.buyer.companyName}</strong>
                        <div className="gc-statement__address">{doc.buyer.address}</div>
                        <div>{doc.buyer.country}</div>
                        <dl className="gc-statement__kv">
                          {doc.buyer.vatNumber && <><dt>VAT number</dt><dd><VatLine profile={doc.buyer} /></dd></>}
                          {doc.buyer.registrationNumber && <><dt>Registration</dt><dd><Mono>{doc.buyer.registrationNumber}</Mono></dd></>}
                        </dl>
                      </>
                    )
                    : <span className="gc-muted">No billing details yet.</span>}
                </div>
                <div>
                  <h2 className="gc-statement__label">Statement</h2>
                  <dl className="gc-statement__kv">
                    <dt>Period</dt><dd>{utcDate(doc.from)} – {utcDate(doc.to - 1)} (UTC)</dd>
                    <dt>{doc.status === 'final' ? 'Issued' : 'Generated'}</dt><dd>{utcDate(doc.issuedAt ?? doc.generatedAt)}</dd>
                    <dt>Issued by</dt><dd>The buyer's own Antseed gateway, <Mono>{gatewayAddress}</Mono></dd>
                    <dt>Workspace</dt><dd>{doc.workspace.name}</dd>
                    <dt>Workspace wallet</dt><dd>{doc.workspace.wallet ? <Mono>{doc.workspace.wallet}</Mono> : '—'}</dd>
                    <dt>Network</dt><dd>{network} · USDC</dd>
                    <dt>EUR rate</dt><dd>{doc.eurRate ? `ECB reference rate of ${doc.eurRate.date}: 1 EUR = ${doc.eurRate.usdPerEur.toFixed(4)} USD; 1 USDC valued at 1 USD` : 'Not available'}</dd>
                  </dl>
                </div>
              </div>

              <div className="gc-statement__summary">
                <div><span>Purchases</span><strong>{usdc(doc.total)} USDC</strong></div>
                <div><span>In EUR</span><strong>{eur(doc.total, doc.eurRate)}</strong></div>
                <div><span>Requests</span><strong>{formatNumber(doc.requests)}</strong></div>
                <div><span>Providers</span><strong>{doc.suppliers.length}</strong></div>
              </div>

              <h2 className="gc-statement__heading">Purchases by provider</h2>
              {doc.suppliers.length === 0
                ? <p className="gc-muted">No paid requests this month.</p>
                : doc.suppliers.map((supplier, index) => <Supplier key={supplier.peerId || index} supplier={supplier} index={index} statement={doc} network={network} txLink={txLink} />)}
              <div className="gc-statement__total">
                <span>Total purchases, {monthName(doc.period)}</span>
                <span>{usdc(doc.total)} USDC</span>
                <span>{eur(doc.total, doc.eurRate)}</span>
              </div>

              <div className="gc-statement__boxes">
                <section>
                  <h2 className="gc-statement__label">VAT</h2>
                  <dl className="gc-statement__kv">
                    <dt>VAT charged by providers</dt><dd>None</dd>
                    <dt>Taxable base (EUR)</dt><dd><strong>{eur(doc.total, doc.eurRate)}</strong></dd>
                  </dl>
                  <p>The providers did not charge VAT, so any reverse-charge self-assessment is the buyer's responsibility. Confirm the treatment with your tax advisor.</p>
                </section>
                <section>
                  <h2 className="gc-statement__label">Money in this month</h2>
                  {doc.funding.deposits.length === 0
                    ? <p className="gc-muted">No deposits this month.</p>
                    : (
                      <ul className="gc-doc__sources">
                        {doc.funding.deposits.map((deposit) => (
                          <li key={deposit.txHash}>
                            {utcDate(deposit.time)} · {usdc(deposit.amount)} USDC · {deposit.reference}<br />{txLink(deposit.txHash, shortId(deposit.txHash, 10, 8))}
                          </li>
                        ))}
                      </ul>
                    )}
                  <dl className="gc-statement__kv">
                    <dt>Deposited</dt><dd>{usdc(doc.funding.total)} USDC</dd>
                    <dt>Relay fees</dt><dd>{usdc(doc.funding.relayFees)} USDC</dd>
                  </dl>
                  <p className="gc-muted">Each deposit has its own deposit confirmation.</p>
                </section>
              </div>

              <footer className="gc-doc__foot">
                <p><strong>What this document is.</strong> A record of AI services the buyer bought on the Antseed network during the month, prepared by the buyer's own gateway from its request ledger and the payment records on {network}. It is not an invoice: each provider is an independent operator on the network, paid directly from the workspace's prepaid credits, and did not issue one.</p>
                <p><strong>How to check it.</strong> Every payment to a provider is a settlement transaction on {network}, listed under that provider, and every deposit is a transaction to the workspace wallet; anyone can look them up. Settlements can land after the request they pay for, so a month's settlements need not add up to its purchases. The protocol fee is deducted from the provider's payout and is included in the amounts above, not charged on top.</p>
                <p><Mono>{doc.reference} · generated {new Date(doc.generatedAt).toISOString().replace('T', ' ').slice(0, 16)} UTC</Mono></p>
              </footer>
            </article>
            <div className="gc-inline gc-no-print">
              <Button leadingIcon={<Icon.download size={14} />} onClick={() => window.print()}>Print or save as PDF</Button>
              <Button variant="outline" leadingIcon={<Icon.download size={14} />} onClick={() => downloadCsv(doc)}>Download CSV</Button>
              {doc.status === 'open' && <Button variant="outline" onClick={() => setEditing(true)}>Billing details</Button>}
            </div>
          </>
        )}
      </QueryView>
      <BillingModal isOpen={editing} workspaceId={workspace.id} profile={profile.data ?? null} onClose={() => setEditing(false)} />
    </div>
  )
}

