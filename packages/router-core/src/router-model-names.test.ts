import { describe, expect, it } from 'vitest'
import { routerModelResolver } from './router-model-names.js'

const ids = (...names: string[]) => names.map(id => ({ id }))
const free = { inputUsdPerMillion: 0, cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0 }
const paid = { inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 4 }

describe('routerModelResolver', () => {
  const resolve = routerModelResolver(ids('anthropic/claude-opus-5', 'openai/gpt-5', 'claude-opus-5:free'))

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

  it('passes every service ID through when the router lists *', () => {
    const any = routerModelResolver(ids('*'))
    expect(any('mistral-large')).toBe('mistral-large')
    expect(any('anthropic/claude-opus-5', paid)).toBe('anthropic/claude-opus-5')
  })

  it('still maps pinned names alongside *', () => {
    const pinned = routerModelResolver(ids('*', 'anthropic/claude-opus-5'))
    expect(pinned('claude-opus-5')).toBe('anthropic/claude-opus-5')
    expect(pinned('mistral-large')).toBe('mistral-large')
  })

  it('drops candidates priced above the matched entry maxPricing', () => {
    const freeOnly = routerModelResolver([{ id: '*', maxPricing: free }, { id: 'glm-5', maxPricing: free }, { id: 'gpt-5' }])
    expect(freeOnly('qwen3-8b', free)).toBe('qwen3-8b')
    expect(freeOnly('qwen3-8b', paid)).toBeUndefined()
    expect(freeOnly('glm-5', paid)).toBeUndefined()
    expect(freeOnly('gpt-5', paid)).toBe('gpt-5')
  })

  it('limits only the price fields maxPricing names', () => {
    const cheapInput = routerModelResolver([{ id: '*', maxPricing: { inputUsdPerMillion: 1 } }])
    expect(cheapInput('m', paid)).toBe('m')
    expect(cheapInput('m', { ...paid, inputUsdPerMillion: 2 })).toBeUndefined()
  })
})
