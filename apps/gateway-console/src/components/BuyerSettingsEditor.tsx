import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { TrustTip } from './TrustInfo'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, ConfirmDialog, Disclosure, Segmented, Switch, TextAreaField, TextField, useToast } from '@antseed/ui'
import { api } from '../api'
import type { BuyerSettingsInput, RoutingPolicy, Settings } from '../api/types'
import { formatPricePerMillion, formatUsd } from '../lib/format'
import { combinePolicies, matchingPeers } from '../lib/policy-match'
import { qk, usePeerLists, usePeers } from '../lib/queries'
import { buyerSettingsErrors, isOverridden, numberFieldError, peerIdsError, splitEntries, urlsError } from '../lib/settings'
import { PeerPicker } from './PeerPicker'
import { Slider } from './PolicyEditor'
import { ErrorAlert } from './ui'

type Buyer = Settings['buyer']

/** Amber dot + one line: the running buyer ignores this config value (the saved one applies once the override is removed). */
function OverrideNote() {
  return (
    <span className="gc-override">
      <span className="gc-attention" aria-hidden="true" />
      Overridden by the buyer's environment or start flags
    </span>
  )
}

/** Everything the form edits, as typed (numbers stay strings until saved). */
interface Draft {
  allowMode: 'any' | 'only'
  allowedPeerIds: string[]
  blockedPeerIds: string[]
  minTrustScore: string
  minReputation: string
  preferFree: boolean
  softInputCap: string
  maxInput: string
  maxOutput: string
  maxCached: string
  verify: boolean
  requireVerified: boolean
  verifiers: string
  sampleRate: string
  maxSampleBytes: string
  autoSweep: boolean
  maxPerRequest: string
  maxReserve: string
  rpcUrl: string
  fallbackRpcUrls: string
  peerRefreshMs: string
  metadataTimeoutMs: string
  requestTimeoutMs: string
  maxStreamMs: string
  perServiceMetadata: boolean
}

function draftOf(buyer: Buyer): Draft {
  const prefs = buyer.routingPreferences
  const optional = (value: number | null) => (value === null ? '' : String(value))
  return {
    allowMode: prefs.allowedPeerIds.length > 0 ? 'only' : 'any',
    allowedPeerIds: [...prefs.allowedPeerIds],
    blockedPeerIds: [...prefs.blockedPeerIds],
    minTrustScore: String(prefs.minTrustScore),
    minReputation: String(buyer.minPeerReputation),
    preferFree: prefs.preferFreePeers,
    softInputCap: String(prefs.maxInputUsdPerMillion),
    maxInput: String(buyer.maxPricing.inputUsdPerMillion),
    maxOutput: String(buyer.maxPricing.outputUsdPerMillion),
    maxCached: optional(buyer.maxPricing.cachedInputUsdPerMillion),
    verify: buyer.verifier.enabled,
    requireVerified: buyer.verifier.require,
    verifiers: buyer.verifier.prefer.join(', '),
    sampleRate: optional(buyer.evidence.sampleRate),
    maxSampleBytes: optional(buyer.evidence.maxSampleBytes),
    autoSweep: buyer.payments.autoSweep,
    maxPerRequest: String(buyer.payments.maxPerRequestUsdc),
    maxReserve: String(buyer.payments.maxReserveUsdc),
    rpcUrl: buyer.payments.rpcUrl ?? '',
    fallbackRpcUrls: buyer.payments.fallbackRpcUrls.join('\n'),
    peerRefreshMs: String(buyer.network.peerRefreshIntervalMs),
    metadataTimeoutMs: String(buyer.network.metadataFetchTimeoutMs),
    requestTimeoutMs: String(buyer.network.requestTimeoutMs),
    maxStreamMs: String(buyer.network.maxStreamDurationMs),
    perServiceMetadata: !buyer.network.disableMetadataV2Services,
  }
}

/** Field errors; the form saves only without any. */
function draftErrors(draft: Draft): Partial<Record<keyof Draft, string>> {
  const limits = buyerSettingsErrors({ input: draft.maxInput, output: draft.maxOutput, cached: draft.maxCached, reputation: draft.minReputation })
  const errors: Partial<Record<keyof Draft, string | undefined>> = {
    maxInput: limits.input,
    maxOutput: limits.output,
    maxCached: limits.cached,
    softInputCap: numberFieldError(draft.softInputCap, { required: true }),
    allowedPeerIds: draft.allowMode === 'only' ? peerIdsError(draft.allowedPeerIds) : undefined,
    blockedPeerIds: peerIdsError(draft.blockedPeerIds),
    sampleRate: numberFieldError(draft.sampleRate, { max: 1 }),
    maxSampleBytes: numberFieldError(draft.maxSampleBytes, { min: 1, integer: true }),
    maxPerRequest: numberFieldError(draft.maxPerRequest, { required: true, min: 0.000001 }),
    maxReserve: numberFieldError(draft.maxReserve, { required: true, min: 0.000001 }),
    rpcUrl: draft.rpcUrl.trim() ? urlsError([draft.rpcUrl.trim()]) : undefined,
    fallbackRpcUrls: urlsError(splitEntries(draft.fallbackRpcUrls)),
    peerRefreshMs: numberFieldError(draft.peerRefreshMs, { required: true, min: 1_000, integer: true }),
    metadataTimeoutMs: numberFieldError(draft.metadataTimeoutMs, { required: true, min: 100, integer: true }),
    requestTimeoutMs: numberFieldError(draft.requestTimeoutMs, { required: true, min: 1, integer: true }),
    maxStreamMs: numberFieldError(draft.maxStreamMs, { required: true, min: 1, integer: true }),
  }
  return Object.fromEntries(Object.entries(errors).filter(([, error]) => error)) as Partial<Record<keyof Draft, string>>
}

/** The whole draft as a settings patch (the gateway writes only what differs). */
function patchOf(draft: Draft): BuyerSettingsInput {
  const optional = (raw: string) => (raw.trim() ? Number(raw) : null)
  return {
    routingPreferences: {
      minTrustScore: Number(draft.minTrustScore),
      maxInputUsdPerMillion: Number(draft.softInputCap),
      preferFreePeers: draft.preferFree,
      allowedPeerIds: draft.allowMode === 'only' ? draft.allowedPeerIds : [],
      blockedPeerIds: draft.blockedPeerIds,
    },
    maxPricing: { inputUsdPerMillion: Number(draft.maxInput), outputUsdPerMillion: Number(draft.maxOutput), cachedInputUsdPerMillion: optional(draft.maxCached) },
    minPeerReputation: Number(draft.minReputation),
    verifier: { enabled: draft.verify, require: draft.verify && draft.requireVerified, prefer: draft.verify ? splitEntries(draft.verifiers) : [] },
    evidence: { sampleRate: optional(draft.sampleRate), maxSampleBytes: optional(draft.maxSampleBytes) },
    payments: {
      autoSweep: draft.autoSweep, maxPerRequestUsdc: Number(draft.maxPerRequest), maxReserveUsdc: Number(draft.maxReserve),
      rpcUrl: draft.rpcUrl.trim() || null, fallbackRpcUrls: splitEntries(draft.fallbackRpcUrls),
    },
    network: {
      peerRefreshIntervalMs: Number(draft.peerRefreshMs), metadataFetchTimeoutMs: Number(draft.metadataTimeoutMs), requestTimeoutMs: Number(draft.requestTimeoutMs),
      maxStreamDurationMs: Number(draft.maxStreamMs), disableMetadataV2Services: !draft.perServiceMetadata,
    },
  }
}

/** Draft keys the buyer reloads by itself; changing anything else restarts it. */
const LIVE_KEYS: ReadonlyArray<keyof Draft> = ['allowMode', 'allowedPeerIds', 'blockedPeerIds', 'minTrustScore', 'preferFree', 'softInputCap']

function changedKeys(before: Draft, after: Draft): Array<keyof Draft> {
  return (Object.keys(after) as Array<keyof Draft>).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
}

/** The buyer's seller filters as a routing policy, to count the sellers they leave. */
function draftPolicy(draft: Draft): RoutingPolicy {
  const number = (raw: string) => (raw.trim() && Number.isFinite(Number(raw)) ? Number(raw) : undefined)
  return {
    ...(draft.allowMode === 'only' && draft.allowedPeerIds.length > 0 ? { allowedPeerIds: draft.allowedPeerIds } : {}),
    ...(draft.blockedPeerIds.length > 0 ? { blockedPeerIds: draft.blockedPeerIds } : {}),
    ...(number(draft.minTrustScore) ? { minTrustScore: number(draft.minTrustScore) } : {}),
    ...(number(draft.minReputation) ? { minReputation: number(draft.minReputation) } : {}),
    ...(number(draft.maxInput) !== undefined ? { maxInputUsdPerMillion: number(draft.maxInput) } : {}),
    ...(number(draft.maxOutput) !== undefined ? { maxOutputUsdPerMillion: number(draft.maxOutput) } : {}),
    ...(number(draft.maxCached) !== undefined ? { maxCachedInputUsdPerMillion: number(draft.maxCached) } : {}),
  }
}

/**
 * The buyer's own config in the routing policy editor's layout: sellers,
 * quality and ranking up front (they apply at once), price caps,
 * verification, payments and network behind disclosures (they restart the
 * buyer). One Save; a restart is confirmed first, and only when needed.
 */
export function BuyerSettingsEditor({ buyer }: { buyer: Buyer }) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const peers = usePeers()
  const lists = usePeerLists()
  const incoming = useMemo(() => draftOf(buyer), [buyer])
  const [draft, setDraft] = useState<Draft>(incoming)
  // The saved settings the draft started from; newer ones arriving while there are edits are a conflict.
  const [base, setBase] = useState<Draft>(incoming)
  const [conflict, setConflict] = useState<Draft | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [restartNeeded, setRestartNeeded] = useState(false)
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }))
  const reload = (next: Draft) => {
    setDraft(next)
    setBase(next)
    setConflict(null)
  }
  const errors = draftErrors(draft)
  const changed = changedKeys(base, draft)
  useEffect(() => {
    if (changedKeys(base, incoming).length === 0) return
    if (changed.length === 0 || changedKeys(incoming, draft).length === 0) reload(incoming)
    else setConflict(incoming)
    // Only a change of the saved settings should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming])
  const restarts = changed.some((key) => !LIVE_KEYS.includes(key))
  const overridden = (path: string): ReactNode => (isOverridden(buyer.overrides, path) ? <OverrideNote /> : undefined)
  const hint = (path: string, text?: string): ReactNode => overridden(path) ?? text

  const save = useMutation({
    mutationFn: () => api.settings.updateBuyer(patchOf(draft)),
    onSuccess: (data) => {
      const { restartRequired, ...settings } = data
      queryClient.setQueryData(qk.settings, settings)
      reload(draftOf(settings.buyer))
      void queryClient.invalidateQueries({ queryKey: qk.buyerLimits })
      setConfirming(false)
      setRestartNeeded(restartRequired === true)
      toast(!restarts ? 'Saved. The buyer applies these at once.'
        : restartRequired ? 'Saved. Restart the buyer to apply them.' : 'Saved. The buyer is restarting.')
    },
  })

  const match = useMemo(() => {
    if (!peers.data || peers.data.length === 0) return null
    return { matched: matchingPeers(combinePolicies(draftPolicy(draft)), peers.data, lists.data ?? []).length, total: peers.data.length }
  }, [draft, peers.data, lists.data])

  const caps = `${formatPricePerMillion(Number(draft.maxInput))} in · ${formatPricePerMillion(Number(draft.maxOutput))} out`
  const verification = !draft.verify ? 'Off' : draft.requireVerified ? 'Required' : 'On'
  const payments = `${draft.autoSweep ? 'Auto-sweep on' : 'Auto-sweep off'} · ${formatUsd(Number(draft.maxPerRequest))} per request`
  const field = (key: keyof Draft, label: string, extra: { hint?: ReactNode; placeholder?: string; mono?: boolean; className?: string } = {}) => (
    <TextField size="sm" className={extra.className ?? 'gc-num'} label={label} inputMode="decimal" placeholder={extra.placeholder}
      value={draft[key] as string} error={errors[key]} hint={extra.hint} onChange={(event) => set(key, event.target.value as never)} />
  )

  return (
    <div className="gc-stack">
      <div className="gc-policy">
        {match && (match.matched === 0
          ? <Alert tone="warning" title="No seller matches these settings">None of the {match.total} sellers this gateway sees passes them, so every request will fail.</Alert>
          : <p className="gc-muted" aria-live="polite">Matches {match.matched} of {match.total} sellers. Every key can only narrow this.</p>)}
        <div className="gc-policy__cols">
          <section className="gc-policy__section">
            <h3>Sellers</h3>
            <Segmented label="Which sellers may serve" value={draft.allowMode} onChange={(mode) => set('allowMode', mode)}
              options={[{ value: 'any', label: 'Any seller' }, { value: 'only', label: 'Only these' }]} />
            {draft.allowMode === 'only' && (
              <>
                <PeerPicker label="Allowed sellers" value={draft.allowedPeerIds} onChange={(next) => set('allowedPeerIds', next)} peers={peers.data} />
                {errors.allowedPeerIds && <p className="gc-warn">{errors.allowedPeerIds}</p>}
                {draft.allowedPeerIds.length === 0 && <p className="gc-fineprint">With no sellers listed, any seller may serve.</p>}
              </>
            )}
            <PeerPicker label="Blocked sellers" value={draft.blockedPeerIds} onChange={(next) => set('blockedPeerIds', next)} peers={peers.data} />
            {errors.blockedPeerIds && <p className="gc-warn">{errors.blockedPeerIds}</p>}
            <p className="gc-fineprint">Blocked here means blocked for every key.</p>
          </section>

          <section className="gc-policy__section">
            <h3>Quality and ranking</h3>
            <Slider label="Minimum trust score" info={<TrustTip />} clearable={false} value={draft.minTrustScore} onChange={(next) => set('minTrustScore', next)}
              hint="Keys can raise it, not lower it." />
            {draft.minReputation !== '0' && draft.minReputation !== '' && (
              <p className="gc-fineprint">
                The buyer also asks for reputation {draft.minReputation} or more, an older score the trust score replaces.{' '}
                <Button variant="link" size="sm" onClick={() => set('minReputation', '0')}>Remove it</Button>
              </p>
            )}
            <div className="gc-policy__switches">
              <Switch checked={draft.preferFree} onChange={(next) => set('preferFree', next)} label="Free sellers first" />
            </div>
            {field('softInputCap', 'Soft input price limit $/M', { hint: 'Pricier sellers rank lower; none is excluded.', className: 'gc-num gc-num--wide' })}
          </section>
        </div>

        <div className="gc-policy__advanced">
          <Disclosure title="Price caps" summary={caps}>
            <p className="gc-fineprint">Hard limits for every request, pinned sellers included.</p>
            <div className="gc-policy__caps">
              {field('maxInput', 'Input $/M', { hint: overridden('maxPricing.inputUsdPerMillion') })}
              {field('maxOutput', 'Output $/M', { hint: overridden('maxPricing.outputUsdPerMillion') })}
              {field('maxCached', 'Cached input $/M', { placeholder: 'Same as input' })}
            </div>
          </Disclosure>
          <Disclosure title="Verification" summary={verification}>
            {overridden('verifier')}
            <div className="gc-policy__switches">
              <Switch checked={draft.verify} onChange={(next) => set('verify', next)} label="Verify sellers" />
              <Switch checked={draft.verify && draft.requireVerified} disabled={!draft.verify} onChange={(next) => set('requireVerified', next)} label="Require verification" />
            </div>
            <TextField size="sm" label="Verifiers" value={draft.verifiers} disabled={!draft.verify} placeholder="Seller's trusted default"
              hint="Ordered, comma-separated verifier ids, e.g. TEE attestation." onChange={(event) => set('verifiers', event.target.value)} />
            <div className="gc-policy__caps">
              {field('sampleRate', 'Evidence sample rate', { placeholder: 'Default', hint: 'Share of responses kept, 0 to 1.' })}
              {field('maxSampleBytes', 'Largest sample (bytes)', { placeholder: 'Default', className: 'gc-num gc-num--wide' })}
            </div>
          </Disclosure>
          <Disclosure title="Payments" summary={payments}>
            <Switch checked={draft.autoSweep} onChange={(next) => set('autoSweep', next)} label="Sweep deposits automatically"
              description="Move USDC that arrives in the workspace wallets into their deposits." />
            <div className="gc-policy__caps">
              {field('maxPerRequest', 'Max per request (USDC)', { className: 'gc-num gc-num--wide' })}
              {field('maxReserve', 'Max channel reserve (USDC)', { className: 'gc-num gc-num--wide' })}
            </div>
            <TextField size="sm" label="Base RPC URL" value={draft.rpcUrl} error={errors.rpcUrl} placeholder="Chain default"
              hint={hint('payments.rpcUrl', 'Your own endpoint avoids public rate limits. Saved URLs show without their path; leave them as they are to keep them.')}
              onChange={(event) => set('rpcUrl', event.target.value)} />
            <TextAreaField label="Fallback RPC URLs" rows={2} mono value={draft.fallbackRpcUrls} error={errors.fallbackRpcUrls}
              hint="One per line, tried in order." onChange={(event) => set('fallbackRpcUrls', event.target.value)} />
          </Disclosure>
          <Disclosure title="Network and timeouts" summary={`Refresh ${Math.round(Number(draft.peerRefreshMs) / 1000)} s`}>
            <div className="gc-policy__caps">
              {field('peerRefreshMs', 'Peer refresh (ms)', { className: 'gc-num gc-num--wide' })}
              {field('metadataTimeoutMs', 'Metadata timeout (ms)', { className: 'gc-num gc-num--wide', hint: overridden('network.metadataFetchTimeoutMs') })}
              {field('requestTimeoutMs', 'Response start timeout (ms)', { className: 'gc-num gc-num--wide' })}
              {field('maxStreamMs', 'Longest stream (ms)', { className: 'gc-num gc-num--wide', hint: overridden('network.maxStreamDurationMs') })}
            </div>
            <Switch checked={draft.perServiceMetadata} onChange={(next) => set('perServiceMetadata', next)} label="Per-service attribution in signed metadata"
              description={overridden('network.disableMetadataV2Services') ?? 'Tells sellers which service each request used.'} />
          </Disclosure>
        </div>
      </div>

      {restartNeeded && (
        <Alert tone="warning" title="Restart the buyer to apply">
          Saved, but this buyer was not restarted automatically. Restart it (for example <code>systemctl restart antseed-buyer</code>, or stop and start <code>antseed buyer start</code>) to use the new settings.
        </Alert>
      )}
      {conflict && (
        <Alert tone="warning" title="Changed elsewhere"
          action={<div className="gc-inline gc-inline--wrap">
            <Button size="sm" variant="outline" onClick={() => reload(conflict)}>Reload</Button>
            <Button size="sm" variant="ghost" onClick={() => { setBase(conflict); setConflict(null) }}>Keep editing</Button>
          </div>}>
          Someone saved the buyer settings while you were editing them. Reload to see their version (your edits are dropped), or keep editing and save to replace it.
        </Alert>
      )}
      {!confirming && save.error ? <ErrorAlert error={save.error} title="Could not save" /> : null}
      <div className="gc-actions">
        <span className="gc-fineprint gc-actions__note">
          {changed.length === 0 ? 'No changes.' : restarts ? 'Saving restarts the buyer.' : 'Applies at once, without a restart.'}
        </span>
        <Button variant="ghost" disabled={changed.length === 0 || save.isPending} onClick={() => reload(conflict ?? base)}>Reset</Button>
        <Button disabled={changed.length === 0 || Object.keys(errors).length > 0 || save.isPending}
          onClick={() => (restarts ? setConfirming(true) : save.mutate())}>{save.isPending ? 'Saving…' : 'Save'}</Button>
      </div>
      <ConfirmDialog isOpen={confirming} busy={save.isPending} error={save.error} onClose={() => { setConfirming(false); save.reset() }}
        onConfirm={() => save.mutate()} title="Restart the buyer?" confirmLabel="Save and restart" tone="primary"
        body="These changes need a buyer restart. Requests in flight finish first; new requests wait a few seconds while it reconnects." />
    </div>
  )
}
