import { describe, expect, it } from 'vitest'
import { routerModelResolver } from './router-model-names.js'

describe('routerModelResolver', () => {
  const resolve = routerModelResolver(['anthropic/claude-opus-5', 'openai/gpt-5', 'claude-opus-5:free'])

  it('prefers an exact router model name', () => {
    expect(resolve('openai/gpt-5')).toBe('openai/gpt-5')
    expect(resolve('claude-opus-5:free')).toBe('claude-opus-5:free')
  })

  it('maps differently spelled names to the router name by canonical key', () => {
    expect(resolve('claude-opus-5')).toBe('anthropic/claude-opus-5')
    expect(resolve('gpt-5')).toBe('openai/gpt-5')
  })

  it('uses the first listed router model when several share a key', () => {
    expect(resolve('anthropic/claude-opus-5-20260813')).toBe('anthropic/claude-opus-5')
  })

  it('returns undefined when the router lists no matching model', () => {
    expect(resolve('mistral-large')).toBeUndefined()
  })
})
