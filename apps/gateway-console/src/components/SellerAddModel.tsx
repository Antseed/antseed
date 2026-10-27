import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Button, SelectField, TextField } from '@antseed/ui'
import { api } from '../api'
import type { SellerSettingsResponse } from '../api/client'
import type { SellerSettings } from '../api/types'
import { numberFieldError } from '../lib/settings'
import { ErrorAlert } from './ui'

interface NewModelDraft { provider: string; service: string; upstreamModel: string; input: string; output: string; cached: string; categories: string }

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/

/** The new model's field errors, or none. */
export function newModelErrors(draft: NewModelDraft, settings: SellerSettings): Record<string, string> {
  const errors: Record<string, string | undefined> = {
    service: !draft.service.trim() ? 'Required.'
      : !MODEL_ID.test(draft.service.trim()) ? 'Letters, digits and . _ : / @ + - only.'
        : settings.services.some((entry) => entry.provider === draft.provider && entry.service === draft.service.trim()) ? 'Already offered under this provider.' : undefined,
    input: numberFieldError(draft.input, { required: true }),
    output: numberFieldError(draft.output, { required: true }),
    cached: numberFieldError(draft.cached),
  }
  return Object.fromEntries(Object.entries(errors).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

/**
 * Adds a model billed by tokens under a configured provider, saved at once.
 * Image and video providers are left out: their models need capabilities and
 * unit prices, which are written in the config file.
 */
export function SellerAddModel({ settings, onSaved }: { settings: SellerSettings; onSaved: (data: SellerSettingsResponse, message: string) => void }) {
  const providers = settings.providers.filter((provider) => !provider.unitBilled)
  const empty = (provider = providers[0]?.name ?? ''): NewModelDraft => ({ provider, service: '', upstreamModel: '', input: '', output: '', cached: '', categories: '' })
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(empty)
  const [touched, setTouched] = useState(false)
  const add = useMutation({
    mutationFn: (submitted: NewModelDraft) => api.seller.updateSettings({
      addServices: [{
        provider: submitted.provider,
        service: submitted.service.trim(),
        ...(submitted.upstreamModel.trim() ? { upstreamModel: submitted.upstreamModel.trim() } : {}),
        ...(submitted.categories.trim() ? { categories: submitted.categories.split(',').map((category) => category.trim()).filter(Boolean) } : {}),
        inputUsdPerMillion: Number(submitted.input),
        outputUsdPerMillion: Number(submitted.output),
        ...(submitted.cached.trim() ? { cachedInputUsdPerMillion: Number(submitted.cached) } : {}),
      }],
    }),
    onSuccess: (data, submitted) => {
      onSaved(data, `Added ${submitted.service.trim()}. Restart the seller to offer it.`)
      setDraft(empty(submitted.provider))
      setTouched(false)
      setOpen(false)
    },
  })
  if (providers.length === 0) return null
  if (!open) return <div><Button size="sm" variant="outline" onClick={() => setOpen(true)}>Add model</Button></div>
  const errors = touched ? newModelErrors(draft, settings) : {}
  const set = (key: keyof NewModelDraft) => (event: { target: { value: string } }) => setDraft((current) => ({ ...current, [key]: event.target.value }))
  return (
    <section className="gc-seller-add" aria-label="Add a model">
      <h4>Add a model</h4>
      <p className="gc-fineprint">A model billed by tokens, served by one of your providers. Image and video models are added in the config file, with their capabilities and unit prices.</p>
      <div className="gc-policy__caps">
        {providers.length > 1 && (
          <SelectField size="sm" label="Provider" value={draft.provider} onChange={(provider) => setDraft((current) => ({ ...current, provider }))}
            options={providers.map((provider) => ({ value: provider.name, label: `${provider.name} (${provider.plugin})` }))} />
        )}
        <TextField size="sm" className="gc-seller-add__id" label="Model id" placeholder="deepseek-v4.2" value={draft.service} error={errors.service} hint="What buyers ask for." onChange={set('service')} />
        <TextField size="sm" className="gc-seller-add__id" label="Upstream model" placeholder="Same as the model id" value={draft.upstreamModel} hint="The id the provider's API knows it by." onChange={set('upstreamModel')} />
      </div>
      <div className="gc-policy__caps">
        <TextField size="sm" className="gc-num" label="Input" inputMode="decimal" value={draft.input} error={errors.input} onChange={set('input')} />
        <TextField size="sm" className="gc-num" label="Output" inputMode="decimal" value={draft.output} error={errors.output} onChange={set('output')} />
        <TextField size="sm" className="gc-num" label="Cached input" inputMode="decimal" placeholder="Same as input" value={draft.cached} error={errors.cached} onChange={set('cached')} />
        <TextField size="sm" label="Categories" placeholder="chat, coding" value={draft.categories} onChange={set('categories')} />
      </div>
      {add.error ? <ErrorAlert error={add.error} title="Could not add the model" /> : null}
      <div className="gc-actions">
        <span className="gc-fineprint gc-actions__note">USD per million tokens. Offered when the seller restarts.</span>
        <Button variant="ghost" disabled={add.isPending} onClick={() => { setOpen(false); setDraft(empty(draft.provider)); setTouched(false); add.reset() }}>Cancel</Button>
        <Button disabled={add.isPending} onClick={() => {
          setTouched(true)
          if (Object.keys(newModelErrors(draft, settings)).length === 0) add.mutate(draft)
        }}>{add.isPending ? 'Adding…' : 'Add model'}</Button>
      </div>
    </section>
  )
}
