import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, DataTable, Modal, TextField, useToast } from '@antseed/ui'
import { api } from '../api'
import type { AlertDelivery, AlertDestination, AlertsConfig, AlertSettings } from '../api/types'
import { useConsole } from '../app/context'
import { Icon } from '../components/icons'
import { Badge, CodeBlock, ConfirmDialog, EmptyState, ErrorAlert, Mono, PageHeader, Panel, QueryView, SecretReveal, Segmented, SelectField, Switch } from '../components/ui'
import {
  ALERT_GROUPS, alertSettingsDraft, alertSettingsErrors, alertSettingsInput, destinationChanges, destinationReady, EMPTY_DESTINATION, KIND_LABELS,
  newDestinationInput, REPEAT_OPTIONS, TARGET_FIELD, WEBHOOK_VERIFY_SNIPPET, type AlertSettingsDraft, type DestinationDraft,
} from '../lib/alerts'
import { formatDateTime, formatRelative } from '../lib/format'
import { useConsoleMutation } from '../lib/mutations'
import { qk } from '../lib/queries'

function Thresholds({ workspaceId, settings }: { workspaceId: string; settings: AlertSettings }) {
  const [draft, setDraft] = useState<AlertSettingsDraft>(() => alertSettingsDraft(settings))
  useEffect(() => setDraft(alertSettingsDraft(settings)), [settings])
  const errors = alertSettingsErrors(draft)
  const dirty = JSON.stringify(draft) !== JSON.stringify(alertSettingsDraft(settings))
  const save = useConsoleMutation({
    mutationFn: () => api.alerts.saveSettings(workspaceId, alertSettingsInput(draft)),
    invalidate: [qk.alerts(workspaceId)],
    toast: 'Alert settings saved',
  })
  const set = (field: keyof AlertSettingsDraft) => (value: string) => setDraft((current) => ({ ...current, [field]: value }))
  return (
    <Panel title="When to alert" description="Leave a field empty to turn that alert off. A spend limit that is reached always alerts.">
      <form className="gc-stack" onSubmit={(event) => { event.preventDefault(); save.mutate() }}>
        <div className="gc-grid gc-grid--2">
          <TextField label="Low credits below (USD)" inputMode="decimal" placeholder="e.g. 10" value={draft.lowBalanceUsd}
            onChange={(event) => set('lowBalanceUsd')(event.target.value)} error={errors.lowBalanceUsd}
            hint="Checked every few minutes against the credits the workspace wallet can spend." />
          <TextField label="Top up to (USD)" inputMode="decimal" placeholder="e.g. 50" value={draft.topupTargetUsd}
            onChange={(event) => set('topupTargetUsd')(event.target.value)} error={errors.topupTargetUsd}
            hint="Alerts suggest the amount that brings the credits back here; a webhook can send it." />
          <TextField label="Warn at % of a spend limit" inputMode="numeric" placeholder="e.g. 80" value={draft.limitWarnPercent}
            onChange={(event) => set('limitWarnPercent')(event.target.value)} error={errors.limitWarnPercent}
            hint="For every key, member and workspace limit in this workspace." />
          <SelectField label="Repeat an open alert" value={draft.repeatMinutes} onChange={set('repeatMinutes')} options={REPEAT_OPTIONS}
            hint="Until it is resolved, e.g. the credits are topped up." />
        </div>
        {save.error ? <ErrorAlert error={save.error} title="Could not save" /> : null}
        <div className="gc-actions">
          <Button type="submit" disabled={!dirty || save.isPending || Object.keys(errors).length > 0}>Save</Button>
        </div>
      </form>
    </Panel>
  )
}

function DestinationDialog({ workspaceId, emailAvailable, editing, onClose, onSecret }: {
  workspaceId: string
  emailAvailable: boolean
  editing: AlertDestination | null
  onClose: () => void
  onSecret: (secret: string) => void
}) {
  const [draft, setDraft] = useState<DestinationDraft>(() => (editing
    ? { kind: editing.kind, label: editing.label, target: editing.kind === 'webhook' ? '' : editing.target, botToken: '', events: editing.events }
    : EMPTY_DESTINATION))
  const field = TARGET_FIELD[draft.kind]
  const save = useConsoleMutation({
    mutationFn: async () => {
      if (editing) {
        await api.alerts.updateDestination(workspaceId, editing.id, destinationChanges(draft, editing))
        return null
      }
      const created = await api.alerts.createDestination(workspaceId, newDestinationInput(draft))
      return created.signingSecret
    },
    onSuccess: (secret) => {
      onClose()
      if (secret) onSecret(secret)
    },
    invalidate: [qk.alerts(workspaceId)],
    toast: editing ? 'Destination saved' : 'Destination added',
  })
  const toggle = (group: DestinationDraft['events'][number], on: boolean) =>
    setDraft((current) => ({ ...current, events: on ? [...current.events, group] : current.events.filter((entry) => entry !== group) }))
  return (
    <Modal isOpen onClose={onClose} title={editing ? `Edit ${editing.label}` : 'Add a destination'}>
      <form className="gc-stack" onSubmit={(event) => { event.preventDefault(); save.mutate() }}>
        {!editing && (
          <Segmented label="Destination type" value={draft.kind} onChange={(kind) => setDraft((current) => ({ ...current, kind, target: '' }))} options={[
            { value: 'webhook', label: 'Webhook' },
            { value: 'telegram', label: 'Telegram' },
            { value: 'email', label: 'Email', disabled: !emailAvailable, title: emailAvailable ? undefined : 'Set ANTSEED_GATEWAY_SMTP_URL and ANTSEED_GATEWAY_SMTP_FROM on the gateway host' },
          ]} />
        )}
        {!editing && !emailAvailable && (
          <p className="gc-fineprint">Email needs an SMTP server on the gateway host: set ANTSEED_GATEWAY_SMTP_URL and ANTSEED_GATEWAY_SMTP_FROM, then restart it.</p>
        )}
        <TextField label="Name" required value={draft.label} placeholder={draft.kind === 'webhook' ? 'e.g. Auto top-up' : 'e.g. Ops'}
          onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))} />
        <TextField label={field.label} mono={draft.kind !== 'email'} required={!editing} value={draft.target} placeholder={editing?.kind === 'webhook' ? editing.target : field.placeholder}
          hint={editing?.kind === 'webhook' ? 'Leave empty to keep the saved URL.' : field.hint}
          onChange={(event) => setDraft((current) => ({ ...current, target: event.target.value }))} />
        {draft.kind === 'telegram' && (
          <TextField label="Bot token" mono type="password" autoComplete="off" required={!editing} value={draft.botToken}
            placeholder={editing?.secretHint ? `Saved (${editing.secretHint})` : '123456789:AA…'}
            hint={editing ? 'Leave empty to keep the saved token.' : 'Create a bot with @BotFather. The token stays on the gateway.'}
            onChange={(event) => setDraft((current) => ({ ...current, botToken: event.target.value }))} />
        )}
        <div className="gc-stack gc-stack--tight">
          {ALERT_GROUPS.map((group) => (
            <Switch key={group.id} label={group.label} description={group.description} checked={draft.events.includes(group.id)}
              onChange={(on) => toggle(group.id, on)} />
          ))}
        </div>
        {save.error ? <ErrorAlert error={save.error} title="Could not save the destination" /> : null}
        <div className="gc-actions">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={save.isPending || !destinationReady(draft, editing !== null)}>{editing ? 'Save' : 'Add destination'}</Button>
        </div>
      </form>
    </Modal>
  )
}

function lastDelivery(destination: AlertDestination) {
  if (!destination.enabled) return <Badge>Paused</Badge>
  if (destination.lastError) return <span className="gc-fineprint" title={destination.lastError}>Failed: {destination.lastError}</span>
  if (destination.lastSentAt) return <span className="gc-fineprint">Sent {formatRelative(destination.lastSentAt)}</span>
  return <span className="gc-fineprint">Nothing sent yet</span>
}

function Destinations({ workspaceId, config }: { workspaceId: string; config: AlertsConfig }) {
  const toast = useToast()
  const [dialog, setDialog] = useState<{ editing: AlertDestination | null } | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<AlertDestination | null>(null)
  const [rotating, setRotating] = useState<AlertDestination | null>(null)
  const invalidate = [qk.alerts(workspaceId)]
  const test = useConsoleMutation({
    mutationFn: (destination: AlertDestination) => api.alerts.test(workspaceId, destination.id),
    onSuccess: (result, destination) => toast(result.ok ? `Test alert sent to ${destination.label}` : `Test to ${destination.label} failed: ${result.error}`, result.ok ? 'success' : 'danger'),
    invalidate,
  })
  const enable = useConsoleMutation({
    mutationFn: (destination: AlertDestination) => api.alerts.updateDestination(workspaceId, destination.id, { enabled: !destination.enabled }),
    invalidate,
  })
  const rotate = useConsoleMutation({
    mutationFn: (destination: AlertDestination) => api.alerts.rotateSecret(workspaceId, destination.id),
    onSuccess: (result) => { setRotating(null); setSecret(result.signingSecret) },
    invalidate,
  })
  const remove = useConsoleMutation({
    mutationFn: (destination: AlertDestination) => api.alerts.deleteDestination(workspaceId, destination.id),
    onSuccess: () => setDeleting(null),
    invalidate,
    toast: 'Destination removed',
  })
  return (
    <Panel flush title="Destinations" description="Where this workspace's alerts go. A webhook can trigger an automatic top-up."
      actions={<Button size="sm" variant="brand" leadingIcon={<Icon.plus size={14} />} onClick={() => setDialog({ editing: null })}>Add destination</Button>}>
      <DataTable<AlertDestination> label="Alert destinations" rows={config.destinations} rowKey={(row) => row.id} rowLabel={(row) => row.label}
        empty={<EmptyState icon={<Icon.alerts size={18} />} title="No destinations yet" body="Add a webhook, a Telegram chat or an email address to start getting alerts." />}
        actions={(row) => [
          { label: 'Send a test alert', onSelect: () => test.mutate(row), disabled: test.isPending || !row.enabled },
          { label: 'Edit', onSelect: () => setDialog({ editing: row }) },
          row.kind === 'webhook' && { label: 'New signing secret', onSelect: () => setRotating(row) },
          { label: row.enabled ? 'Pause' : 'Resume', onSelect: () => enable.mutate(row) },
          { label: 'Remove', tone: 'danger' as const, onSelect: () => setDeleting(row) },
        ]}
        columns={[
          { key: 'label', header: 'Name', render: (row) => <span>{row.label} <Badge>{KIND_LABELS[row.kind]}</Badge></span> },
          { key: 'target', header: 'Sends to', secondary: true, render: (row) => <Mono>{row.target}</Mono> },
          { key: 'events', header: 'Alerts', render: (row) => ALERT_GROUPS.filter((group) => row.events.includes(group.id)).map((group) => group.label).join(', ') },
          { key: 'status', header: 'Last delivery', render: lastDelivery },
        ]} />
      {dialog && (
        <DestinationDialog workspaceId={workspaceId} emailAvailable={config.emailAvailable} editing={dialog.editing}
          onClose={() => setDialog(null)} onSecret={setSecret} />
      )}
      <Modal isOpen={secret !== null} onClose={() => setSecret(null)} title="Webhook signing secret">
        {secret && (
          <div className="gc-stack">
            <SecretReveal secret={secret} />
            <p className="gc-fineprint">
              Each delivery carries an <code>x-antseed-signature</code> header. Check it before acting on an alert, for example before an automatic top-up:
            </p>
            <CodeBlock code={WEBHOOK_VERIFY_SNIPPET} />
            <div className="gc-actions"><Button onClick={() => setSecret(null)}>Done</Button></div>
          </div>
        )}
      </Modal>
      <ConfirmDialog isOpen={rotating !== null} busy={rotate.isPending} error={rotate.error} onClose={() => setRotating(null)}
        onConfirm={() => rotating && rotate.mutate(rotating)} title="Make a new signing secret?" confirmLabel="Make new secret"
        body={`Deliveries to ${rotating?.label ?? 'this webhook'} are signed with the new secret at once; the old one stops verifying.`} />
      <ConfirmDialog isOpen={deleting !== null} busy={remove.isPending} error={remove.error} onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting)} title="Remove this destination?" confirmLabel="Remove"
        body={`${deleting?.label ?? 'It'} stops getting alerts.`} />
    </Panel>
  )
}

const EVENT_LABELS: Record<string, string> = {
  'balance.low': 'Credits low',
  'balance.empty': 'Out of credits',
  'balance.ok': 'Credits topped up',
  'limit.near': 'Spend limit near',
  'limit.reached': 'Spend limit reached',
  'spend_tracking.down': 'Spend tracking down',
  'spend_tracking.ok': 'Spend tracking recovered',
  test: 'Test',
}

function Deliveries({ workspaceId, destinations }: { workspaceId: string; destinations: AlertDestination[] }) {
  const deliveries = useQuery({ queryKey: qk.alertDeliveries(workspaceId), queryFn: () => api.alerts.deliveries(workspaceId), refetchInterval: 30_000 })
  const names = new Map(destinations.map((destination) => [destination.id, destination.label]))
  return (
    <Panel flush title="Recent deliveries" description="The latest alerts sent from this workspace, with each retry.">
      <QueryView query={deliveries}>
        {(rows) => (
          <DataTable<AlertDelivery> label="Alert deliveries" rows={rows} rowKey={(row) => String(row.id)}
            empty={<EmptyState icon={<Icon.alerts size={18} />} title="No alerts sent yet" />}
            columns={[
              { key: 'at', header: 'Time', render: (row) => formatDateTime(row.at) },
              { key: 'event', header: 'Alert', render: (row) => <span title={row.summary}>{EVENT_LABELS[row.eventType] ?? row.eventType}</span> },
              { key: 'destination', header: 'Destination', secondary: true, render: (row) => names.get(row.destinationId) ?? 'Removed' },
              { key: 'result', header: 'Result', render: (row) => row.ok ? <Badge tone="success">Delivered</Badge> : <span className="gc-fineprint" title={row.error ?? ''}>Failed: {row.error}</span> },
            ]} />
        )}
      </QueryView>
    </Panel>
  )
}

export default function Alerts() {
  const { workspace } = useConsole()
  const config = useQuery({ queryKey: qk.alerts(workspace.id), queryFn: () => api.alerts.get(workspace.id) })
  return (
    <div className="gc-page">
      <PageHeader title="Alerts" description={`Hear about low credits and spend limits in ${workspace.name} before requests start failing.`} />
      <QueryView query={config}>
        {(data) => (
          <div className="gc-stack">
            <Destinations workspaceId={workspace.id} config={data} />
            <Thresholds workspaceId={workspace.id} settings={data.settings} />
            <Deliveries workspaceId={workspace.id} destinations={data.destinations} />
          </div>
        )}
      </QueryView>
    </div>
  )
}
