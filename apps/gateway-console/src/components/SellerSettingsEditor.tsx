import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, ConfirmDialog, Disclosure, Segmented, Switch, TextField, useToast } from '@antseed/ui'
import { api } from '../api'
import type { FreeTierProgramView, SellerFreeTierProgramPatch, SellerFreeTierProgramSettings, SellerRestartView, SellerSettings, SellerSettingsPatch, SellerSettingsService, SellerUnitComponent } from '../api/types'
import type { SellerSettingsResponse } from '../api/client'
import { freeTierHeadline, tierAnts, tierMultiplier } from '../lib/free-tier'
import { numberFieldError, rebaseDraft } from '../lib/settings'
import { qk } from '../lib/queries'
import { formatUnitPrice, unitName } from '../lib/seller'
import { ErrorAlert } from './ui'
import { SellerOverrides, SellerRestart } from './SellerRestart'
import { SellerAddModel } from './SellerAddModel'
import { InfoTip } from './TrustInfo'

/** Everything the form edits, as typed (numbers stay strings until saved). */
interface Draft {
  displayName: string
  maxConcurrentBuyers: string
  healthEnabled: boolean
  healthIntervalSec: string
  healthThreshold: string
  gasEnabled: boolean
  gasMinEth: string
  refuelEnabled: boolean
  refuelBelowEth: string
  refuelUsdc: string
  refuelMaxPerDay: string
  freePerAddress: string
  freePerIp: string
  freeWindowHours: string
  freeStakersOnly: boolean
  /** Staked tiers of the seller-wide program: the network's, these, or none. */
  freeTiersMode: TiersMode
  freeTiers: TierDraft[]
  countries: string
  prices: Record<string, PriceDraft>
  /** Rows whose price is written in config.json (not the provider's default), by provider/service. */
  ownPrice: Record<string, boolean>
  /** Each model's own free-tier program, by provider/service. */
  free: Record<string, OwnFreeDraft>
  /** Whether each model is offered, by provider/service. */
  offered: Record<string, boolean>
  /** Per-unit prices (per image, per video second), by `unitKey`. */
  unitPrices: Record<string, string>
}

type TiersMode = 'default' | 'custom' | 'off'
/**
 * A staked tier as typed: the ANTS it takes locked for a year, and its
 * multiplier ("unlimited" allowed). `minPower` is the saved staking power,
 * kept while the ANTS text is unchanged so a save never rounds it.
 */
interface TierDraft { ants: string; multiplier: string; minPower?: number }
interface PriceDraft { input: string; output: string; cached: string }
interface OwnFreeDraft { enabled: boolean; perAddress: string; perIp: string; hours: string; stakersOnly: boolean }

/** Tiers are staking power: ANTS × weeks of lock remaining, shown as ANTS locked for a year (52 weeks). */
const WEEKS_PER_YEAR = 52
const MAX_TIERS = 4

const priceKey = (provider: string, service: string) => `${provider}/${service}`
/** One unit-billing component of a model: its provider/service, protocol, unit and match, as JSON (any value may hold a delimiter). */
export const unitKey = (key: string, component: Pick<SellerUnitComponent, 'protocol' | 'unit' | 'match'>) =>
  JSON.stringify([key, component.protocol, component.unit, component.match])
const parseUnitKey = (unit: string) => JSON.parse(unit) as [string, string, string, Record<string, unknown> | null]
/**
 * Which requests a component prices: "4k · audio", or "Per video" alone. When
 * the model bills in more than one unit, every label names its unit
 * ("4k · audio, per video second"), so two fields never read the same.
 */
export function unitComponentLabel(component: SellerUnitComponent, mixedUnits = false): string {
  const match = Object.entries(component.match ?? {}).map(([field, value]) => (value === true ? field : value === false ? `no ${field}` : String(value)))
  if (match.length === 0) return `Per ${unitName(component.unit)}`
  return mixedUnits ? `${match.join(' · ')}, per ${unitName(component.unit)}` : match.join(' · ')
}
const optional = (value: number | null) => (value === null ? '' : String(value))
const hoursOf = (windowMs: number | null) => (windowMs === null ? '' : String(windowMs / 3_600_000))
const antsOf = (minPower: number) => String(Math.round(minPower / WEEKS_PER_YEAR))

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
    refuelEnabled: settings.gasRefuel.enabled,
    refuelBelowEth: String(settings.gasRefuel.triggerBalanceEth),
    refuelUsdc: String(settings.gasRefuel.swapUsdc),
    refuelMaxPerDay: String(settings.gasRefuel.maxUsdcPerDay),
    freePerAddress: optional(settings.freeTier.maxRequestsPerAddress),
    freePerIp: optional(settings.freeTier.maxRequestsPerIp),
    freeWindowHours: hoursOf(settings.freeTier.windowMs),
    freeStakersOnly: settings.freeTier.stakersOnly,
    freeTiersMode: settings.freeTier.stakeTiers === null ? 'default' : settings.freeTier.stakeTiers.length === 0 ? 'off' : 'custom',
    freeTiers: (settings.freeTier.stakeTiers?.length ? settings.freeTier.stakeTiers : settings.defaultStakeTiers).map((tier) => ({
      ants: antsOf(tier.minPower), multiplier: String(tier.multiplier), minPower: tier.minPower,
    })),
    countries: settings.restrictedCountries.join(', '),
    prices: Object.fromEntries(settings.services.map((entry) => [priceKey(entry.provider, entry.service), {
      input: optional(entry.inputUsdPerMillion), output: optional(entry.outputUsdPerMillion), cached: optional(entry.cachedInputUsdPerMillion),
    }])),
    ownPrice: Object.fromEntries(settings.services.map((entry) => [priceKey(entry.provider, entry.service),
      !entry.inherited && entry.inputUsdPerMillion !== null && entry.outputUsdPerMillion !== null])),
    free: Object.fromEntries(settings.services.map((entry) => [priceKey(entry.provider, entry.service), ownFreeDraft(entry.ownFreeTier)])),
    offered: Object.fromEntries(settings.services.map((entry) => [priceKey(entry.provider, entry.service), entry.enabled])),
    unitPrices: Object.fromEntries(settings.services.flatMap((entry) => entry.unitComponents.map((component) =>
      [unitKey(priceKey(entry.provider, entry.service), component), String(component.priceUsd)]))),
  }
}

const num = (text: string) => Number(text.trim())
const numOrNull = (text: string) => (text.trim() === '' ? null : Number(text.trim()))
/** Whether two typed numbers differ in value ("60" and "60.0" do not). */
const numChanged = (a: string, b: string) => !Object.is(numOrNull(a), numOrNull(b)) && a.trim() !== b.trim()
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const windowOf = (hours: string) => {
  const value = numOrNull(hours)
  return value === null ? null : Math.round(value * 3_600_000)
}

/** A tier's staking power: the saved value while its ANTS text is untouched, else ANTS × 52. */
const tierPower = (tier: TierDraft) =>
  tier.minPower !== undefined && tier.ants.trim() === antsOf(tier.minPower) ? tier.minPower : Math.round(num(tier.ants) * WEEKS_PER_YEAR)

const tiersOf = (draft: Draft): SellerFreeTierProgramPatch['stakeTiers'] => {
  if (draft.freeTiersMode === 'default') return null
  if (draft.freeTiersMode === 'off') return []
  return draft.freeTiers.map((tier) => ({
    minPower: tierPower(tier),
    multiplier: tier.multiplier.trim().toLowerCase() === 'unlimited' ? 'unlimited' as const : num(tier.multiplier),
  }))
}

const ownFreeOf = (own: OwnFreeDraft) => ({
  maxRequestsPerAddress: numOrNull(own.perAddress), maxRequestsPerIp: numOrNull(own.perIp), windowMs: windowOf(own.hours), stakersOnly: own.stakersOnly,
})

/** The fields of `next` whose value differs from `before`. */
function changedFields<T extends object>(before: T, next: T): Partial<T> {
  return Object.fromEntries(Object.entries(next).filter(([key, value]) => !same(value, before[key as keyof T]))) as Partial<T>
}

type PricePatch = { inputUsdPerMillion?: number; outputUsdPerMillion?: number; cachedInputUsdPerMillion?: number | null }

/** A price row's change: only the prices that changed, or the whole row when config.json has no price for it yet. */
function pricePatch(base: PriceDraft | undefined, draft: PriceDraft, owned: boolean): PricePatch {
  const values = (row: PriceDraft) => ({ inputUsdPerMillion: numOrNull(row.input), outputUsdPerMillion: numOrNull(row.output), cachedInputUsdPerMillion: numOrNull(row.cached) })
  const next = values(draft)
  const changed = base ? changedFields(values(base), next) : next
  if (Object.keys(changed).length === 0) return {}
  const out: PricePatch = {}
  for (const [key, value] of Object.entries(owned ? changed : next) as Array<[keyof PricePatch, number | null]>) {
    // Input and output are required (the form checks it); only the cached price can be cleared.
    if (value !== null || key === 'cachedInputUsdPerMillion') (out as Record<string, number | null>)[key] = value
  }
  return out
}

/** A model's own free-tier change: null to remove it, every field for a new one, else only what changed. */
function ownFreePatch(base: OwnFreeDraft | undefined, draft: OwnFreeDraft): SellerFreeTierProgramPatch | null | undefined {
  if (!draft.enabled) return base?.enabled ? null : undefined
  if (!base?.enabled) return ownFreeOf(draft)
  const changed = changedFields(ownFreeOf(base), ownFreeOf(draft))
  return Object.keys(changed).length > 0 ? changed : undefined
}

/**
 * Field errors. With `base`, only fields that differ from it are checked, so
 * a value saved elsewhere (or one this form would not allow) never blocks
 * saving something else.
 */
export function draftErrors(draft: Draft, base?: Draft): Record<string, string> {
  const touched = (...keys: Array<keyof Draft>) => !base || keys.some((key) => !same(draft[key], base[key]))
  const check = (key: keyof Draft, error: string | undefined) => (touched(key) ? error : undefined)
  const errors: Record<string, string | undefined> = {
    displayName: check('displayName', draft.displayName.trim().length > 64 ? 'At most 64 characters.' : undefined),
    maxConcurrentBuyers: check('maxConcurrentBuyers', numberFieldError(draft.maxConcurrentBuyers, { required: true, min: 1, integer: true })),
    healthIntervalSec: check('healthIntervalSec', numberFieldError(draft.healthIntervalSec, { required: true, min: 60, integer: true })),
    healthThreshold: check('healthThreshold', numberFieldError(draft.healthThreshold, { required: true, min: 1, integer: true })),
    gasMinEth: check('gasMinEth', numberFieldError(draft.gasMinEth, { required: true })),
    refuelBelowEth: check('refuelBelowEth', numberFieldError(draft.refuelBelowEth, { required: true, min: 0.000001 })),
    refuelUsdc: check('refuelUsdc', numberFieldError(draft.refuelUsdc, { required: true, min: 1 })),
    refuelMaxPerDay: check('refuelMaxPerDay', numberFieldError(draft.refuelMaxPerDay, { required: true, min: 1 })),
    freePerAddress: check('freePerAddress', numberFieldError(draft.freePerAddress, { min: 1, integer: true })),
    freePerIp: check('freePerIp', numberFieldError(draft.freePerIp, { min: 1, integer: true })),
    freeWindowHours: check('freeWindowHours', numberFieldError(draft.freeWindowHours, { min: 1 / 3600, minText: '1 second (0.0003 hours)' })),
    countries: check('countries', countryList(draft.countries).some((code) => !/^[A-Z]{2}$/.test(code)) ? 'Two-letter country codes, comma-separated.' : undefined),
  }
  for (const [key, price] of Object.entries(draft.prices)) {
    if (base && same(price, base.prices[key])) continue
    errors[`${key}:input`] = numberFieldError(price.input, { required: true })
    errors[`${key}:output`] = numberFieldError(price.output, { required: true })
    errors[`${key}:cached`] = numberFieldError(price.cached)
  }
  const tiersTouched = touched('freeTiersMode', 'freeTiers')
  if (draft.freeTiersMode === 'custom' && tiersTouched) {
    if (draft.freeTiers.length === 0) errors.freeTiers = 'Add a tier, or pick the network default or none.'
    draft.freeTiers.forEach((tier, index) => {
      // A saved tier left as it is keeps its exact power, so it never blocks a save.
      const savedAsIs = tier.minPower !== undefined && tier.ants.trim() === antsOf(tier.minPower)
      errors[`tier${index}:ants`] = savedAsIs ? undefined : numberFieldError(tier.ants, { required: true, min: 1, integer: true })
      errors[`tier${index}:multiplier`] = tier.multiplier.trim().toLowerCase() === 'unlimited' ? undefined : numberFieldError(tier.multiplier, { required: true, min: 1, integer: true })
    })
  }
  // Clearing both limits turns the seller-wide program off; its other settings need a limit to apply to.
  const limitless = draft.freePerAddress.trim() === '' && draft.freePerIp.trim() === ''
  if (limitless && touched('freeStakersOnly', 'freeTiersMode', 'freeTiers', 'freeWindowHours')
    && (draft.freeStakersOnly || draft.freeTiersMode !== 'default' || draft.freeWindowHours.trim() !== '')) {
    errors.freePerAddress ??= 'Set a limit per address, per IP, or both; the window, stakers only and staked tiers apply to it.'
  }
  if (draft.freeStakersOnly && draft.freeTiersMode === 'off' && touched('freeStakersOnly', 'freeTiersMode')) {
    errors.freeTiers = 'Stakers only needs at least one staked tier.'
  }
  for (const [key, value] of Object.entries(draft.unitPrices)) {
    if (base && base.unitPrices[key] === value) continue
    errors[`unit:${key}`] = numberFieldError(value, { required: true })
  }
  for (const [key, own] of Object.entries(draft.free)) {
    if (!own.enabled || (base && same(own, base.free[key]))) continue
    errors[`${key}:freeAddress`] = numberFieldError(own.perAddress, { min: 1, integer: true })
    errors[`${key}:freeIp`] = numberFieldError(own.perIp, { min: 1, integer: true })
    errors[`${key}:freeHours`] = numberFieldError(own.hours, { min: 1 / 3600, minText: '1 second (0.0003 hours)' })
    if (!errors[`${key}:freeAddress`] && !errors[`${key}:freeIp`] && own.perAddress.trim() === '' && own.perIp.trim() === '') errors[`${key}:freeAddress`] = 'Set a limit per address, per IP, or both.'
  }
  return Object.fromEntries(Object.entries(errors).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

function countryList(text: string): string[] {
  return text.split(/[\s,]+/).map((code) => code.trim().toUpperCase()).filter(Boolean)
}

/**
 * The draft after the saved settings changed underneath it: fields and price
 * rows the operator edited keep their edits, everything else (rows for
 * services added or removed since included) takes the new saved values.
 */
export function reconcileDraft(draft: Draft, base: Draft, next: Draft): Draft {
  return {
    ...rebaseDraft(draft, base, next),
    prices: rebaseRows(draft.prices, base.prices, next.prices),
    free: rebaseRows(draft.free, base.free, next.free),
    offered: rebaseDraft(draft.offered, base.offered, next.offered),
    unitPrices: rebaseDraft(draft.unitPrices, base.unitPrices, next.unitPrices),
  }
}

/** Rows keyed by provider/service, each rebased field by field (an input edit here keeps an output change saved elsewhere). */
function rebaseRows<T extends object>(draft: Record<string, T>, base: Record<string, T>, next: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(next).map(([key, row]) => [key, draft[key] && base[key] ? rebaseDraft(draft[key], base[key], row) : row]))
}

/** What buyers of this model get now, in a line: "1,000 free requests a day, then paid · staked: 10,000 ANTS 5×, …". */
export function freeTierLine(program: FreeTierProgramView | null, paid: boolean): string {
  if (!program) return paid ? 'No free allowance' : 'Free, no limit'
  const tiers = program.stakeTiers.map((tier) => `${tierAnts(tier)} ${tierMultiplier(tier)}`).join(', ')
  return `${freeTierHeadline(program, paid)}${tiers ? ` · staked: ${tiers}` : ''}`
}

/**
 * Only what changed from `base`, in the API's shape, field by field: a field
 * left alone is never sent, so saving does not revert a change made elsewhere
 * (the CLI, another tab) or write today's defaults into config.json.
 */
export function patchOf(base: Draft, draft: Draft): SellerSettingsPatch {
  const patch: SellerSettingsPatch = {}
  if (draft.displayName.trim() !== base.displayName.trim()) patch.displayName = draft.displayName.trim()
  if (numChanged(draft.maxConcurrentBuyers, base.maxConcurrentBuyers)) patch.maxConcurrentBuyers = num(draft.maxConcurrentBuyers)
  const healthCheck: NonNullable<SellerSettingsPatch['healthCheck']> = {}
  if (draft.healthEnabled !== base.healthEnabled) healthCheck.enabled = draft.healthEnabled
  if (numChanged(draft.healthIntervalSec, base.healthIntervalSec)) healthCheck.intervalMs = num(draft.healthIntervalSec) * 1000
  if (numChanged(draft.healthThreshold, base.healthThreshold)) healthCheck.failureThreshold = num(draft.healthThreshold)
  if (Object.keys(healthCheck).length > 0) patch.healthCheck = healthCheck
  const gasCheck: NonNullable<SellerSettingsPatch['gasCheck']> = {}
  if (draft.gasEnabled !== base.gasEnabled) gasCheck.enabled = draft.gasEnabled
  if (numChanged(draft.gasMinEth, base.gasMinEth)) gasCheck.minBalanceEth = num(draft.gasMinEth)
  if (Object.keys(gasCheck).length > 0) patch.gasCheck = gasCheck
  const gasRefuel: NonNullable<SellerSettingsPatch['gasRefuel']> = {}
  if (draft.refuelEnabled !== base.refuelEnabled) gasRefuel.enabled = draft.refuelEnabled
  if (numChanged(draft.refuelBelowEth, base.refuelBelowEth)) gasRefuel.triggerBalanceEth = num(draft.refuelBelowEth)
  if (numChanged(draft.refuelUsdc, base.refuelUsdc)) gasRefuel.swapUsdc = num(draft.refuelUsdc)
  if (numChanged(draft.refuelMaxPerDay, base.refuelMaxPerDay)) gasRefuel.maxUsdcPerDay = num(draft.refuelMaxPerDay)
  if (Object.keys(gasRefuel).length > 0) patch.gasRefuel = gasRefuel
  const programOf = (from: Draft) => ({
    maxRequestsPerAddress: numOrNull(from.freePerAddress), maxRequestsPerIp: numOrNull(from.freePerIp), windowMs: windowOf(from.freeWindowHours),
    stakersOnly: from.freeStakersOnly, stakeTiers: tiersOf(from),
  })
  const freeTier = changedFields(programOf(base), programOf(draft))
  if (Object.keys(freeTier).length > 0) patch.freeTier = freeTier
  if (countryList(draft.countries).join(',') !== countryList(base.countries).join(',')) patch.restrictedCountries = countryList(draft.countries)
  const pricing: NonNullable<SellerSettingsPatch['pricing']> = []
  for (const key of Object.keys(draft.prices)) {
    const prices = pricePatch(base.prices[key], draft.prices[key]!, base.ownPrice[key] ?? false)
    const own = draft.free[key]
    // A model's own program keeps any staked tiers written in the file; turning it on uses the network's.
    const freeTier = own === undefined ? undefined : ownFreePatch(base.free[key], own)
    const enabled = key in base.offered && draft.offered[key] !== base.offered[key] ? draft.offered[key] : undefined
    const unitPrices = Object.entries(draft.unitPrices)
      .filter(([unit, value]) => parseUnitKey(unit)[0] === key && base.unitPrices[unit] !== undefined && numChanged(value, base.unitPrices[unit]!))
      .map(([unit, value]) => {
        const [, protocol, unitName, match] = parseUnitKey(unit)
        return { protocol, unit: unitName, match, priceUsd: num(value) }
      })
    if (Object.keys(prices).length === 0 && freeTier === undefined && enabled === undefined && unitPrices.length === 0) continue
    const [provider, ...rest] = key.split('/')
    pricing.push({ provider: provider!, service: rest.join('/'), ...prices, ...(freeTier !== undefined ? { freeTier } : {}), ...(enabled !== undefined ? { enabled } : {}), ...(unitPrices.length > 0 ? { unitPrices } : {}) })
  }
  if (pricing.length > 0) patch.pricing = pricing
  return patch
}

/** The seller's config.json fields an operator commonly changes. They apply when the seller restarts. */
export function SellerSettingsEditor({ settings, restart }: { settings: SellerSettings; restart: SellerRestartView }) {
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

  const setOffered = (key: string, value: boolean) => setDraft((current) => ({ ...current, offered: { ...current.offered, [key]: value } }))
  const setUnitPrice = (key: string, value: string) => setDraft((current) => ({ ...current, unitPrices: { ...current.unitPrices, [key]: value } }))
  const offeredCount = settings.services.filter((entry) => draft.offered[priceKey(entry.provider, entry.service)] ?? entry.enabled).length
  const [removing, setRemoving] = useState<SellerSettingsService | null>(null)
  // Adding or removing a model saves at once; the form's other edits stay as typed (the draft is rebased on the new settings).
  const structuralSaved = (data: SellerSettingsResponse, message: string) => {
    queryClient.setQueryData(qk.sellerSettings, { settings: data.settings, alerts: data.alerts, restart: data.restart })
    for (const key of [qk.sellerStatus, qk.sellerPromote, qk.sellerCard, qk.sellerMarket]) void queryClient.invalidateQueries({ queryKey: key })
    setSavedPendingRestart(true)
    toast(message)
  }
  const remove = useMutation({
    mutationFn: (entry: SellerSettingsService) => api.seller.updateSettings({ removeServices: [{ provider: entry.provider, service: entry.service }] }),
    onSuccess: (data, entry) => {
      setRemoving(null)
      structuralSaved(data, `Removed ${entry.service}. Restart the seller to apply.`)
    },
  })

  const save = useMutation({
    mutationFn: (submitted: { patch: SellerSettingsPatch; draft: Draft }) => api.seller.updateSettings(submitted.patch),
    onSuccess: (data, submitted) => {
      queryClient.setQueryData(qk.sellerSettings, { settings: data.settings, alerts: data.alerts, restart: data.restart })
      // The name and prices show on other seller pages too.
      for (const key of [qk.sellerStatus, qk.sellerPromote, qk.sellerCard, qk.sellerMarket]) void queryClient.invalidateQueries({ queryKey: key })
      const next = draftOf(data.settings)
      setBase(next)
      // Edits typed while the save was in flight stay; the rest takes the saved values.
      setDraft((current) => reconcileDraft(current, submitted.draft, next))
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
      <SellerOverrides settings={settings} />
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
            <Switch checked={draft.refuelEnabled} disabled={readOnly || !draft.gasEnabled} onChange={(next) => set('refuelEnabled', next)} label={<RefuelLabel />}
              description="Swap some USDC earnings for ETH on Uniswap before the wallet runs out. Base mainnet; needs gas checks." />
            <div className="gc-policy__caps">
              {field('refuelBelowEth', 'Below ETH')}
              {field('refuelUsdc', 'Swap USDC')}
              {field('refuelMaxPerDay', 'Max USDC / day')}
            </div>
          </section>
        </div>
        <div className="gc-policy__advanced">
          <Disclosure title="Models and pricing" defaultOpen={Boolean(focusPrice)} summary={`${offeredCount} of ${settings.services.length} offered`}>
            <p className="gc-fineprint">USD per million tokens, or per image or video for models billed by unit. A service without its own price uses its provider's defaults until you save one. A model turned off stays here but is not offered. A model's own free tier is a free allowance on a paid model, and replaces the seller-wide free tier on a free one.</p>
            {settings.services.map((entry) => {
              const key = priceKey(entry.provider, entry.service)
              const price = draft.prices[key] ?? savedPrices[key]!
              const own = draft.free[key] ?? savedFree[key]!
              const offered = draft.offered[key] ?? entry.enabled
              return (
                <div key={key} id={`gc-price-${key}`} className={offered ? 'gc-seller-price' : 'gc-seller-price gc-seller-price--off'}>
                  <div className="gc-seller-price__name">
                    <span className="gc-ellipsis" title={key}>{entry.service}</span>
                    <span className="gc-fineprint">{entry.provider}{entry.upstreamModel ? ` · ${entry.upstreamModel}` : ''}{entry.inherited ? ' · provider default' : ''}</span>
                    <div className="gc-seller-price__controls">
                      {/* The seller needs one model to start (and to serve this dashboard), so the last one offered stays on. */}
                      <Switch checked={offered} disabled={readOnly || (offered && offeredCount === 1)} onChange={(next) => setOffered(key, next)} label="Offered" ariaLabel={`Offer ${key}`} />
                      {/* A provider's last model is turned off, not removed: a provider with no models stops the seller from starting. */}
                      {!readOnly && (settings.providers.find((provider) => provider.name === entry.provider)?.services ?? 0) > 1 && (
                        <Button size="sm" variant="link" className="gc-seller-inline-button" aria-label={`Remove ${key}`} onClick={() => setRemoving(entry)}>Remove</Button>
                      )}
                    </div>
                  </div>
                  {entry.unitComponents.length > 0
                    // Billed per image or video: each priced component of its unit billing, edited one by one.
                    ? <div className="gc-seller-price__unit">
                      {entry.unitComponents.map((component) => {
                        const unit = unitKey(key, component)
                        const label = unitComponentLabel(component, new Set(entry.unitComponents.map((other) => other.unit)).size > 1)
                        return <TextField key={unit} size="sm" className="gc-num" label={label} aria-label={`${key} ${label} price`} inputMode="decimal"
                          disabled={readOnly} value={draft.unitPrices[unit] ?? String(component.priceUsd)} error={errors[`unit:${unit}`]} onChange={(event) => setUnitPrice(unit, event.target.value)} />
                      })}
                      <span className="gc-fineprint">USD per {[...new Set(entry.unitComponents.map((component) => unitName(component.unit)))].join(' or ')}{entry.unitPrice ? `; now ${formatUnitPrice(entry.unitPrice)}` : ''}.</span>
                    </div>
                    : <>
                    <TextField size="sm" className="gc-num" label="Input" aria-label={`${key} input price`} inputMode="decimal" disabled={readOnly} value={price.input} error={errors[`${key}:input`]} onChange={(event) => setPrice(key, 'input', event.target.value)} />
                    <TextField size="sm" className="gc-num" label="Output" aria-label={`${key} output price`} inputMode="decimal" disabled={readOnly} value={price.output} error={errors[`${key}:output`]} onChange={(event) => setPrice(key, 'output', event.target.value)} />
                    <TextField size="sm" className="gc-num" label="Cached input" aria-label={`${key} cached input price`} inputMode="decimal" placeholder="Same as input" disabled={readOnly} value={price.cached} error={errors[`${key}:cached`]} onChange={(event) => setPrice(key, 'cached', event.target.value)} />
                    </>}
                  <div className="gc-seller-price__free">
                    <Switch checked={own.enabled} disabled={readOnly} onChange={(next) => setFree(key, 'enabled', next)} label="Own free tier" ariaLabel={`${key} own free tier`}
                      description={freeTierLine(entry.freeTier, entry.paid)} />
                    {own.enabled && (
                      <>
                        <div className="gc-policy__caps">
                          <TextField size="sm" className="gc-num" label="Per address" aria-label={`${key} free requests per address`} inputMode="decimal" placeholder="No limit" disabled={readOnly} value={own.perAddress} error={errors[`${key}:freeAddress`]} onChange={(event) => setFree(key, 'perAddress', event.target.value)} />
                          <TextField size="sm" className="gc-num" label="Per IP" aria-label={`${key} free requests per IP`} inputMode="decimal" placeholder="No limit" disabled={readOnly} value={own.perIp} error={errors[`${key}:freeIp`]} onChange={(event) => setFree(key, 'perIp', event.target.value)} />
                          <TextField size="sm" className="gc-num" label="Window (hours)" aria-label={`${key} free-tier window in hours`} inputMode="decimal" placeholder="24" disabled={readOnly} value={own.hours} error={errors[`${key}:freeHours`]} onChange={(event) => setFree(key, 'hours', event.target.value)} />
                        </div>
                        <Switch checked={own.stakersOnly} disabled={readOnly} onChange={(next) => setFree(key, 'stakersOnly', next)} label="Stakers only" ariaLabel={`${key} free tier for stakers only`}
                          description={entry.paid ? 'Only buyers staked on you get the allowance; everyone else pays.' : 'Only buyers staked on you are served.'} />
                      </>
                    )}
                  </div>
                </div>
              )
            })}
            {!readOnly && <SellerAddModel settings={settings} onSaved={structuralSaved} />}
          </Disclosure>
          <Disclosure title="Free tier" summary={draft.freePerAddress || draft.freePerIp ? (draft.freeStakersOnly ? 'Stakers only' : 'Limited') : 'No limits'}>
            <p className="gc-fineprint">For free models without their own free tier: requests one buyer address or IP may make per window. Clear both limits to turn the seller-wide free tier off. Buyers staked on you get more, by staked tier.</p>
            <div className="gc-policy__caps">
              {field('freePerAddress', 'Per address', { placeholder: 'No limit' })}
              {field('freePerIp', 'Per IP', { placeholder: 'No limit' })}
              {field('freeWindowHours', 'Window (hours)', { placeholder: '24' })}
            </div>
            <Switch checked={draft.freeStakersOnly} disabled={readOnly} onChange={(next) => set('freeStakersOnly', next)} label="Stakers only"
              description="Serve free models only to buyers whose stake reaches a tier; the limits above are what the multipliers apply to." />
            <Segmented label="Staked tiers" value={draft.freeTiersMode} onChange={(mode) => set('freeTiersMode', mode)}
              options={[{ value: 'default', label: 'Network default' }, { value: 'custom', label: 'Custom' }, { value: 'off', label: 'None' }]} />
            {/* Any tier mode can be wrong (none with stakers only), so the reason shows under the selector. */}
            {errors.freeTiers && <p className="gc-warn">{errors.freeTiers}</p>}
            {draft.freeTiersMode === 'default' && (
              <p className="gc-fineprint">{settings.defaultStakeTiers.map((tier) => `${tierAnts(tier)} for a year: ${tierMultiplier(tier)}`).join(' · ')}. Models with their own free tier use these too, unless their config sets others.</p>
            )}
            {draft.freeTiersMode === 'custom' && (
              <>
                {draft.freeTiers.map((tier, index) => (
                  <div key={index} className="gc-policy__caps">
                    <TextField size="sm" className="gc-num" label="ANTS for a year" aria-label={`Tier ${index + 1} ANTS for a year`} inputMode="decimal" disabled={readOnly} value={tier.ants} error={errors[`tier${index}:ants`]} onChange={(event) => setTier(index, 'ants', event.target.value)} />
                    <TextField size="sm" className="gc-num" label="Multiplier" aria-label={`Tier ${index + 1} multiplier`} placeholder="5 or unlimited" disabled={readOnly} value={tier.multiplier} error={errors[`tier${index}:multiplier`]} onChange={(event) => setTier(index, 'multiplier', event.target.value)} />
                    {!readOnly && <Button size="sm" variant="link" className="gc-seller-inline-button" aria-label={`Remove tier ${index + 1}`} onClick={() => set('freeTiers', draft.freeTiers.filter((_, at) => at !== index))}>Remove</Button>}
                  </div>
                ))}
                {!readOnly && draft.freeTiers.length < MAX_TIERS && (
                  <div><Button size="sm" variant="outline" onClick={() => set('freeTiers', [...draft.freeTiers, { ants: '', multiplier: '' }])}>Add tier</Button></div>
                )}
                <p className="gc-fineprint">Lowest first, each tier above the last; an unlimited tier goes last. Lock time counts: 20,000 ANTS for half a year equals 10,000 for a year. A model with its own free tier keeps the network tiers unless its config sets others.</p>
              </>
            )}
          </Disclosure>
        </div>
      </div>
      {/* Always mounted: a restart under way keeps being tracked while fields are edited. */}
      <SellerRestart restart={restart} pending={savedPendingRestart} idleHidden={changed} onRestarted={() => setSavedPendingRestart(false)} />
      {save.error ? <ErrorAlert error={save.error} title="Could not save" /> : null}
      {!readOnly && (
        <div className="gc-actions">
          <span className="gc-fineprint gc-actions__note">{changed ? 'Applies when the seller restarts.' : 'No changes.'}</span>
          <Button variant="ghost" disabled={!changed || save.isPending} onClick={() => setDraft(base)}>Reset</Button>
          <Button disabled={!changed || Object.keys(errors).length > 0 || save.isPending} onClick={() => save.mutate({ patch, draft })}>{save.isPending ? 'Saving…' : 'Save'}</Button>
        </div>
      )}
      <ConfirmDialog isOpen={removing !== null} busy={remove.isPending} error={remove.error} onClose={() => { setRemoving(null); remove.reset() }}
        onConfirm={() => removing && remove.mutate(removing)} title={`Remove ${removing?.service ?? 'this model'}?`} confirmLabel="Remove" busyLabel="Removing…"
        body="It is taken out of the seller's config, with its prices and its own free tier, and stops being offered when the seller restarts. To stop offering it but keep its settings, turn it off instead." />
    </div>
  )
}

const GAS_DOCS_URL = 'https://antseed.com/docs/provide/payments#gas'

/** The auto-refuel switch label, with where and how the swap happens. */
function RefuelLabel() {
  return (
    <span className="gc-inline">
      Auto-refuel gas
      <InfoTip label="How auto-refuel swaps" align="center">
        <span className="gc-tip__title">How the swap works</span>
        When the wallet holds less than <b>Below ETH</b>, the seller swaps <b>Swap USDC</b> of its wallet's USDC for ETH on Uniswap v3 on Base
        (USDC/WETH 0.05% pool, at most 1% slippage). The ETH lands in the same wallet, which pays the swap's gas, so no
        other wallet is involved. At most <b>Max USDC / day</b>; a failed swap retries later and alerts.{' '}
        <a href={GAS_DOCS_URL} target="_blank" rel="noreferrer">Seller gas docs</a>
      </InfoTip>
    </span>
  )
}

