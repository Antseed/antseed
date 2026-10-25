import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, Disclosure, Switch, TextField, useToast } from '@antseed/ui'
import { api } from '../api'
import type { SellerSettings, SellerSettingsPatch } from '../api/types'
import { numberFieldError } from '../lib/settings'
import { qk } from '../lib/queries'
import { ErrorAlert } from './ui'

/** Everything the form edits, as typed (numbers stay strings until saved). */
interface Draft {
  displayName: string
  maxConcurrentBuyers: string
  healthEnabled: boolean
  healthIntervalSec: string
  healthThreshold: string
  gasEnabled: boolean
  gasMinEth: string
  freePerAddress: string
  freePerIp: string
  freeWindowHours: string
  countries: string
  prices: Record<string, { input: string; output: string; cached: string }>
}

const priceKey = (provider: string, service: string) => `${provider}/${service}`
const optional = (value: number | null) => (value === null ? '' : String(value))

export function draftOf(settings: SellerSettings): Draft {
  return {
    displayName: settings.displayName,
    maxConcurrentBuyers: String(settings.maxConcurrentBuyers),
    healthEnabled: settings.healthCheck.enabled,
    healthIntervalSec: String(Math.round(settings.healthCheck.intervalMs / 1000)),
    healthThreshold: String(settings.healthCheck.failureThreshold),
    gasEnabled: settings.gasCheck.enabled,
    gasMinEth: String(settings.gasCheck.minBalanceEth),
    freePerAddress: optional(settings.freeTier.maxRequestsPerAddress),
    freePerIp: optional(settings.freeTier.maxRequestsPerIp),
    freeWindowHours: settings.freeTier.windowMs === null ? '' : String(settings.freeTier.windowMs / 3_600_000),
    countries: settings.restrictedCountries.join(', '),
    prices: Object.fromEntries(settings.services.map((entry) => [priceKey(entry.provider, entry.service), {
      input: optional(entry.inputUsdPerMillion), output: optional(entry.outputUsdPerMillion), cached: optional(entry.cachedInputUsdPerMillion),
    }])),
  }
}

export function draftErrors(draft: Draft): Record<string, string> {
  const errors: Record<string, string | undefined> = {
    displayName: draft.displayName.trim().length > 64 ? 'At most 64 characters.' : undefined,
    maxConcurrentBuyers: numberFieldError(draft.maxConcurrentBuyers, { required: true, min: 1, integer: true }),
    healthIntervalSec: numberFieldError(draft.healthIntervalSec, { required: true, min: 10, integer: true }),
    healthThreshold: numberFieldError(draft.healthThreshold, { required: true, min: 1, max: 100, integer: true }),
    gasMinEth: numberFieldError(draft.gasMinEth, { required: true, max: 10 }),
    freePerAddress: numberFieldError(draft.freePerAddress, { min: 1, integer: true }),
    freePerIp: numberFieldError(draft.freePerIp, { min: 1, integer: true }),
    freeWindowHours: numberFieldError(draft.freeWindowHours, { min: 1 / 60 }),
    countries: countryList(draft.countries).some((code) => !/^[A-Z]{2}$/.test(code)) ? 'Two-letter country codes, comma-separated.' : undefined,
  }
  for (const [key, price] of Object.entries(draft.prices)) {
    errors[`${key}:input`] = numberFieldError(price.input, { required: true })
    errors[`${key}:output`] = numberFieldError(price.output, { required: true })
    errors[`${key}:cached`] = numberFieldError(price.cached)
  }
  return Object.fromEntries(Object.entries(errors).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

function countryList(text: string): string[] {
  return text.split(/[\s,]+/).map((code) => code.trim().toUpperCase()).filter(Boolean)
}

const num = (text: string) => Number(text.trim())
const numOrNull = (text: string) => (text.trim() === '' ? null : Number(text.trim()))

/** Only what changed from `base`, in the API's shape. */
export function patchOf(base: Draft, draft: Draft): SellerSettingsPatch {
  const patch: SellerSettingsPatch = {}
  if (draft.displayName !== base.displayName) patch.displayName = draft.displayName.trim()
  if (draft.maxConcurrentBuyers !== base.maxConcurrentBuyers) patch.maxConcurrentBuyers = num(draft.maxConcurrentBuyers)
  if (draft.healthEnabled !== base.healthEnabled || draft.healthIntervalSec !== base.healthIntervalSec || draft.healthThreshold !== base.healthThreshold) {
    patch.healthCheck = { enabled: draft.healthEnabled, intervalMs: num(draft.healthIntervalSec) * 1000, failureThreshold: num(draft.healthThreshold) }
  }
  if (draft.gasEnabled !== base.gasEnabled || draft.gasMinEth !== base.gasMinEth) patch.gasCheck = { enabled: draft.gasEnabled, minBalanceEth: num(draft.gasMinEth) }
  if (draft.freePerAddress !== base.freePerAddress || draft.freePerIp !== base.freePerIp || draft.freeWindowHours !== base.freeWindowHours) {
    const hours = numOrNull(draft.freeWindowHours)
    patch.freeTier = { maxRequestsPerAddress: numOrNull(draft.freePerAddress), maxRequestsPerIp: numOrNull(draft.freePerIp), windowMs: hours === null ? null : Math.round(hours * 3_600_000) }
  }
  if (countryList(draft.countries).join(',') !== countryList(base.countries).join(',')) patch.restrictedCountries = countryList(draft.countries)
  const pricing = Object.entries(draft.prices)
    .filter(([key, price]) => JSON.stringify(price) !== JSON.stringify(base.prices[key]))
    .map(([key, price]) => {
      const [provider, ...rest] = key.split('/')
      return { provider: provider!, service: rest.join('/'), inputUsdPerMillion: num(price.input), outputUsdPerMillion: num(price.output), cachedInputUsdPerMillion: numOrNull(price.cached) }
    })
  if (pricing.length > 0) patch.pricing = pricing
  return patch
}

/** The seller's config.json fields an operator commonly changes. They apply when the seller restarts. */
export function SellerSettingsEditor({ settings }: { settings: SellerSettings }) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [base, setBase] = useState(() => draftOf(settings))
  const [draft, setDraft] = useState(base)
  const [savedPendingRestart, setSavedPendingRestart] = useState(false)
  useEffect(() => {
    const next = draftOf(settings)
    if (JSON.stringify(draft) === JSON.stringify(base)) setDraft(next)
    setBase(next)
    // Only a change of the saved settings should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings])
  const readOnly = !settings.writable
  // Market's "Edit your price" opens Seller settings at `?price=<service>`.
  const [focusPrice] = useState(() => new URLSearchParams(window.location.search).get('price'))
  useEffect(() => {
    if (!focusPrice) return
    const row = document.getElementById(`gc-price-${focusPrice}`)
    row?.scrollIntoView({ block: 'center' })
    row?.querySelector('input')?.focus()
  }, [focusPrice])
  const errors = draftErrors(draft)
  const patch = patchOf(base, draft)
  const changed = Object.keys(patch).length > 0
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }))
  const setPrice = (key: string, part: 'input' | 'output' | 'cached', value: string) =>
    setDraft((current) => ({ ...current, prices: { ...current.prices, [key]: { ...current.prices[key]!, [part]: value } } }))

  const save = useMutation({
    mutationFn: () => api.seller.updateSettings(patch),
    onSuccess: (data) => {
      queryClient.setQueryData(qk.sellerSettings, { settings: data.settings, alerts: data.alerts })
      const next = draftOf(data.settings)
      setBase(next)
      setDraft(next)
      setSavedPendingRestart(true)
      toast('Saved. Restart the seller to apply.')
    },
  })

  const field = (key: keyof Draft, label: string, extra: { hint?: string; placeholder?: string; wide?: boolean } = {}) => (
    <TextField size="sm" className={extra.wide ? 'gc-num gc-num--wide' : 'gc-num'} label={label} inputMode="decimal" placeholder={extra.placeholder} disabled={readOnly}
      value={draft[key] as string} error={errors[key]} hint={extra.hint} onChange={(event) => set(key, event.target.value as never)} />
  )

  return (
    <div className="gc-stack">
      {readOnly && <p className="gc-seller-notice"><span className="gc-attention" aria-hidden="true" />{settings.readOnlyReason}</p>}
      <div className="gc-policy">
        <div className="gc-policy__cols">
          <section className="gc-policy__section">
            <h3>Seller</h3>
            <TextField size="sm" label="Display name" value={draft.displayName} disabled={readOnly} error={errors.displayName}
              hint="Shown to buyers next to your peer id." onChange={(event) => set('displayName', event.target.value)} />
            {field('maxConcurrentBuyers', 'Max concurrent buyers', { wide: true })}
            <TextField size="sm" label="Refused countries" value={draft.countries} disabled={readOnly} error={errors.countries}
              hint={settings.restrictedCountriesDefault ? 'The built-in list. Clear it to refuse none.' : 'Two-letter codes; connections from these IPs are refused.'}
              onChange={(event) => set('countries', event.target.value)} />
          </section>
          <section className="gc-policy__section">
            <h3>Checks</h3>
            <Switch checked={draft.healthEnabled} disabled={readOnly} onChange={(next) => set('healthEnabled', next)} label="Model health checks"
              description="Probe every service; withdraw one that keeps failing until it recovers." />
            <div className="gc-policy__caps">
              {field('healthIntervalSec', 'Every (seconds)')}
              {field('healthThreshold', 'Failures to withdraw')}
            </div>
            <Switch checked={draft.gasEnabled} disabled={readOnly} onChange={(next) => set('gasEnabled', next)} label="Gas checks"
              description="Pause advertising while the wallet cannot pay for settlement." />
            <div className="gc-policy__caps">{field('gasMinEth', 'Minimum ETH', { wide: true })}</div>
          </section>
        </div>
        <div className="gc-policy__advanced">
          <Disclosure title="Pricing" defaultOpen={Boolean(focusPrice)} summary={`${settings.services.length} service${settings.services.length === 1 ? '' : 's'}`}>
            <p className="gc-fineprint">USD per million tokens. A service without its own price uses its provider's defaults until you save one.</p>
            {settings.services.map((entry) => {
              const key = priceKey(entry.provider, entry.service)
              const price = draft.prices[key]!
              return (
                <div key={key} id={`gc-price-${entry.service}`} className="gc-seller-price">
                  <div className="gc-seller-price__name"><span className="gc-ellipsis" title={key}>{entry.service}</span><span className="gc-fineprint">{entry.provider}{entry.inherited ? ' · provider default' : ''}</span></div>
                  <TextField size="sm" className="gc-num" label="Input" inputMode="decimal" disabled={readOnly} value={price.input} error={errors[`${key}:input`]} onChange={(event) => setPrice(key, 'input', event.target.value)} />
                  <TextField size="sm" className="gc-num" label="Output" inputMode="decimal" disabled={readOnly} value={price.output} error={errors[`${key}:output`]} onChange={(event) => setPrice(key, 'output', event.target.value)} />
                  <TextField size="sm" className="gc-num" label="Cached input" inputMode="decimal" placeholder="Same as input" disabled={readOnly} value={price.cached} error={errors[`${key}:cached`]} onChange={(event) => setPrice(key, 'cached', event.target.value)} />
                </div>
              )
            })}
          </Disclosure>
          <Disclosure title="Free tier limits" summary={draft.freePerAddress || draft.freePerIp ? 'Limited' : 'No limits'}>
            <p className="gc-fineprint">For zero-priced services: requests one buyer address or IP may make per window. Empty means no limit.</p>
            <div className="gc-policy__caps">
              {field('freePerAddress', 'Per address', { placeholder: 'No limit' })}
              {field('freePerIp', 'Per IP', { placeholder: 'No limit' })}
              {field('freeWindowHours', 'Window (hours)', { placeholder: '24' })}
            </div>
          </Disclosure>
        </div>
      </div>
      {savedPendingRestart && !changed && (
        <p className="gc-seller-notice" role="status"><span className="gc-attention" aria-hidden="true" />Saved. Restart the seller to apply; the previous config is kept as config.json.bak.</p>
      )}
      {save.error ? <ErrorAlert error={save.error} title="Could not save" /> : null}
      {!readOnly && (
        <div className="gc-actions">
          <span className="gc-fineprint gc-actions__note">{changed ? 'Applies when the seller restarts.' : 'No changes.'}</span>
          <Button variant="ghost" disabled={!changed || save.isPending} onClick={() => setDraft(base)}>Reset</Button>
          <Button disabled={!changed || Object.keys(errors).length > 0 || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</Button>
        </div>
      )}
    </div>
  )
}
