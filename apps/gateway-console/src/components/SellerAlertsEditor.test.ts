import { describe, expect, it } from 'vitest'
import { rebaseDraft } from '../lib/settings'
import { mockSellerSettings, mockUpdateSellerAlerts } from '../mock/seller'
import { alertsPatchOf, secretEditorsAfterSave } from './SellerAlertsEditor'

const empty = { chatId: '42', token: '', clearToken: false, webhookUrl: '', clearWebhook: false, idleMinutes: '', cooldownMinutes: '', lowBalanceUsd: '', minSeverity: 'warning' as const }
const tokenA = '123456:AAAAAAAAAAAAAAAAAAAAAAAAA'
const tokenB = '123456:BBBBBBBBBBBBBBBBBBBBBBBBB'

describe('SellerAlertsEditor secrets after a save', () => {
  it('keeps a secret input open while it holds a value typed during the save, and closes it otherwise', () => {
    expect(mockSellerSettings().alerts).toBeTruthy()
    const submitted = { ...empty, token: tokenA, webhookUrl: 'https://hooks.example/a' }
    const saved = mockUpdateSellerAlerts(alertsPatchOf(empty, submitted)).alerts
    const next = { ...empty, chatId: saved.telegram.chatId ?? '' }

    // A newer token was typed before the response: it stays, in view, and the next save sends it.
    const typedDuringSave = rebaseDraft({ ...submitted, token: tokenB }, submitted, next)
    expect(typedDuringSave.token).toBe(tokenB)
    expect(secretEditorsAfterSave(typedDuringSave, saved)).toEqual({ token: true, webhook: false })
    expect(alertsPatchOf(next, typedDuringSave)).toEqual({ telegramBotToken: tokenB })

    // Nothing typed since: both secrets are saved and their inputs close.
    const untouched = rebaseDraft(submitted, submitted, next)
    expect(secretEditorsAfterSave(untouched, saved)).toEqual({ token: false, webhook: false })
    expect(alertsPatchOf(next, untouched)).toEqual({})
  })

  it('keeps an input open when nothing is saved for it', () => {
    const alerts = structuredClone(mockSellerSettings().alerts)
    alerts.telegram.tokenSet = false
    alerts.webhook = { set: false, host: null, source: null }
    expect(secretEditorsAfterSave(empty, alerts)).toEqual({ token: true, webhook: true })
  })
})
