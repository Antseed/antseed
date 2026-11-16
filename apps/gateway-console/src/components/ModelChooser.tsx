import { useMemo, useState } from 'react'
import { BrandIcon, Button, Modal, TextField } from '@antseed/ui'
import type { NetworkModel } from '../api/types'
import { formatPriceRange } from '../lib/format'
import { MODEL_TYPE_LABELS } from '../lib/models'
import { Icon } from './icons'
import { Badge, EmptyState, LoadingRows } from './ui'

function matches(model: NetworkModel, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return [model.id, model.name, ...model.aliases, ...model.tags].some((value) => value.toLowerCase().includes(q))
}

/**
 * Picks a model from the network's list by name, id, alias or tag: a button
 * showing the current model that opens a searchable list, starred models
 * first, then the most offered.
 */
export function ModelChooser({ models, loading, value, onChange, favorites = [], label = 'Model' }: {
  models: readonly NetworkModel[] | undefined
  loading: boolean
  value: string | null
  onChange: (modelId: string) => void
  favorites?: readonly string[]
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const current = models?.find((model) => model.id === value) ?? null
  const starred = useMemo(() => new Set(favorites.map((id) => id.toLowerCase())), [favorites])
  const shown = useMemo(() => [...(models ?? [])]
    .filter((model) => matches(model, query.trim()))
    .sort((a, b) => Number(starred.has(b.id.toLowerCase())) - Number(starred.has(a.id.toLowerCase())) || b.offers.length - a.offers.length || a.name.localeCompare(b.name)),
  [models, query, starred])
  const pick = (id: string) => { onChange(id); setOpen(false); setQuery('') }
  return (
    <>
      <Button variant="outline" size="sm" className="gc-model-chooser" aria-label={`${label}: ${current?.name ?? value ?? 'none'}`} onClick={() => setOpen(true)}>
        <span className="gc-model-chooser__mark" aria-hidden="true">{current ? <BrandIcon name={current.id} hints={[current.name]} size={16} /> : <Icon.models size={15} />}</span>
        <span className="gc-ellipsis">{current?.name ?? value ?? 'Choose a model'}</span>
        <span className="gc-model-chooser__caret" aria-hidden="true"><Icon.down size={14} /></span>
      </Button>
      <Modal isOpen={open} onClose={() => setOpen(false)} title="Choose a model" size="md">
        <div className="gc-stack gc-stack--tight">
          <TextField size="sm" type="search" autoFocus aria-label="Search models" placeholder="Search by name, id or tag" value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && shown[0]) pick(shown[0].id) }} />
          {loading ? <LoadingRows rows={5} /> : shown.length === 0 ? <EmptyState title="No model matches" /> : (
            <ul className="gc-choice-list" aria-label="Models">
              {shown.map((model) => (
                <li key={model.id}>
                  <button type="button" className={model.id === value ? 'gc-choice gc-choice--on' : 'gc-choice'} onClick={() => pick(model.id)}>
                    <BrandIcon name={model.id} hints={[model.name]} size={18} />
                    <span className="gc-choice__main">
                      <span className="gc-choice__title">{model.name}{starred.has(model.id.toLowerCase()) && <Icon.starFilled size={12} />}</span>
                      <span className="gc-choice__meta">
                        {model.name !== model.id && <code>{model.id}</code>}
                        <span>{MODEL_TYPE_LABELS[model.type]}</span>
                        <span>{model.offers.length} provider{model.offers.length === 1 ? '' : 's'}</span>
                        {model.inputUsdPerMillion && <span>{formatPriceRange(model.inputUsdPerMillion)}/M in</span>}
                      </span>
                    </span>
                    {model.free && <Badge tone="success">Free</Badge>}
                    {!model.free && model.freeForStakers && <Badge tone="success">Free for stakers</Badge>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Modal>
    </>
  )
}
