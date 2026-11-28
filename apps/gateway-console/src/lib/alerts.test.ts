import { describe, expect, it } from 'vitest'
import { alertSettingsDraft, alertSettingsErrors, alertSettingsInput, destinationChanges, destinationReady, EMPTY_DESTINATION, newDestinationInput } from './alerts'

describe('alert settings form', () => {
  it('shows saved USD amounts without trailing zeros and sends them back as typed', () => {
    const draft = alertSettingsDraft({ lowBalance: '10.000000', topupTarget: '50.500000', limitWarnPercent: 80, repeatMinutes: 1440 })
    expect(draft).toEqual({ lowBalanceUsd: '10', topupTargetUsd: '50.5', limitWarnPercent: '80', repeatMinutes: '1440' })
    expect(alertSettingsInput({ ...draft, topupTargetUsd: '$60' })).toEqual({ lowBalanceUsd: '10', topupTargetUsd: '60', limitWarnPercent: 80, repeatMinutes: 1440 })
    expect(alertSettingsInput({ lowBalanceUsd: '', topupTargetUsd: ' ', limitWarnPercent: '', repeatMinutes: '' }))
      .toEqual({ lowBalanceUsd: null, topupTargetUsd: null, limitWarnPercent: null, repeatMinutes: null })
  })

  it('flags amounts, percents and a top-up target at or under the threshold', () => {
    expect(alertSettingsErrors({ lowBalanceUsd: '10', topupTargetUsd: '50', limitWarnPercent: '80', repeatMinutes: '' })).toEqual({})
    expect(alertSettingsErrors({ lowBalanceUsd: '0', topupTargetUsd: '', limitWarnPercent: '', repeatMinutes: '' })).toHaveProperty('lowBalanceUsd')
    expect(alertSettingsErrors({ lowBalanceUsd: '10', topupTargetUsd: '10', limitWarnPercent: '', repeatMinutes: '' })).toHaveProperty('topupTargetUsd')
    expect(alertSettingsErrors({ lowBalanceUsd: '', topupTargetUsd: '', limitWarnPercent: '100', repeatMinutes: '' })).toHaveProperty('limitWarnPercent')
    expect(alertSettingsErrors({ lowBalanceUsd: 'ten', topupTargetUsd: '', limitWarnPercent: '', repeatMinutes: '' })).toHaveProperty('lowBalanceUsd')
  })
})

describe('destination form', () => {
  it('sends the bot token only for Telegram on create', () => {
    expect(newDestinationInput({ ...EMPTY_DESTINATION, label: ' Hook ', target: 'https://x.test/h' }))
      .toEqual({ kind: 'webhook', label: 'Hook', target: 'https://x.test/h', events: ['balance', 'limits'] })
    expect(newDestinationInput({ kind: 'telegram', label: 'TG', target: '-1', botToken: '1:abc', events: ['limits'] })).toHaveProperty('botToken', '1:abc')
  })

  it('an edit sends only what changed; blank URL and token keep the saved ones', () => {
    const editing = { label: 'Ops', target: 'https://x.test/…', events: ['limits', 'balance'] as const }
    expect(destinationChanges({ kind: 'webhook', label: 'Ops', target: '', botToken: '', events: ['balance', 'limits'] }, { ...editing, events: [...editing.events] })).toEqual({})
    expect(destinationChanges({ kind: 'webhook', label: 'Ops 2', target: 'https://y.test/h', botToken: '', events: ['balance'] }, { ...editing, events: [...editing.events] }))
      .toEqual({ label: 'Ops 2', target: 'https://y.test/h', events: ['balance'] })
  })

  it('is ready once it names, targets and subscribes to something', () => {
    expect(destinationReady(EMPTY_DESTINATION, false)).toBe(false)
    expect(destinationReady({ ...EMPTY_DESTINATION, label: 'a', target: 'https://x.test' }, false)).toBe(true)
    expect(destinationReady({ ...EMPTY_DESTINATION, kind: 'telegram', label: 'a', target: '-1' }, false)).toBe(false)
    expect(destinationReady({ ...EMPTY_DESTINATION, label: 'a', events: [] }, true)).toBe(false)
    expect(destinationReady({ ...EMPTY_DESTINATION, label: 'a' }, true)).toBe(true)
  })
})
