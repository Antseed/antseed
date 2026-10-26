import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, Disclosure, Segmented, Switch, TextField, useToast } from '@antseed/ui'
import { api } from '../api'
import type { FreeTierProgramView, SellerFreeTierProgramPatch, SellerFreeTierProgramSettings, SellerSettings, SellerSettingsPatch } from '../api/types'
import { freeTierHeadline, tierAnts, tierMultiplier } from '../lib/free-tier'
import { numberFieldError, rebaseDraft } from '../lib/settings'
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
  freeStakersOnly: boolean
  /** Staked tiers of the seller-wide program: the network's, these, or none. */
  freeTiersMode: TiersMode
  freeTiers: TierDraft[]
  countries: string
  prices: Record<string, { input: string; output: string; cached: string }>
  /** Each model's own free-tier program, by provider/service. */
  free: Record<string, OwnFreeDraft>
}

type TiersMode = 'default' | 'custom' | 'off'
/** A staked tier as typed: the ANTS it takes locked for a year, and its multiplier ("unlimited" allowed). */
interface TierDraft { ants: string; multiplier: string }
interface OwnFreeDraft { enabled: boolean; perAddress: string; perIp: string; hours: string; stakersOnly: boolean }

/** Tiers are staking power: ANTS × weeks of lock remaining, shown as ANTS locked for a year (52 weeks). */
const WEEKS_PER_YEAR = 52
const MAX_TIERS = 4

const priceKey = (provider: string, service: string) => `${provider}/${service}`
const optional = (value: number | null) => (value === null ? '' : String(value))
const hoursOf = (windowMs: number | null) => (windowMs === null ? '' : String(windowMs / 3_600_000))

const ownFreeDraft = (program: SellerFreeTierProgramSettings | null): OwnFreeDraft => ({
  enabled: program !== null,
  perAddress: optional(program?.maxRequestsPerAddress ?? null),
  perIp: optional(program?.maxRequestsPerIp ?? null),
  hours: hoursOf(program?.windowMs ?? null),
  stakersOnly: program?.stakersOnly ?? false,
})

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
    freeWindowHours: hoursOf(settings.freeTier.windowMs),
    freeStakersOnly: settings.freeTier.stakersOnly,
    freeTiersMode: settings.freeTier.stakeTiers === null ? 'default' : settings.freeTier.stakeTiers.length === 0 ? 'off' : 'custom',
    freeTiers: (settings.freeTier.stakeTiers?.length ? settings.freeTier.stakeTiers : settings.defaultStakeTiers).map((tier) => ({
      ants: String(Math.round(tier.minPower / WEEKS_PER_YEAR)), multiplier: String(tier.multiplier),
    })),
    countries: settings.restrictedCountries.join(', '),
    prices: Object.fromEntries(settings.services.map((entry) => [priceKey(entry.provider, entry.service), {
      input: optional(entry.inputUsdPerMillion), output: optional(entry.outputUsdPerMillion), cached: optional(entry.cachedInputUsdPerMillion),
    }])),
    free: Object.fromEntries(settings.services.map((entry) => [priceKey(entry.provider, entry.service), ownFreeDraft(entry.ownFreeTier)])),
  }
}

/** Prices are required only on rows being changed: an unpriced row left alone does not block saving. */
export function draftErrors(draft: Draft, base?: Draft): Record<string, string> {
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
    if (base && JSON.stringify(price) === JSON.stringify(base.prices[key])) continue
    errors[`${key}:input`] = numberFieldError(price.input, { required: true })
    errors[`${key}:output`] = numberFieldError(price.output, { required: true })
    errors[`${key}:cached`] = numberFieldError(price.cached)
  }
  if (draft.freeTiersMode === 'custom') {
    if (draft.freeTiers.length === 0) errors.freeTiers = 'Add a tier, or pick the network default or none.'
    draft.freeTiers.forEach((tier, index) => {
      errors[`tier${index}:ants`] = numberFieldError(tier.ants, { required: true, min: 1, integer: true })
      errors[`tier${index}:multiplier`] = tier.multiplier.trim().toLowerCase() === 'unlimited' ? undefined : numberFieldError(tier.multiplier, { required: true, min: 1, integer: true })
    })
  }
  for (const [key, own] of Object.entries(draft.free)) {
    if (!own.enabled || (base && JSON.stringify(own) === JSON.stringify(base.free[key]))) continue
    errors[`${key}:freeAddress`] = numberFieldError(own.perAddress, { min: 1, integer: true })
    errors[`${key}:freeIp`] = numberFieldError(own.perIp, { min: 1, integer: true })
    errors[`${key}:freeHours`] = numberFieldError(own.hours, { min: 1 / 60 })
    if (!errors[`${key}:freeAddress`] && !errors[`${key}:freeIp`] && own.perAddress.trim() === '' && own.perIp.trim() === '') errors[`${key}:freeAddress`] = 'Set a limit per address, per IP, or both.'
  }
  return Object.fromEntries(Object.entries(errors).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

function countryList(text: string): string[] {
  return text.split(/[\s,]+/).map((code) => code.trim().toUpperCase()).filter(Boolean)
}

const num = (text: string) => Number(text.trim())
const numOrNull = (text: string) => (text.trim() === '' ? null : Number(text.trim()))

/**
 * The draft after the saved settings changed underneath it: fields and price
 * rows the operator edited keep their edits, everything else (rows for
 * services added or removed since included) takes the new saved values.
 */
export function reconcileDraft(draft: Draft, base: Draft, next: Draft): Draft {
  return { ...rebaseDraft(draft, base, next), prices: rebaseDraft(draft.prices, base.prices, next.prices), free: rebaseDraft(draft.free, base.free, next.free) }
}

const windowOf = (hours: string) => {
  const value = numOrNull(hours)
  return value === null ? null : Math.round(value * 3_600_000)
}

const tiersOf = (draft: Draft): SellerFreeTierProgramPatch['stakeTiers'] => {
  if (draft.freeTiersMode === 'default') return null
  if (draft.freeTiersMode === 'off') return []
  return draft.freeTiers.map((tier) => ({
    minPower: Math.round(num(tier.ants) * WEEKS_PER_YEAR),
    multiplier: tier.multiplier.trim().toLowerCase() === 'unlimited' ? 'unlimited' as const : num(tier.multiplier),
  }))
}

/** What buyers of this model get now, in a line: "1,000 free requests a day, then paid · staked: 10,000 ANTS 5×, …". */
export function freeTierLine(program: FreeTierProgramView | null, paid: boolean): string {
  if (!program) return paid ? 'No free allowance' : 'Free, no limit'
  const tiers = program.stakeTiers.map((tier) => `${tierAnts(tier)} ${tierMultiplier(tier)}`).join(', ')
  return `${freeTierHeadline(program, paid)}${tiers ? ` · staked: ${tiers}` : ''}`
}

/** Only what changed from `base`, in the API's shape. */
export function patchOf(base: Draft, draft: Draft): SellerSettingsPatch {
  const patch: SellerSettingsPatch = {}
  if (draft.displayName !== base.displayName) patch.displayName = draft.displayName.trim()
  if (draft.maxConcurrentBuyers !== base.maxConcurrentBuyers) patch.maxConcurrentBuyers = num(draft.maxConcurrentBuyers)
  if (draft.healthEnabled !== base.healthEnabled || draft.healthIntervalSec !== base.healthIntervalSec || draft.healthThreshold !== base.healthThreshold) {
    patch.healthCheck = { enabled: draft.healthEnabled, intervalMs: num(draft.healthIntervalSec) * 1000, failureThreshold: num(draft.healthThreshold) }
  }
  if (draft.gasEnabled !== base.gasEnabled || draft.gasMinEth !== base.gasMinEth) patch.gasCheck = { enabled: draft.gasEnabled, minBalanceEth: num(draft.gasMinEth) }
  const freeKeys = ['freePerAddress', 'freePerIp', 'freeWindowHours', 'freeStakersOnly', 'freeTiersMode', 'freeTiers'] as const
  if (freeKeys.some((key) => JSON.stringify(draft[key]) !== JSON.stringify(base[key]))) {
    patch.freeTier = {
      maxRequestsPerAddress: numOrNull(draft.freePerAddress), maxRequestsPerIp: numOrNull(draft.freePerIp), windowMs: windowOf(draft.freeWindowHours),
      stakersOnly: draft.freeStakersOnly, stakeTiers: tiersOf(draft),
    }
  }
  if (countryList(draft.countries).join(',') !== countryList(base.countries).join(',')) patch.restrictedCountries = countryList(draft.countries)
  const pricing: NonNullable<SellerSettingsPatch['pricing']> = []
  for (const key of Object.keys(draft.prices)) {
    const price = draft.prices[key]!
    const own = draft.free[key]
    const priceChanged = JSON.stringify(price) !== JSON.stringify(base.prices[key])
    const freeChanged = own !== undefined && JSON.stringify(own) !== JSON.stringify(base.free[key])
    if (!priceChanged && !freeChanged) continue
    const [provider, ...rest] = key.split('/')
    pricing.push({
      provider: provider!, service: rest.join('/'),
      ...(priceChanged ? { inputUsdPerMillion: num(price.input), outputUsdPerMillion: num(price.output), cachedInputUsdPerMillion: numOrNull(price.cached) } : {}),
      // A model's own program keeps any staked tiers written in the file; turning it on uses the network's.
      ...(freeChanged ? { freeTier: own.enabled ? { maxRequestsPerAddress: numOrNull(own.perAddress), maxRequestsPerIp: numOrNull(own.perIp), windowMs: windowOf(own.hours), stakersOnly: own.stakersOnly } : null } : {}),
    })
  }
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
    setDraft(reconcileDraft(draft, base, next))
    setBase(next)
    // Only a change of the saved settings should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings])
  const readOnly = !settings.writable
  // Market's "Edit your price" opens Seller settings at `?price=<provider>/<service>`.
  const [focusPrice] = useState(() => new URLSearchParams(window.location.search).get('price'))
  useEffect(() => {
    if (!focusPrice) return
    const row = document.getElementById(`gc-price-${focusPrice}`)
    row?.scrollIntoView({ block: 'center' })
    row?.querySelector('input')?.focus()
  }, [focusPrice])
  // Until the effect above catches up, a service new in `settings` shows its saved price.
  const savedPrices = draftOf(settings).prices
  const errors = draftErrors(draft, base)
  const patch = patchOf(base, draft)
  const changed = Object.keys(patch).length > 0
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }))
  const setPrice = (key: string, part: 'input' | 'output' | 'cached', value: string) =>
    setDraft((current) => ({ ...current, prices: { ...current.prices, [key]: { ...(current.prices[key] ?? savedPrices[key]!), [part]: value } } }))
  const savedFree = draftOf(settings).free
  const setFree = <K extends keyof OwnFreeDraft>(key: string, part: K, value: OwnFreeDraft[K]) =>
    setDraft((current) => ({ ...current, free: { ...current.free, [key]: { ...(current.free[key] ?? savedFree[key]!), [part]: value } } }))
  const setTier = (index: number, part: keyof TierDraft, value: string) =>
    setDraft((current) => ({ ...current, freeTiers: current.freeTiers.map((tier, at) => (at === index ? { ...tier, [part]: value } : tier)) }))

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
            <p className="gc-fineprint">USD per million tokens. A service without its own price uses its provider's defaults until you save one. A model's own free tier is a free allowance on a paid model, and replaces the seller-wide free tier on a free one.</p>
            {settings.services.map((entry) => {
              const key = priceKey(entry.provider, entry.service)
              const price = draft.prices[key] ?? savedPrices[key]!
              const own = draft.free[key] ?? savedFree[key]!
              return (
                <div key={key} id={`gc-price-${key}`} className="gc-seller-price">
                  <div className="gc-seller-price__name"><span className="gc-ellipsis" title={key}>{entry.service}</span><span className="gc-fineprint">{entry.provider}{entry.inherited ? ' · provider default' : ''}</span></div>
                  <TextField size="sm" className="gc-num" label="Input" inputMode="decimal" disabled={readOnly} value={price.input} error={errors[`${key}:input`]} onChange={(event) => setPrice(key, 'input', event.target.value)} />
                  <TextField size="sm" className="gc-num" label="Output" inputMode="decimal" disabled={readOnly} value={price.output} error={errors[`${key}:output`]} onChange={(event) => setPrice(key, 'output', event.target.value)} />
                  <TextField size="sm" className="gc-num" label="Cached input" inputMode="decimal" placeholder="Same as input" disabled={readOnly} value={price.cached} error={errors[`${key}:cached`]} onChange={(event) => setPrice(key, 'cached', event.target.value)} />
                  <div className="gc-seller-price__free">
                    <Switch checked={own.enabled} disabled={readOnly} onChange={(next) => setFree(key, 'enabled', next)} label="Own free tier"
                      description={freeTierLine(entry.freeTier, entry.paid)} />
                    {own.enabled && (
                      <>
                        <div className="gc-policy__caps">
                          <TextField size="sm" className="gc-num" label="Per address" inputMode="decimal" placeholder="No limit" disabled={readOnly} value={own.perAddress} error={errors[`${key}:freeAddress`]} onChange={(event) => setFree(key, 'perAddress', event.target.value)} />
                          <TextField size="sm" className="gc-num" label="Per IP" inputMode="decimal" placeholder="No limit" disabled={readOnly} value={own.perIp} error={errors[`${key}:freeIp`]} onChange={(event) => setFree(key, 'perIp', event.target.value)} />
                          <TextField size="sm" className="gc-num" label="Window (hours)" inputMode="decimal" placeholder="24" disabled={readOnly} value={own.hours} error={errors[`${key}:freeHours`]} onChange={(event) => setFree(key, 'hours', event.target.value)} />
                        </div>
                        <Switch checked={own.stakersOnly} disabled={readOnly} onChange={(next) => setFree(key, 'stakersOnly', next)} label="Stakers only"
                          description={entry.paid ? 'Only buyers staked on you get the allowance; everyone else pays.' : 'Only buyers staked on you are served.'} />
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </Disclosure>
          <Disclosure title="Free tier" summary={draft.freePerAddress || draft.freePerIp ? (draft.freeStakersOnly ? 'Stakers only' : 'Limited') : 'No limits'}>
            <p className="gc-fineprint">For free models without their own free tier: requests one buyer address or IP may make per window. Empty means no limit. Buyers staked on you get more, by staked tier.</p>
            <div className="gc-policy__caps">
              {field('freePerAddress', 'Per address', { placeholder: 'No limit' })}
              {field('freePerIp', 'Per IP', { placeholder: 'No limit' })}
              {field('freeWindowHours', 'Window (hours)', { placeholder: '24' })}
            </div>
            <Switch checked={draft.freeStakersOnly} disabled={readOnly} onChange={(next) => set('freeStakersOnly', next)} label="Stakers only"
              description="Serve free models only to buyers whose stake reaches a tier; the limits above are what the multipliers apply to." />
            <Segmented label="Staked tiers" value={draft.freeTiersMode} onChange={(mode) => set('freeTiersMode', mode)}
              options={[{ value: 'default', label: 'Network default' }, { value: 'custom', label: 'Custom' }, { value: 'off', label: 'None' }]} />
            {draft.freeTiersMode === 'default' && (
              <p className="gc-fineprint">{settings.defaultStakeTiers.map((tier) => `${tierAnts(tier)} for a year: ${tierMultiplier(tier)}`).join(' · ')}. Models with their own free tier use these too, unless their config sets others.</p>
            )}
            {draft.freeTiersMode === 'custom' && (
              <>
                {draft.freeTiers.map((tier, index) => (
                  <div key={index} className="gc-policy__caps">
                    <TextField size="sm" className="gc-num" label="ANTS for a year" inputMode="decimal" disabled={readOnly} value={tier.ants} error={errors[`tier${index}:ants`]} onChange={(event) => setTier(index, 'ants', event.target.value)} />
                    <TextField size="sm" className="gc-num" label="Multiplier" placeholder="5 or unlimited" disabled={readOnly} value={tier.multiplier} error={errors[`tier${index}:multiplier`]} onChange={(event) => setTier(index, 'multiplier', event.target.value)} />
                    {!readOnly && <Button size="sm" variant="link" className="gc-seller-inline-button" onClick={() => set('freeTiers', draft.freeTiers.filter((_, at) => at !== index))}>Remove</Button>}
                  </div>
                ))}
                {errors.freeTiers && <p className="gc-warn">{errors.freeTiers}</p>}
                {!readOnly && draft.freeTiers.length < MAX_TIERS && (
                  <div><Button size="sm" variant="outline" onClick={() => set('freeTiers', [...draft.freeTiers, { ants: '', multiplier: '' }])}>Add tier</Button></div>
                )}
                <p className="gc-fineprint">Lowest first, each tier above the last; an unlimited tier goes last. Lock time counts: 20,000 ANTS for half a year equals 10,000 for a year. A model with its own free tier keeps the network tiers unless its config sets others.</p>
              </>
            )}
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
