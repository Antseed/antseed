import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, Disclosure, Segmented, TextField, useToast } from '@antseed/ui'
import { api } from '../api'
import type { SellerAlertSettings, SellerAlertsPatch, SellerAlertsState, TelegramChat } from '../api/types'
import { formatRelative } from '../lib/format'
import { numberFieldError, rebaseDraft } from '../lib/settings'
import { qk } from '../lib/queries'
import { ErrorAlert, Mono } from './ui'

type Severity = 'info' | 'warning' | 'critical'
const SEVERITIES: Array<{ value: Severity; label: string }> = [
  { value: 'info', label: 'Everything' },
  { value: 'warning', label: 'Warnings' },
  { value: 'critical', label: 'Critical only' },
]

/** Secret inputs: empty keeps the saved value; `clear` removes it. */
interface Draft {
  chatId: string
  token: string
  clearToken: boolean
  webhookUrl: string
  clearWebhook: boolean
  idleMinutes: string
  cooldownMinutes: string
  lowBalanceUsd: string
  minSeverity: Severity
}

function draftOf(alerts: SellerAlertSettings): Draft {
  return {
    chatId: alerts.telegram.chatId ?? '',
    token: '',
    clearToken: false,
    webhookUrl: '',
    clearWebhook: false,
    idleMinutes: alerts.idleMinutes === null ? '' : String(alerts.idleMinutes),
    cooldownMinutes: alerts.cooldownMinutes === null ? '' : String(alerts.cooldownMinutes),
    lowBalanceUsd: alerts.lowBalanceUsd === null ? '' : String(alerts.lowBalanceUsd),
    minSeverity: alerts.minSeverity ?? 'warning',
  }
}

export function alertsPatchOf(base: Draft, draft: Draft): SellerAlertsPatch {
  const patch: SellerAlertsPatch = {}
  if (draft.chatId.trim() !== base.chatId) patch.telegramChatId = draft.chatId.trim() || null
  if (draft.clearToken) patch.telegramBotToken = null
  else if (draft.token.trim()) patch.telegramBotToken = draft.token.trim()
  if (draft.clearWebhook) patch.webhookUrl = null
  else if (draft.webhookUrl.trim()) patch.webhookUrl = draft.webhookUrl.trim()
  if (draft.idleMinutes !== base.idleMinutes) patch.idleMinutes = draft.idleMinutes.trim() === '' ? null : Number(draft.idleMinutes)
  if (draft.cooldownMinutes !== base.cooldownMinutes) patch.cooldownMinutes = draft.cooldownMinutes.trim() === '' ? null : Number(draft.cooldownMinutes)
  if (draft.lowBalanceUsd !== base.lowBalanceUsd) patch.lowBalanceUsd = draft.lowBalanceUsd.trim() === '' ? null : Number(draft.lowBalanceUsd)
  if (draft.minSeverity !== base.minSeverity) patch.minSeverity = draft.minSeverity
  return patch
}

/**
 * Which secret inputs stay open after a save: one with nothing saved, or one
 * still holding a value typed while the save was in flight (it would be sent
 * by the next save, so it must stay in view).
 */
export function secretEditorsAfterSave(draft: Pick<Draft, 'token' | 'webhookUrl'>, alerts: SellerAlertSettings): { token: boolean; webhook: boolean } {
  return {
    token: !alerts.telegram.tokenSet || draft.token.trim() !== '',
    webhook: !alerts.webhook.set || draft.webhookUrl.trim() !== '',
  }
}

function SecretState({ label, onReplace, onClear, cleared, readOnly }: { label: string; onReplace: () => void; onClear?: () => void; cleared: boolean; readOnly: boolean }) {
  return (
    <div className="gc-seller-secret">
      <span className="gc-fineprint">{cleared ? 'Will be removed when you save.' : label}</span>
      {!readOnly && <Button size="sm" variant="link" onClick={onReplace}>Replace</Button>}
      {!readOnly && onClear && <Button size="sm" variant="link" onClick={onClear}>{cleared ? 'Keep' : 'Remove'}</Button>}
    </div>
  )
}

/**
 * Where seller alerts go. The bot token and webhook URL are saved on the
 * seller's host in a secrets file and never shown again; the rest goes to
 * config.json. A running seller picks changes up within seconds.
 */
export function SellerAlertsEditor({ alerts, state }: { alerts: SellerAlertSettings; state: SellerAlertsState | null }) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [base, setBase] = useState(() => draftOf(alerts))
  const [draft, setDraft] = useState(base)
  const [editToken, setEditToken] = useState(!alerts.telegram.tokenSet)
  const [editWebhook, setEditWebhook] = useState(!alerts.webhook.set)
  const [chats, setChats] = useState<TelegramChat[] | null>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft
  useEffect(() => {
    const next = draftOf(alerts)
    setDraft(rebaseDraft(draft, base, next))
    setBase(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alerts])
  const readOnly = !alerts.writable
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }))
  const patch = alertsPatchOf(base, draft)
  const changed = Object.keys(patch).length > 0
  const errors: Record<string, string | undefined> = {
    token: draft.token.trim() && !/^\d{3,}:[A-Za-z0-9_-]{20,}$/.test(draft.token.trim()) ? 'A bot token looks like 123456:ABC…, from @BotFather.' : undefined,
    chatId: draft.chatId.trim() && !/^(-?\d{1,20}|@[A-Za-z0-9_]{4,64})$/.test(draft.chatId.trim()) ? 'A number (negative for groups) or @channelname.' : undefined,
    webhookUrl: draft.webhookUrl.trim() && !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(draft.webhookUrl.trim()) ? 'Use an https URL.' : undefined,
    idleMinutes: numberFieldError(draft.idleMinutes, { min: 1, max: 10_080, integer: true }),
    cooldownMinutes: numberFieldError(draft.cooldownMinutes, { min: 0, max: 10_080, integer: true }),
    lowBalanceUsd: numberFieldError(draft.lowBalanceUsd, { min: 0 }),
  }
  const invalid = Object.values(errors).some(Boolean)

  const save = useMutation({
    mutationFn: (submitted: { patch: SellerAlertsPatch; draft: Draft }) => api.seller.updateAlerts(submitted.patch),
    onSuccess: (data, submitted) => {
      queryClient.setQueryData(qk.sellerSettings, { settings: data.settings, alerts: data.alerts, restart: data.restart })
      // "Sending to" on the status comes from the seller.
      void queryClient.invalidateQueries({ queryKey: qk.sellerStatus })
      const next = draftOf(data.alerts)
      setBase(next)
      // Edits typed while the save was in flight stay; the rest takes the saved values.
      const rebased = rebaseDraft(draftRef.current, submitted.draft, next)
      draftRef.current = rebased
      setDraft(rebased)
      const editors = secretEditorsAfterSave(rebased, data.alerts)
      setEditToken(editors.token)
      setEditWebhook(editors.webhook)
      toast('Saved. The seller applies alert settings within a few seconds.')
    },
  })
  const test = useMutation({
    mutationFn: (channel: 'telegram' | 'webhook') => api.seller.testAlert(channel),
    onSuccess: (result, channel) => toast(result.sent.length > 0 ? `Test sent to ${channel === 'telegram' ? 'Telegram' : 'the webhook'}.` : `Test failed: ${result.errors.join('; ')}`),
  })
  const findChats = useMutation({
    mutationFn: () => api.seller.telegramChats(draft.token.trim() || undefined),
    onSuccess: (result) => setChats(result.chats),
  })

  const telegramReady = alerts.telegram.active && !changed
  const webhookReady = alerts.webhook.set && !changed
  const canFind = Boolean(draft.token.trim() && !errors.token) || (alerts.telegram.tokenSet && !draft.clearToken)

  return (
    <div className="gc-stack">
      {readOnly && <p className="gc-seller-notice"><span className="gc-attention" aria-hidden="true" />{alerts.readOnlyReason}</p>}
      {state?.lastError && <p className="gc-seller-notice"><span className="gc-attention" aria-hidden="true" />The last alert could not be delivered: {state.lastError}</p>}
      <div className="gc-policy">
        <div className="gc-policy__cols">
          <section className="gc-policy__section">
            <h3>Telegram</h3>
            {alerts.telegram.tokenSource === 'env' ? (
              <p className="gc-fineprint">Bot token from <Mono>{alerts.telegram.botTokenEnv}</Mono> in the seller's environment.</p>
            ) : editToken ? (
              <TextField size="sm" type="password" autoComplete="off" mono label="Bot token" placeholder="123456:ABC…" disabled={readOnly}
                value={draft.token} error={errors.token} hint="Create a bot with @BotFather. Saved on the seller's host, never shown again."
                onChange={(event) => set('token', event.target.value)} />
            ) : (
              <SecretState label="Bot token saved on the seller's host." cleared={draft.clearToken} readOnly={readOnly}
                onReplace={() => { setEditToken(true); set('clearToken', false) }} onClear={() => set('clearToken', !draft.clearToken)} />
            )}
            <div className="gc-inline">
              <TextField size="sm" mono label="Chat id" placeholder="-1001234567890" disabled={readOnly} value={draft.chatId} error={errors.chatId}
                onChange={(event) => set('chatId', event.target.value)} />
              {!readOnly && <Button size="sm" variant="outline" className="gc-seller-inline-button" disabled={!canFind || findChats.isPending} onClick={() => findChats.mutate()}>{findChats.isPending ? 'Looking…' : 'Find chat'}</Button>}
            </div>
            {findChats.error ? <ErrorAlert error={findChats.error} title="Could not list chats" /> : null}
            {chats && (chats.length === 0
              ? <p className="gc-fineprint">No chats yet. Send the bot a message, or add it to a group and post there, then try again.</p>
              : (
                <div className="gc-seller-chats" role="list" aria-label="Recent chats">
                  {chats.map((chat) => (
                    <button key={chat.id} type="button" role="listitem" className={chat.id === draft.chatId ? 'gc-seller-chat gc-seller-chat--on' : 'gc-seller-chat'} onClick={() => set('chatId', chat.id)}>
                      <span>{chat.title}</span><span className="gc-fineprint">{chat.type} · {chat.id}</span>
                    </button>
                  ))}
                </div>
              ))}
            {!chats && !readOnly && <p className="gc-fineprint">Send the bot a message (or add it to a group) first, then Find chat lists it.</p>}
            <div className="gc-actions gc-actions--start gc-seller-test">
              <Button size="sm" variant="outline" disabled={!telegramReady || test.isPending} onClick={() => test.mutate('telegram')}>Send test</Button>
              {!telegramReady && <span className="gc-fineprint">{changed ? 'Save first.' : 'Needs a bot token and a chat id.'}</span>}
            </div>
          </section>
          <section className="gc-policy__section">
            <h3>Webhook</h3>
            {editWebhook ? (
              <TextField size="sm" mono label="URL" placeholder="https://hooks.slack.com/services/…" disabled={readOnly} value={draft.webhookUrl} error={errors.webhookUrl}
                hint="Receives each alert as JSON with text and content fields (Slack and Discord read these). Saved on the seller's host; only the host is shown."
                onChange={(event) => set('webhookUrl', event.target.value)} />
            ) : (
              <SecretState label={`Posts to ${alerts.webhook.host}${alerts.webhook.source === 'config' ? ' (from config.json)' : ''}.`} cleared={draft.clearWebhook} readOnly={readOnly}
                onReplace={() => { setEditWebhook(true); set('clearWebhook', false) }} onClear={() => set('clearWebhook', !draft.clearWebhook)} />
            )}
            <div className="gc-actions gc-actions--start gc-seller-test">
              <Button size="sm" variant="outline" disabled={!webhookReady || test.isPending} onClick={() => test.mutate('webhook')}>Send test</Button>
              {!webhookReady && <span className="gc-fineprint">{changed ? 'Save first.' : 'Needs a URL.'}</span>}
            </div>
            {state && <p className="gc-fineprint">Last alert: {formatRelative(state.lastSentAt)}. Sending to: {state.channels.length > 0 ? state.channels.join(', ') : 'nowhere yet'}.</p>}
          </section>
        </div>
        <div className="gc-policy__advanced">
          <Disclosure title="What is sent" summary={`${SEVERITIES.find((entry) => entry.value === draft.minSeverity)!.label}${draft.idleMinutes ? ` · quiet after ${draft.idleMinutes} min` : ''}`}>
            <Segmented label="Lowest severity sent" value={draft.minSeverity} onChange={(value) => set('minSeverity', value)} options={SEVERITIES} />
            <p className="gc-fineprint">Warnings: a model withdrawn, an upstream's balance running low, the seller quiet, an unexpected restart. Critical: out of gas, an upstream out of credit. Recoveries always follow an alert that went out.</p>
            <div className="gc-policy__caps">
              <TextField size="sm" className="gc-num gc-num--wide" label="Quiet alert after (min)" inputMode="numeric" placeholder="Off" disabled={readOnly}
                value={draft.idleMinutes} error={errors.idleMinutes} onChange={(event) => set('idleMinutes', event.target.value)} />
              <TextField size="sm" className="gc-num gc-num--wide" label="Repeat at most every (min)" inputMode="numeric" placeholder="30" disabled={readOnly}
                value={draft.cooldownMinutes} error={errors.cooldownMinutes} onChange={(event) => set('cooldownMinutes', event.target.value)} />
              <TextField size="sm" className="gc-num gc-num--wide" label="Low upstream balance ($)" inputMode="decimal" placeholder="5" hint="0 turns it off" disabled={readOnly}
                value={draft.lowBalanceUsd} error={errors.lowBalanceUsd} onChange={(event) => set('lowBalanceUsd', event.target.value)} />
            </div>
          </Disclosure>
        </div>
      </div>
      {test.error ? <ErrorAlert error={test.error} title="Could not send the test" /> : null}
      {save.error ? <ErrorAlert error={save.error} title="Could not save" /> : null}
      {!readOnly && (
        <div className="gc-actions">
          <span className="gc-fineprint gc-actions__note">{changed ? 'Applies within a few seconds, without a restart.' : 'No changes.'}</span>
          <Button variant="ghost" disabled={!changed || save.isPending} onClick={() => { setDraft(base); setEditToken(!alerts.telegram.tokenSet); setEditWebhook(!alerts.webhook.set) }}>Reset</Button>
          <Button disabled={!changed || invalid || save.isPending} onClick={() => save.mutate({ patch, draft })}>{save.isPending ? 'Saving…' : 'Save'}</Button>
        </div>
      )}
    </div>
  )
}
