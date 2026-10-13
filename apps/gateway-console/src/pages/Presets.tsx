import { useState } from 'react'
import { Button, DataTable, Modal, TextField } from '@antseed/ui'
import { api, type PresetInput } from '../api'
import type { Preset } from '../api/types'
import { useConsole } from '../app/context'
import { usePolicySaveGuard } from '../components/PolicySaveGuard'
import { Icon } from '../components/icons'
import { PolicyFieldset, usePolicyDraft } from '../components/PolicyField'
import { Badge, ConfirmDialog, CopyButton, EmptyState, ErrorAlert, Mono, PageHeader, Panel, QueryView, SelectField, TextAreaField } from '../components/ui'
import { useConsoleMutation } from '../lib/mutations'
import { isOrgAdmin, isWorkspaceAdmin } from '../lib/nav'
import { describePolicy } from '../lib/policy'
import { isValidSlug, parseParams, slugify } from '../lib/presets'
import { modelsFromPeers, qk, usePeers, usePresets } from '../lib/queries'

/** Create or edit a preset; `prefill` starts a new one (e.g. from a seller's model). `onDone` gets the saved preset. */
export function PresetForm({ initial, prefill, onDone }: { initial: Preset | null; prefill?: { name: string; model: string }; onDone: (saved?: Preset) => void }) {
  const { workspace, viewer } = useConsole()
  const peers = usePeers()
  const [name, setName] = useState(initial?.name ?? prefill?.name ?? '')
  const [slug, setSlug] = useState(initial?.slug ?? (prefill ? slugify(prefill.name) : ''))
  const [slugTouched, setSlugTouched] = useState(!!initial)
  const [model, setModel] = useState(initial?.model ?? prefill?.model ?? '')
  const [scope, setScope] = useState<string>(initial ? initial.workspaceId ?? '' : workspace.id)
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? '')
  const [params, setParams] = useState(initial && Object.keys(initial.params).length ? JSON.stringify(initial.params, null, 2) : '')
  const policy = usePolicyDraft(initial?.routingPolicy)
  const guard = usePolicySaveGuard()
  const save = useConsoleMutation({
    mutationFn: () => {
      if (!isValidSlug(slug)) throw new Error('Slug must be lowercase letters, numbers and dashes.')
      const input: PresetInput = {
        name: name.trim(), slug, model: model.trim(), workspaceId: scope || null,
        systemPrompt: systemPrompt.trim() || null, params: parseParams(params), routingPolicy: policy.build(),
      }
      return guard.save([input.routingPolicy], (options) => (initial ? api.presets.update(initial.id, input, options) : api.presets.create(input, options)))
    },
    onSuccess: (saved) => onDone(saved),
    invalidate: [qk.group('presets')],
    toast: 'Preset saved',
  })
  return (
    <form className="gc-stack" onSubmit={(event) => { event.preventDefault(); save.mutate() }}>
      <div className="gc-grid gc-grid--2">
        <TextField label="Name" required value={name} onChange={(event) => { setName(event.target.value); if (!slugTouched) setSlug(slugify(event.target.value)) }} />
        <TextField label="Slug" required value={slug} onChange={(event) => { setSlugTouched(true); setSlug(event.target.value) }}
          hint={<>Called as <code>@preset/{slug || 'slug'}</code></>} />
      </div>
      <div className="gc-grid gc-grid--2">
        <TextField label="Model" required list="gc-preset-models" value={model} onChange={(event) => setModel(event.target.value)} />
        <datalist id="gc-preset-models">{modelsFromPeers(peers.data).map((entry) => <option key={entry} value={entry} />)}</datalist>
        <SelectField label="Available in" value={scope} onChange={setScope}
          options={[{ value: workspace.id, label: `${workspace.name} workspace` }, ...(isOrgAdmin(viewer) ? [{ value: '', label: 'All workspaces' }] : [])]} />
      </div>
      <TextAreaField label="System prompt" rows={4} value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)}
        hint="Added before the client's messages." />
      <TextAreaField label="Parameters (JSON)" rows={4} mono value={params} placeholder={'{\n  "temperature": 0.2,\n  "max_tokens": 2048\n}'}
        onChange={(event) => setParams(event.target.value)} hint="Defaults merged under the client's own parameters." />
      <PolicyFieldset draft={policy.draft} setDraft={policy.setDraft} />
      {save.error ? <ErrorAlert error={save.error} title="Could not save the preset" /> : null}
      <div className="gc-actions">
        <Button variant="ghost" onClick={() => onDone()}>Cancel</Button>
        <Button type="submit" disabled={save.isPending || !name.trim() || !model.trim()}>{save.isPending ? 'Saving…' : 'Save preset'}</Button>
      </div>
      {guard.dialog}
    </form>
  )
}

export default function Presets() {
  const { workspace, viewer } = useConsole()
  const canEdit = isWorkspaceAdmin(viewer)
  const presets = usePresets(workspace.id)
  const [editing, setEditing] = useState<Preset | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Preset | null>(null)
  const remove = useConsoleMutation({
    mutationFn: (preset: Preset) => api.presets.remove(preset.id),
    onSuccess: () => setDeleting(null),
    invalidate: [qk.group('presets')],
  })
  return (
    <div className="gc-page">
      <PageHeader title="Presets" description={<>A saved model, prompt, parameters and routing. Use one by sending <code>"model": "@preset/&lt;slug&gt;"</code>.</>}
        actions={canEdit && <Button variant="brand" leadingIcon={<Icon.plus size={14} />} onClick={() => setEditing('new')}>New preset</Button>} />
      <Panel flush>
        <QueryView query={presets}>
          {(rows) => (
            <DataTable<Preset> label="Presets" rows={rows} rowKey={(preset) => preset.id} rowLabel={(preset) => preset.name}
              actions={(preset) => canEdit && (preset.workspaceId || isOrgAdmin(viewer)) ? [
                { label: 'Edit', onSelect: () => setEditing(preset) },
                { label: 'Delete', tone: 'danger' as const, onSelect: () => setDeleting(preset) },
              ] : []}
              empty={<EmptyState icon={<Icon.presets size={18} />} title="No presets yet" body="Presets let every client share one tuned setup without changing code." />}
              columns={[
                { key: 'name', header: 'Name', render: (preset) => <span className="gc-strong">{preset.name}</span> },
                { key: 'usage', header: 'Use as model', render: (preset) => (
                  <span className="gc-inline gc-inline--wrap"><Mono>@preset/{preset.slug}</Mono><CopyButton value={`@preset/${preset.slug}`} /></span>
                ) },
                { key: 'model', header: 'Model', secondary: true, render: (preset) => preset.model },
                { key: 'scope', header: 'Scope', secondary: true, render: (preset) => preset.workspaceId ? <Badge>Workspace</Badge> : <Badge tone="info">All workspaces</Badge> },
                { key: 'policy', header: 'Routing', secondary: true, optional: true, render: (preset) => <span className="gc-muted">{describePolicy(preset.routingPolicy)}</span> },
              ]} />
          )}
        </QueryView>
      </Panel>
      <Modal isOpen={editing !== null} onClose={() => setEditing(null)} size="lg" title={editing === 'new' ? 'New preset' : 'Edit preset'}>
        {editing !== null && <PresetForm initial={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />}
      </Modal>
      <ConfirmDialog isOpen={deleting !== null} busy={remove.isPending} error={remove.error} onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting)} title="Delete this preset?" confirmLabel="Delete preset"
        body={<>Requests that use <code>@preset/{deleting?.slug}</code> will fail.</>} />
    </div>
  )
}
