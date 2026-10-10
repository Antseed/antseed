import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractConversationIdentity,
  extractFirstUserSnippet,
  isCompletionRequestPath,
  isTitleGenerationRequest,
} from './conversation-identity.js'

const CURSOR_ENVIRONMENT = `<user_info>
OS Version: darwin 25.2.0
Shell: zsh
Workspace Path: unknown
Is directory a git repo: No
Today's Date: August 25, 2026
</user_info>
<dynamic_tool_catalog>machine-generated tool instructions</dynamic_tool_catalog>`

const cursorQuery = (prompt: string, time = '5:01 PM'): string => `<timestamp>Tuesday, Aug 25, 2026, ${time} (UTC+3)</timestamp>
<user_query>
${prompt}
</user_query>`

test('isCompletionRequestPath matches API turn endpoints', () => {
  assert.equal(isCompletionRequestPath('/v1/messages'), true)
  assert.equal(isCompletionRequestPath('/v1/messages?beta=true'), true)
  assert.equal(isCompletionRequestPath('/v1/chat/completions'), true)
  assert.equal(isCompletionRequestPath('/v1/completions'), true)
  assert.equal(isCompletionRequestPath('/v1/responses'), true)
  assert.equal(isCompletionRequestPath('/v1/models'), false)
  assert.equal(isCompletionRequestPath('/_antseed/route'), false)
})

test('claude code identity comes from x-claude-code-session-id', () => {
  const identity = extractConversationIdentity({
    'user-agent': 'claude-cli/2.1.216 (external, sdk-cli)',
    'x-claude-code-session-id': '43ddc5e7-0b8e-491f-a5d1-f2a6854f689d',
  }, null)
  assert.deepEqual(identity, {
    tool: 'claude-code',
    sessionKey: '43ddc5e7-0b8e-491f-a5d1-f2a6854f689d',
    parentSessionKey: null,
    isUserThread: true,
  })
})

test('system proxy source profile wins over SDK client identity for intercepted traffic', () => {
  const identity = extractConversationIdentity({
    'user-agent': 'claude-cli/2.1.216 (external, sdk-cli)',
    'x-antseed-system-proxy-source': 'custom-api-anthropic-com',
    'x-claude-code-session-id': '43ddc5e7-0b8e-491f-a5d1-f2a6854f689d',
  }, null)
  assert.deepEqual(identity, {
    tool: 'custom-api-anthropic-com',
    sessionKey: '43ddc5e7-0b8e-491f-a5d1-f2a6854f689d',
    parentSessionKey: null,
    isUserThread: true,
  })
})

test('turn metadata marks a tool-opened thread as not a user chat', () => {
  const meta = (threadSource: string): string => JSON.stringify({
    thread_id: '019f9adc-ad46-7ba1-bdfc-b9612c116462',
    request_kind: 'turn',
    thread_source: threadSource,
  })
  const headers = (turnMetadata: string): Record<string, string> => ({
    'originator': 'Codex Desktop',
    'thread-id': '019f9adc-ad46-7ba1-bdfc-b9612c116462',
    'x-codex-turn-metadata': turnMetadata,
  })
  // Codex titles a new chat from a system thread of its own.
  assert.equal(extractConversationIdentity(headers(meta('system')), null)?.isUserThread, false)
  assert.equal(extractConversationIdentity(headers(meta('user')), null)?.isUserThread, true)
  // Missing, unparseable or silent metadata is taken as a user chat.
  assert.equal(extractConversationIdentity(headers('{not json'), null)?.isUserThread, true)
  assert.equal(extractConversationIdentity(headers('{}'), null)?.isUserThread, true)
  assert.equal(extractConversationIdentity({ 'thread-id': 't1' }, null)?.isUserThread, true)
})

test('user-agent product token identifies the tool generically', () => {
  const identity = extractConversationIdentity(
    { 'user-agent': 'claude-cli/2.1.216 (external, sdk-cli)' },
    { metadata: { user_id: JSON.stringify({ device_id: 'abc', session_id: 'sess-123' }) } },
  )
  assert.equal(identity?.tool, 'claude-cli')
  assert.equal(identity?.sessionKey, 'sess-123')
})

test('originator header names the client and thread-id wins as session key', () => {
  const identity = extractConversationIdentity({
    'originator': 'codex_exec',
    'user-agent': 'codex_exec/0.138.0 (Mac OS 26.2.0; arm64)',
    'session-id': '019f83b7-0e98-7bc0-9d74-afd5e8844b76',
    'thread-id': '019f83b7-0e98-7bc0-9d74-afd5e8844b76',
  }, null)
  assert.equal(identity?.tool, 'codex-exec')
  assert.equal(identity?.sessionKey, '019f83b7-0e98-7bc0-9d74-afd5e8844b76')
})

test('prompt_cache_key body field works as the session key fallback', () => {
  const identity = extractConversationIdentity(
    { 'user-agent': 'codex_exec/0.138.0' },
    { prompt_cache_key: '019f83b8-2914-7c90-94e6-3b5fc34335cd' },
  )
  assert.equal(identity?.tool, 'codex-exec')
  assert.equal(identity?.sessionKey, '019f83b8-2914-7c90-94e6-3b5fc34335cd')
})

test('opencode identity uses x-session-id and carries the parent session', () => {
  const identity = extractConversationIdentity({
    'user-agent': 'opencode/1.2.3',
    'x-session-id': 'ses_abc',
    'x-session-affinity': 'ses_abc',
    'x-parent-session-id': 'ses_parent',
  }, null)
  assert.deepEqual(identity, { tool: 'opencode', sessionKey: 'ses_abc', parentSessionKey: 'ses_parent', isUserThread: true })
})

test('any x-<tool>-session-id header identifies the tool generically', () => {
  const identity = extractConversationIdentity({
    'user-agent': 'SomeNewTool/0.1',
    'x-cursor-session-id': 'sess-42',
  }, null)
  assert.deepEqual(identity, { tool: 'cursor', sessionKey: 'sess-42', parentSessionKey: null, isUserThread: true })
})

test('x-parent-session-id is never mistaken for a tool session header', () => {
  const identity = extractConversationIdentity({
    'user-agent': 'opencode/1.0',
    'x-session-id': 'ses_child',
    'x-parent-session-id': 'ses_parent',
  }, null)
  assert.deepEqual(identity, { tool: 'opencode', sessionKey: 'ses_child', parentSessionKey: 'ses_parent', isUserThread: true })
})

test('requests without any identity return null', () => {
  assert.equal(extractConversationIdentity({ 'user-agent': 'curl/8.0' }, { model: 'x' }), null)
  assert.equal(extractConversationIdentity({}, null), null)
})

test('identified clients without a session id get a stable synthetic conversation key', () => {
  const firstRequest = {
    model: 'antseed',
    messages: [
      { role: 'system', content: 'You are Hermes.' },
      { role: 'user', content: 'Refactor the payment service.' },
    ],
  }
  const laterRequest = {
    ...firstRequest,
    messages: [
      ...firstRequest.messages,
      { role: 'assistant', content: 'I will inspect it.' },
      { role: 'user', content: 'Start with the retry logic.' },
    ],
  }
  const first = extractConversationIdentity({ originator: 'hermes' }, firstRequest)
  const later = extractConversationIdentity({ originator: 'hermes' }, laterRequest)
  assert.equal(first?.tool, 'hermes')
  assert.match(first?.sessionKey ?? '', /^synthetic-[0-9a-f]{32}$/)
  assert.equal(later?.sessionKey, first?.sessionKey)
})

test('Prime Agent responses requests key on the originator plus a synthetic first-turn key', () => {
  // Prime Agent's session engine sends no prompt_cache_key; the connected-app
  // config adds `originator: prime-agent` to its custom provider headers.
  const firstRequest = {
    model: 'antseed',
    input: [
      { role: 'developer', content: 'You are Prime Agent.' },
      { role: 'user', content: [{ type: 'input_text', text: 'Profile the data loader.' }] },
    ],
    stream: true,
    store: false,
  }
  const laterRequest = {
    ...firstRequest,
    input: [
      ...firstRequest.input,
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Looking now.' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'Now the cache.' }] },
    ],
  }
  const first = extractConversationIdentity({ originator: 'prime-agent' }, firstRequest)
  const later = extractConversationIdentity({ originator: 'prime-agent' }, laterRequest)
  assert.equal(first?.tool, 'prime-agent')
  assert.match(first?.sessionKey ?? '', /^synthetic-[0-9a-f]{32}$/)
  assert.equal(later?.sessionKey, first?.sessionKey)
})

test('cursor synthetic conversation keys use the prompt after the environment preamble', () => {
  const headers = {
    'user-agent': 'Cursor/1.0',
    // Covers older tunnel gateways which forwarded Cursor's User-Agent but
    // stamped every request with the generic public-tunnel source.
    'x-antseed-system-proxy-source': 'public-tunnel',
  }
  const first = extractConversationIdentity(headers, {
    messages: [
      { role: 'user', content: CURSOR_ENVIRONMENT },
      { role: 'user', content: cursorQuery('Fix the login bug.') },
    ],
  })
  const later = extractConversationIdentity(headers, {
    messages: [
      { role: 'user', content: CURSOR_ENVIRONMENT },
      { role: 'user', content: cursorQuery('Fix the login bug.') },
      { role: 'assistant', content: 'I will inspect it.' },
      { role: 'user', content: cursorQuery('Start with auth.ts.', '5:02 PM') },
    ],
  })
  const otherChat = extractConversationIdentity(headers, {
    messages: [
      { role: 'user', content: CURSOR_ENVIRONMENT },
      // The prompt can be identical in two newly-opened chats. Cursor's
      // retained first-turn timestamp distinguishes them on later requests.
      { role: 'user', content: cursorQuery('Fix the login bug.', '5:03 PM') },
    ],
  })
  assert.equal(first?.tool, 'cursor')
  assert.match(first?.sessionKey ?? '', /^synthetic-[0-9a-f]{32}$/)
  assert.equal(later?.sessionKey, first?.sessionKey)
  assert.notEqual(otherChat?.sessionKey, first?.sessionKey)
})

test('Cursor User-Agent creates identity without a tunnel source header', () => {
  const identity = extractConversationIdentity({ 'user-agent': 'Cursor/1.0' }, {
    messages: [
      { role: 'user', content: CURSOR_ENVIRONMENT },
      { role: 'user', content: [{ type: 'text', text: cursorQuery('hi') }] },
    ],
  })

  assert.equal(identity?.tool, 'cursor')
  assert.match(identity?.sessionKey ?? '', /^synthetic-[0-9a-f]{32}$/)
})

test('synthetic conversation keys ignore title-only housekeeping requests', () => {
  assert.equal(extractConversationIdentity({ originator: 'hermes' }, {
    messages: [{ role: 'user', content: 'Generate a title for this conversation:' }],
  }), null)
})

test('snippet: anthropic messages with string content', () => {
  const snippet = extractFirstUserSnippet({
    messages: [{ role: 'user', content: 'fix the login bug in auth.ts' }],
  })
  assert.equal(snippet, 'fix the login bug in auth.ts')
})

test('snippet: anthropic messages skip system-reminder blocks', () => {
  const snippet = extractFirstUserSnippet({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '<system-reminder>context stuff</system-reminder>' },
        { type: 'text', text: 'actual user question here' },
      ],
    }],
  })
  assert.equal(snippet, 'actual user question here')
})

test('snippet: responses input items skip environment context', () => {
  const snippet = extractFirstUserSnippet({
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd=/tmp</environment_context>' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'say hi' }] },
    ],
  })
  assert.equal(snippet, 'say hi')
})

test('snippet: cursor environment preamble never becomes the title', () => {
  assert.equal(extractFirstUserSnippet({
    messages: [
      { role: 'user', content: CURSOR_ENVIRONMENT },
      { role: 'user', content: cursorQuery('Fix the login bug.') },
    ],
  }), 'Fix the login bug.')
  assert.equal(extractFirstUserSnippet({
    messages: [{ role: 'user', content: CURSOR_ENVIRONMENT }],
  }), null)
  assert.equal(extractFirstUserSnippet({
    messages: [
      { role: 'user', content: '<user_info>OS Version: darwin 25.2.0\nShell: zsh</user_info>' },
      { role: 'user', content: cursorQuery('Fix the login bug.') },
    ],
  }), 'Fix the login bug.')
})

test('snippet: responses string input, whitespace collapsed and truncated', () => {
  assert.equal(extractFirstUserSnippet({ input: 'hello\n\n  world' }), 'hello world')
  const long = 'a'.repeat(500)
  const snippet = extractFirstUserSnippet({ input: long })
  assert.ok(snippet !== null && snippet.length <= 80)
  assert.ok(snippet.endsWith('…'))
})

test('snippet: xml-ish tags are stripped from labels', () => {
  assert.equal(
    extractFirstUserSnippet({ messages: [{ role: 'user', content: '<session> try to understand who reviews are from </session>' }] }),
    'try to understand who reviews are from',
  )
  // Pure-markup candidates are passed over in favor of real text.
  assert.equal(
    extractFirstUserSnippet({
      messages: [
        { role: 'user', content: '<context></context>' },
        { role: 'user', content: 'real question' },
      ],
    }),
    'real question',
  )
})

test('snippet: falls back to machine context when nothing else exists', () => {
  const snippet = extractFirstUserSnippet({
    messages: [{ role: 'user', content: '<system-reminder>only this</system-reminder>' }],
  })
  assert.equal(snippet, 'only this')
})

test('snippet: opencode title request surfaces the embedded real prompt', () => {
  // ensureTitle sends [instruction, ...real conversation] on the SAME session.
  const snippet = extractFirstUserSnippet({
    messages: [
      { role: 'user', content: 'Generate a title for this conversation:\n' },
      { role: 'user', content: 'hi' },
    ],
  })
  assert.equal(snippet, 'hi')
})

test('snippet: pure title request yields null, never a label', () => {
  assert.equal(extractFirstUserSnippet({
    messages: [{ role: 'user', content: 'Please write a 5-10 word title for the following conversation:\n\nuser: hello' }],
  }), null)
  assert.equal(extractFirstUserSnippet({
    messages: [{ role: 'user', content: 'Generate a brief title that would help the user find this conversation later.' }],
  }), null)
})

test('claude desktop title housekeeping is recognized and never labels a chat', () => {
  // Claude Desktop fires this from a session id of its own; without the
  // prefix it becomes a phantom chat row per new Claude conversation.
  const body = {
    messages: [{
      role: 'user',
      content: 'You are coming up with a succinct title for an agent chat session based on the messages so far.',
    }],
  }
  assert.equal(isTitleGenerationRequest(body), true)
  assert.equal(extractFirstUserSnippet(body), null)
})

test('snippet: injected project-doc blobs never label a chat', () => {
  // Codex sends AGENTS.md/CLAUDE.md contents as a user message ahead of the
  // real prompt; the doc must be skipped in favor of the genuine turn.
  assert.equal(extractFirstUserSnippet({
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /Users/shahafan/Development/antseed\n\n# CLAUDE.md --...' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd=/tmp</environment_context>' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the failing tests' }] },
    ],
  }), 'fix the failing tests')
  // A doc-only request yields null instead of falling back to the blob —
  // even when wrapped in a machine-context tag.
  assert.equal(extractFirstUserSnippet({
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<user_instructions># AGENTS.md instructions for /repo ...</user_instructions>' }] },
    ],
  }), null)
})

test('snippet: Codex recommended plugins never label a chat', () => {
  const pluginContext = `<recommended_plugins>
Here is a list of plugins that are available but not installed.

- Airtable
- GitHub
</recommended_plugins>`
  assert.equal(extractFirstUserSnippet({
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: pluginContext }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the Cursor icon' }] },
    ],
  }), 'fix the Cursor icon')
  assert.equal(extractFirstUserSnippet({
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Here is a list of plugins that are available but not installed. - Airtable' }] },
    ],
  }), null)
})

test('sanitizeStoredSnippet heals stored project-doc labels to empty', async () => {
  const { sanitizeStoredSnippet } = await import('./conversation-identity.js')
  assert.equal(sanitizeStoredSnippet('# AGENTS.md instructions for /Users/shahafan/Development/antseed # CLAUDE.md --…'), '')
  assert.equal(sanitizeStoredSnippet('OS Version: darwin 25.2.0 Shell: zsh Workspace Path: unknown Is directory a git…'), '')
  assert.equal(sanitizeStoredSnippet('Here is a list of plugins that are available but not installed. - Airtable…'), '')
  assert.equal(sanitizeStoredSnippet('fix the login bug'), 'fix the login bug')
})

test('snippet: null for empty or non-conversation bodies', () => {
  assert.equal(extractFirstUserSnippet(null), null)
  assert.equal(extractFirstUserSnippet({ model: 'x' }), null)
  assert.equal(extractFirstUserSnippet({ messages: [{ role: 'assistant', content: 'hi' }] }), null)
})

test('title turns are recognised so they cannot define a chat model', () => {
  // OpenCode's verbatim shape: the instruction is its own leading message and
  // the conversation being titled follows it, on the chat's own session id.
  assert.equal(isTitleGenerationRequest({
    messages: [
      { role: 'user', content: 'Generate a title for this conversation:\n' },
      { role: 'user', content: 'hi' },
    ],
  }), true)
  // Claude Code's phrasing, as a Responses-style item list.
  assert.equal(isTitleGenerationRequest({
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Please write a 5-10 word title for the following conversation' }],
    }],
  }), true)
  // T3 Code's Claude agent title prompt.
  assert.equal(isTitleGenerationRequest({
    messages: [{ role: 'user', content: 'You write concise thread titles for a coding chat.' }],
  }), true)
  // Factory/Droid puts the real first user message in the user role. Its
  // title-specific system text follows a shared provider preamble, so the
  // marker is not at the start of the instruction block.
  const droidTitleRequest = {
    messages: [
      {
        role: 'system',
        content: `Shared provider compatibility preamble.
You are a helper that generates concise session titles for a session picker.
Input: one user message from the start of a session.`,
      },
      { role: 'user', content: 'wowow' },
    ],
  }
  assert.equal(isTitleGenerationRequest(droidTitleRequest), true)

  assert.equal(isTitleGenerationRequest({
    instructions: `Shared provider compatibility preamble.
You are a helper that generates concise session titles for a session picker.`,
    input: 'wowow',
  }), true)
  assert.equal(isTitleGenerationRequest({
    input: [{
      type: 'message',
      role: 'developer',
      content: 'You are a helper that generates concise session titles for a session picker.',
    }],
  }), true)
})

test('real turns are not mistaken for title turns', () => {
  assert.equal(isTitleGenerationRequest({ messages: [{ role: 'user', content: 'hi' }] }), false)
  // Only the leading message counts — a later turn quoting the instruction
  // (it is in the history once titling ran) is still a real turn.
  assert.equal(isTitleGenerationRequest({
    messages: [
      { role: 'system', content: 'You are a helpful coding assistant.' },
      { role: 'user', content: 'fix the failing tests' },
      { role: 'user', content: 'Generate a title for this conversation:' },
    ],
  }), false)
  // Broad title phrasing in instructions is not enough; instruction-role
  // detection deliberately uses only exact known housekeeping markers.
  assert.equal(isTitleGenerationRequest({
    instructions: 'Generate a title for this session',
    input: 'wowow',
  }), false)
  assert.equal(isTitleGenerationRequest({
    messages: [
      { role: 'system', content: 'Generate a title for this session' },
      { role: 'user', content: 'wowow' },
    ],
  }), false)
  assert.equal(isTitleGenerationRequest(null), false)
  assert.equal(isTitleGenerationRequest({ model: 'x' }), false)
})
