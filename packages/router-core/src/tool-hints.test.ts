import { describe, expect, it } from 'vitest'
import { WELL_KNOWN_TOOL_HINTS, formatToolHints, toolHintBaseUrl } from './tool-hints.js'

describe('toolHintBaseUrl', () => {
  it('adds /v1 for OpenAI-style variables and keeps the root for Anthropic', () => {
    expect(toolHintBaseUrl('OPENAI_BASE_URL', 'http://localhost:8377')).toBe('http://localhost:8377/v1')
    expect(toolHintBaseUrl('OPENAI_API_BASE', 'http://localhost:8377')).toBe('http://localhost:8377/v1')
    expect(toolHintBaseUrl('ANTHROPIC_BASE_URL', 'http://localhost:8377')).toBe('http://localhost:8377')
  })

  it('keeps a custom port and ignores a trailing slash', () => {
    expect(toolHintBaseUrl('OPENAI_BASE_URL', 'http://localhost:18377/')).toBe('http://localhost:18377/v1')
    expect(toolHintBaseUrl('ANTHROPIC_BASE_URL', 'http://localhost:18377/')).toBe('http://localhost:18377')
  })
})

describe('formatToolHints', () => {
  it('prints the right base URL for each well-known tool', () => {
    expect(formatToolHints(WELL_KNOWN_TOOL_HINTS, 'http://localhost:8377')).toEqual([
      'export ANTHROPIC_BASE_URL=http://localhost:8377   # Claude Code',
      'export OPENAI_API_BASE=http://localhost:8377/v1   # Aider',
      'export OPENAI_BASE_URL=http://localhost:8377/v1   # Continue.dev',
      'export OPENAI_BASE_URL=http://localhost:8377/v1   # Codex',
    ])
  })
})
