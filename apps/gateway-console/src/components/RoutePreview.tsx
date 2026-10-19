import { Alert } from '@antseed/ui'
import type { ApiKey, Member, Preset, RoutePreview } from '../api/types'
import { useConsole } from '../app/context'
import { isOrgAdmin } from '../lib/nav'
import { exclusionsFor, type LevelExclusion } from '../lib/policy-explain'
import { useFavorites, useKeys, useModels, usePeerLists, usePeers, usePresets, useWorkspaceMembers } from '../lib/queries'
import { useScopeFilter } from '../app/context'
import { ModelChooser } from './ModelChooser'
import { SellerSelection } from './SellerSelection'
import { Badge, EmptyState, ErrorAlert, SelectField } from './ui'

export type PreviewTarget = 'workspace' | 'key' | 'member' | 'preset'

export interface TryRequestState {
  model: string | null
  target: PreviewTarget
  targetId: string
}

type Source = RoutePreview['sources'][number]

export const LEVEL_LABELS: Record<Source['level'], string> = {
  buyer: 'Buyer config', gateway: 'Gateway default', 'workspace-org': 'Organization policy', workspace: 'Workspace policy',
  member: 'Member policy', key: 'Key policy (admin)', 'key-owner': 'Key policy (owner)', preset: 'Preset',
}

type Option = { value: string; label: string }

function targetOptions(target: PreviewTarget, keys: ApiKey[] | undefined, members: Array<{ member: Member }> | undefined, presets: Preset[] | undefined): Option[] {
  if (target === 'key') return (keys ?? []).filter((key) => key.status === 'active').map((key) => ({ value: key.id, label: key.label }))
  if (target === 'member') return (members ?? []).map(({ member }) => ({ value: member.id, label: member.label }))
  if (target === 'preset') return (presets ?? []).map((preset) => ({ value: preset.slug, label: preset.name }))
  return []
}

/** The preview query for a "Try a request" state, or null until it names a model (and the key, member or preset it is for). */
export function previewQuery(state: TryRequestState, workspaceId: string): Record<string, string> | null {
  if (!state.model) return null
  if (state.target !== 'workspace' && !state.targetId) return null
  return { model: state.model, workspace: workspaceId, ...(state.target !== 'workspace' ? { [state.target]: state.targetId } : {}) }
}

function Exclusions({ exclusions }: { exclusions: LevelExclusion[] }) {
  if (exclusions.length === 0) return null
  return (
    <span className="gc-fineprint">
      {exclusions.map((entry, index) => (
        <span key={`${entry.level}-${index}`}>{index > 0 ? '; ' : ''}<strong>{LEVEL_LABELS[entry.level]}</strong> {entry.rule}</span>
      ))}
    </span>
  )
}

/**
 * Pick a model (and, optionally, a key, member or preset) and see at once
 * which sellers a request would go to, in order and why, and which rule
 * keeps each of the others out. The Routing page shows it in a dialog.
 */
export function TryRequest({ state, onChange, preview }: {
  state: TryRequestState
  onChange: (state: TryRequestState) => void
  preview: { data: RoutePreview | undefined; isFetching: boolean; error: unknown }
}) {
  const { workspace, viewer } = useConsole()
  const scope = useScopeFilter()
  const models = useModels()
  const favorites = useFavorites()
  const peers = usePeers()
  const lists = usePeerLists()
  const keys = useKeys(scope, state.target === 'key')
  const members = useWorkspaceMembers(workspace.id, state.target === 'member')
  const presets = usePresets(workspace.id, state.target === 'preset')
  const options = targetOptions(state.target, keys.data, members.data, presets.data)
  const data = preview.data
  const eligible = data?.candidates.filter((candidate) => candidate.eligible).length ?? 0
  const modelRule = data && !data.modelAllowed
    ? data.sources.filter((source) => source.policy?.allowedModels && !source.policy.allowedModels.some((model) => model.toLowerCase() === data.model.toLowerCase()))
    : []

  return (
    <div className="gc-stack">
      <div className="gc-toolbar">
        <ModelChooser models={models.data} loading={models.isLoading} value={state.model} favorites={favorites.data}
          onChange={(model) => onChange({ ...state, model })} />
        <SelectField size="sm" aria-label="Request from" value={state.target} onChange={(value) => onChange({ ...state, target: value as PreviewTarget, targetId: '' })}
          options={[
            { value: 'workspace', label: `From workspace ${workspace.name}` },
            { value: 'key', label: 'From a key' },
            ...(isOrgAdmin(viewer) ? [{ value: 'member', label: 'From a member' }] : []),
            { value: 'preset', label: 'With a preset' },
          ]} />
        {state.target !== 'workspace' && (
          <SelectField size="sm" aria-label={`Choose a ${state.target}`} value={state.targetId} onChange={(targetId) => onChange({ ...state, targetId })}
            options={[{ value: '', label: `Choose a ${state.target}` }, ...options]} />
        )}
      </div>
      {preview.error ? <ErrorAlert error={preview.error} /> : null}
      {!state.model && <EmptyState title="Pick a model" body="The preview shows the sellers a request for it would use." />}
      {data && !data.modelAllowed && (
        <Alert tone="danger" title={`${data.model} is not allowed`}>
          {modelRule.length
            ? <>{modelRule.map((source) => LEVEL_LABELS[source.level]).join(' and ')} only allow{modelRule.length === 1 ? 's' : ''} {modelRule[0]!.policy!.allowedModels!.join(', ') || 'no model'}. Requests for {data.model} get a 403.</>
            : <>Requests for {data.model} get a 403.</>}
        </Alert>
      )}
      {data && data.modelAllowed && (
        <div className="gc-stack gc-stack--tight">
          <p className="gc-try__summary">
            <Badge tone={eligible > 0 ? 'success' : 'warning'}>{eligible} of {data.candidates.length}</Badge>{' '}
            {eligible > 0 ? `sellers can serve ${data.model}.` : `No seller can serve ${data.model} with these rules.`}
          </p>
          <SellerSelection title="Sellers, in the order they are tried" preview={data} loading={preview.isFetching && !data} skippedOpen
            explainSkipped={(candidate) => <Exclusions exclusions={exclusionsFor(data, candidate, peers.data, lists.data ?? [])} />} />
        </div>
      )}
    </div>
  )
}
