import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, DataTable, Modal, TextField, useToast } from '@antseed/ui'
import { api, isApiError } from '../api'
import type { AdminToken, Settings as SettingsData } from '../api/types'
import { useConsole } from '../app/context'
import { Icon } from '../components/icons'
import {
  Badge, ConfirmDialog, DetailList, EmptyState, ErrorAlert, Expiry, Mono, NameWithHint, PageHeader, Panel, QueryView, SecretReveal, SelectField, Switch, TabPanel,
  Tabs, TextAreaField,
} from '../components/ui'
import { formatDate, formatRelative } from '../lib/format'
import { clearMaskedValues, endpointOriginChanged, headersToText, maskedHeaderNames, textToHeaders } from '../lib/headers'
import { useConsoleMutation } from '../lib/mutations'
import { isOverridden } from '../lib/settings'
import { hyphenTwins, parseHeaderNames } from '../lib/underscore-headers'
import { BuyerSettingsEditor } from '../components/BuyerSettingsEditor'
import { UpdatePanel } from '../components/UpdatePanel'
import { qk, useAdminTokens, useStatus } from '../lib/queries'

type Tab = 'general' | 'buyer' | 'observability' | 'tokens' | 'auth'
const TABS: readonly Tab[] = ['general', 'buyer', 'observability', 'tokens', 'auth']

function General() {
  const status = useStatus()
  return (
    <Panel title="Gateway">
      <QueryView query={status}>
        {(data) => (
          <DetailList items={[
            ['Public URL', data.publicUrl ? <Mono key="u">{data.publicUrl}</Mono> : <span className="gc-muted">Not set. Clients use this console's address.</span>],
            ['Buyer', data.buyer.reachable ? <Badge key="b" tone="success">Connected</Badge> : <Badge key="b" tone="danger">Unreachable</Badge>],
            ['Sellers seen', String(data.buyer.peers)],
            ['Spend feed', data.spendFeed],
            ['USDC top-ups (x402)', data.x402 ? 'On' : 'Off'],
          ]} />
        )}
      </QueryView>
    </Panel>
  )
}

/** What Caddy does with the list right now, in one line. */
function UnderscoreHeadersState({ settings }: { settings: SettingsData['underscoreHeaders'] }) {
  const { names, status } = settings
  if (status.state === 'applied') return <p className="text-sm"><Badge tone="success">Kept by Caddy</Badge></p>
  if (status.state === 'unavailable' || status.state === 'error') {
    return (
      <p className="flex items-start gap-2 text-sm" role="status">
        <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-amber-500" />
        <span>Not applied: {status.reason ?? 'Caddy could not be reached'}.</span>
      </p>
    )
  }
  if (names && names.length > 0) return <p className="gc-muted text-sm">Waiting for the gateway to apply this.</p>
  return null
}

function UnderscoreHeaders({ settings }: { settings: SettingsData }) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const current = settings.underscoreHeaders
  const [text, setText] = useState((current.names ?? []).join('\n'))
  const names = parseHeaderNames(text)
  const save = useMutation({
    mutationFn: () => api.settings.setUnderscoreHeaders(names),
    onSuccess: (data) => {
      const { restartRequired: _restart, ...saved } = data
      queryClient.setQueryData(qk.settings, saved)
      setText((saved.underscoreHeaders.names ?? []).join('\n'))
      const { names, status } = saved.underscoreHeaders
      toast(!names?.length || status.state === 'applied' ? 'Headers saved' : 'Saved, but Caddy has not applied it')
    },
  })
  return (
    <Panel title="Headers with underscores" description={<>
      The Caddy in front of this gateway drops request headers with an underscore in the name, such as <Mono>session_id</Mono>. List the ones your clients need; the gateway keeps them in Caddy's config.
    </>}>
      <form className="gc-stack" onSubmit={(event) => { event.preventDefault(); save.mutate() }}>
        <TextAreaField label="Keep these headers" rows={3} mono placeholder={'session_id\nx_trace_*'} value={text} onChange={(event) => setText(event.target.value)}
          hint={names.length
            ? `Caddy then drops ${hyphenTwins(names).join(', ')} instead. A trailing * keeps every name with that prefix.`
            : 'One per line. A trailing * keeps every name with that prefix.'} />
        <UnderscoreHeadersState settings={current} />
        {save.error ? <ErrorAlert error={save.error} title="Could not save" /> : null}
        <div className="gc-actions"><Button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button></div>
      </form>
    </Panel>
  )
}

/** Every buyer setting, in the routing policy editor's layout. */
function BuyerSettings({ settings }: { settings: SettingsData }) {
  const buyer = settings.buyer
  return (
    <Panel title="Buyer" description={<>
      The top of every routing policy: workspaces, members, keys and presets can only narrow it. Saved to the config file of the buyer on port {buyer.proxyPort}{isOverridden(buyer.overrides, 'proxyPort') ? ' (set by its start flags)' : ''}.
    </>}>
      <BuyerSettingsEditor buyer={buyer} />
    </Panel>
  )
}

function Observability({ settings }: { settings: SettingsData }) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const current = settings.observability
  const [endpoint, setEndpoint] = useState(current.otlpEndpoint ?? '')
  const [headers, setHeaders] = useState(headersToText(current.otlpHeaders))
  const [logContent, setLogContent] = useState(current.logContent)
  const [retention, setRetention] = useState(current.retentionDays === null ? '' : String(current.retentionDays))
  const endpointError = endpoint.trim() && !/^https?:\/\/\S+$/.test(endpoint.trim()) ? 'Use an http:// or https:// URL.' : undefined
  // Saved values stay on the gateway and are only sent to the endpoint they were saved for.
  const stale = endpointOriginChanged(current.otlpEndpoint, endpoint.trim() || null) ? maskedHeaderNames(headers) : []
  const headersError = stale.length ? `Enter the value of ${stale.join(', ')} again: saved values are not sent to a new endpoint.` : undefined
  const save = useMutation({
    mutationFn: () => {
      if (endpointError) throw new Error(endpointError)
      if (headersError) throw new Error(headersError)
      const days = retention === '' ? null : Number(retention)
      return api.settings.setObservability({ otlpEndpoint: endpoint.trim() || null, otlpHeaders: textToHeaders(headers), logContent, retentionDays: days })
    },
    onSuccess: (data) => {
      const { restartRequired, ...settings } = data
      queryClient.setQueryData(qk.settings, settings)
      toast(restartRequired ? 'Observability saved. Restart the gateway to apply it.' : 'Observability saved')
    },
    onError: (error) => {
      if (isApiError(error, 'otlp_headers_required')) setHeaders(clearMaskedValues(headers))
    },
  })
  return (
    <Panel title="Observability" description="Send one OpenTelemetry trace per request, and choose what the request log keeps.">
      <form className="gc-stack" onSubmit={(event) => { event.preventDefault(); save.mutate() }}>
        <TextField label="OTLP/HTTP endpoint" placeholder="https://otel.example.com/v1/traces" value={endpoint} error={endpointError} onChange={(event) => setEndpoint(event.target.value)} />
        <TextAreaField label="Headers" rows={3} mono placeholder="Authorization: Bearer …" value={headers} onChange={(event) => setHeaders(event.target.value)}
          error={headersError}
          hint="One per line, as Name: value. Saved values show as ••••; leave them as they are to keep them (for the same endpoint only)." />
        {stale.length > 0 && (
          <div><Button size="sm" variant="outline" onClick={() => setHeaders(clearMaskedValues(headers))}>Clear saved values to re-enter them</Button></div>
        )}
        <Switch checked={logContent} onChange={setLogContent} label="Store request and response bodies"
          description="Off by default. Bodies can contain personal data; only turn this on if you need it." />
        <SelectField label="Keep the request log for" value={retention} onChange={setRetention}
          options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '365', label: '1 year' }, { value: '', label: 'Forever' }]} />
        {save.error ? <ErrorAlert error={save.error} title="Could not save" /> : null}
        <div className="gc-actions"><Button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button></div>
      </form>
    </Panel>
  )
}

function Tokens() {
  const { me } = useConsole()
  const owner = me.member.orgRole === 'owner'
  const tokens = useAdminTokens()
  const [creating, setCreating] = useState(false)
  const [label, setLabel] = useState('')
  const [scope, setScope] = useState<AdminToken['scope']>('read')
  const [expiry, setExpiry] = useState('90')
  const [secret, setSecret] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<AdminToken | null>(null)
  const create = useConsoleMutation({
    mutationFn: () => api.adminTokens.create(label.trim(), scope, expiry === 'never' ? null : Number(expiry)),
    onSuccess: (result) => { setCreating(false); setLabel(''); setSecret(result.secret) },
    invalidate: [qk.adminTokens],
  })
  const revoke = useConsoleMutation({
    mutationFn: (token: AdminToken) => api.adminTokens.revoke(token.id),
    onSuccess: () => setRevoking(null),
    invalidate: [qk.adminTokens],
  })
  return (
    <Panel flush title="Management tokens" description={<>For scripts and CI. Send as <code>Authorization: Bearer …</code> to <code>/console/api</code>.</>}
      actions={<Button size="sm" leadingIcon={<Icon.plus size={14} />} onClick={() => setCreating(true)}>New token</Button>}>
      <QueryView query={tokens}>
        {(rows) => (
          <DataTable<AdminToken> label="Management tokens" rows={rows} rowKey={(token) => token.id} rowLabel={(token) => token.label}
            actions={(token) => [{ label: 'Revoke', tone: 'danger' as const, onSelect: () => setRevoking(token) }]}
            empty={<EmptyState icon={<Icon.keys size={18} />} title="No management tokens" />}
            columns={[
              { key: 'label', header: 'Name', render: (token) => <NameWithHint name={token.label} hint={token.hint} /> },
              { key: 'scope', header: 'Scope', render: (token) => token.scope === 'admin' ? <Badge tone="warning">Admin</Badge> : <Badge>Read only</Badge> },
              { key: 'created', header: 'Created', secondary: true, optional: true, render: (token) => formatDate(token.createdAt) },
              { key: 'expires', header: 'Expires', secondary: true, render: (token) => <Expiry at={token.expiresAt} format={formatDate} /> },
              { key: 'used', header: 'Last used', secondary: true, optional: true, render: (token) => formatRelative(token.lastUsedAt) },
            ]} />
        )}
      </QueryView>
      <Modal isOpen={creating} onClose={() => setCreating(false)} title="New management token">
        <form className="gc-stack" onSubmit={(event) => { event.preventDefault(); create.mutate() }}>
          <TextField label="Name" required value={label} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. Terraform" />
          <SelectField label="Scope" value={scope} onChange={(value) => setScope(value as AdminToken['scope'])}
            options={[{ value: 'read', label: 'Read only (GET requests)' }, { value: 'admin', label: 'Admin (everything an org admin can do)' }]} />
          <SelectField label="Expires after" value={expiry} onChange={setExpiry}
            options={[{ value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '365', label: '1 year' }, ...(owner ? [{ value: 'never', label: 'Never' }] : [])]}
            hint="Short-lived tokens limit the damage if one leaks." />
          {create.error ? <ErrorAlert error={create.error} title="Could not create the token" /> : null}
          <div className="gc-actions">
            <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            <Button type="submit" disabled={create.isPending || !label.trim()}>Create token</Button>
          </div>
        </form>
      </Modal>
      <Modal isOpen={secret !== null} onClose={() => setSecret(null)} title="Token created">
        {secret && <div className="gc-stack"><SecretReveal secret={secret} /><div className="gc-actions"><Button onClick={() => setSecret(null)}>Done</Button></div></div>}
      </Modal>
      <ConfirmDialog isOpen={revoking !== null} busy={revoke.isPending} error={revoke.error} onClose={() => setRevoking(null)}
        onConfirm={() => revoking && revoke.mutate(revoking)} title="Revoke this token?" confirmLabel="Revoke"
        body={`Anything using ${revoking?.label ?? 'this token'} loses access immediately.`} />
    </Panel>
  )
}

function AuthMethods({ settings }: { settings: SettingsData }) {
  const auth = settings.auth
  const row = (on: boolean) => on ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>
  return (
    <Panel title="Sign-in methods" description="Configured on the gateway host with environment variables. Read only here.">
      <div className="gc-stack">
        <DetailList items={[
          ['Passkeys', row(auth.passkey)],
          ['Wallet (Sign-In with Ethereum)', row(auth.wallet)],
          ['OpenID Connect', auth.oidc ? <Badge key="o" tone="success">{auth.oidc.label}</Badge> : row(false)],
          ['Cloudflare Access', row(auth.cloudflareAccess)],
          ['API key view for key holders', row(auth.apiKeyLogin)],
        ]} />
        <Alert tone="info" title="Using your own identity provider">
          Set the OpenID Connect issuer, client id and secret in the gateway's environment and restart it, or put the console behind
          Cloudflare Access and enable trusted Access headers. The gateway docs list the exact variables. Antseed runs no sign-in service of its own.
        </Alert>
      </div>
    </Panel>
  )
}

function SettingsSection({ tab, settings }: { tab: Tab; settings: SettingsData }) {
  if (tab === 'buyer') return <BuyerSettings settings={settings} />
  if (tab === 'observability') return <Observability settings={settings} />
  return <AuthMethods settings={settings} />
}

export default function Settings() {
  // `?tab=buyer` opens a section directly (the routing editor links to the buyer's floors).
  const [tab, setTab] = useState<Tab>(() => {
    const requested = new URLSearchParams(window.location.search).get('tab')
    return TABS.includes(requested as Tab) ? requested as Tab : 'general'
  })
  const settings = useQuery({ queryKey: qk.settings, queryFn: api.settings.get })
  useEffect(() => { window.scrollTo?.(0, 0) }, [tab])
  return (
    <div className="gc-page">
      <PageHeader title="Settings" />
      <Tabs id="gc-settings" label="Settings sections" value={tab} onChange={setTab} tabs={[
        { id: 'general', label: 'General' }, { id: 'buyer', label: 'Buyer' }, { id: 'observability', label: 'Observability' },
        { id: 'tokens', label: 'Management tokens' }, { id: 'auth', label: 'Sign-in' },
      ]} />
      <TabPanel tabsId="gc-settings" tab={tab} className="gc-stack">
        {tab === 'general' && <>
          <General />
          <UpdatePanel />
          <QueryView query={settings}>{(data) => <UnderscoreHeaders settings={data} />}</QueryView>
        </>}
        {tab === 'tokens' && <Tokens />}
        {(tab === 'buyer' || tab === 'observability' || tab === 'auth') && (
          <QueryView query={settings}>
            {(data) => <SettingsSection tab={tab} settings={data} />}
          </QueryView>
        )}
      </TabPanel>
    </div>
  )
}
