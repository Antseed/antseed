import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as net from 'node:net'
import * as tls from 'node:tls'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildBuyerForwardRequest,
  ConversationSseAdapter,
  ResponsesSseNormalizer,
  rewriteRequestBody,
  transformRequestBody,
  shouldSystemProxyRequest,
  SystemProxyServer,
} from './proxy-server.js'
import { CAManager } from './ca-manager.js'
import { CertCache } from './cert-cache.js'
import type { SystemProxyForwardRule } from './types.js'

const CONVERSATION_FORWARD_RULE: SystemProxyForwardRule = {
  source: 'conversation',
  targetPath: '/v1/chat/completions',
  headers: 'browser-sse',
  request: {
    kind: 'chat-completions-from-messages',
    messagesPath: ['messages'],
    modelPath: ['model'],
    missingModel: 'auto',
    stream: true,
  },
  response: { kind: 'conversation-sse', assistantParent: 'user-message' },
}

const WORKFLOW_FORWARD_RULE: SystemProxyForwardRule = {
  source: 'workflow',
  targetPath: '/v1/responses',
  headers: 'browser-sse',
  request: {
    kind: 'responses-from-messages',
    messagesPath: ['input', 'messages'],
    modelPath: ['model'],
    stream: true,
  },
  cors: { allowOrigin: 'request', allowCredentials: true, allowHeaders: 'request' },
  response: {
    kind: 'responses-sse',
    injectResponseId: true,
    stripDataType: true,
    stripItemPhase: true,
    emptyContentPartDoneText: true,
    emptyOutputItemDoneContent: true,
    messageOutputIndex: 1,
    messageItemId: 'agent-node:llm:0',
  },
}

// ── Unit tests for rewriteRequestBody ────────────────────────────────────────

test('rewriteRequestBody: injects peerId into model field', () => {
  const body = Buffer.from(JSON.stringify({ model: 'model-default', messages: [] }))
  const result = rewriteRequestBody(body, 'peer123')
  const parsed = JSON.parse(result.body.toString('utf8')) as { model: string }
  assert.equal(parsed.model, 'peer123@model-default')
  assert.equal(result.modelRouted, true)
})

test('rewriteRequestBody: leaves other fields intact', () => {
  const input = { model: 'model-legacy', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }
  const result = rewriteRequestBody(Buffer.from(JSON.stringify(input)), 'peer')
  const parsed = JSON.parse(result.body.toString('utf8')) as typeof input
  assert.deepEqual(parsed.messages, input.messages)
  assert.equal(parsed.max_tokens, 100)
})

test('rewriteRequestBody: no-op when model field is absent', () => {
  const body = Buffer.from(JSON.stringify({ input: 'hello', stream: true }))
  const result = rewriteRequestBody(body, 'peer123')
  const parsed = JSON.parse(result.body.toString('utf8')) as { input: string; model?: string }
  assert.equal(parsed.model, undefined)
  assert.equal(parsed.input, 'hello')
  assert.equal(result.modelRouted, false)
})

test('rewriteRequestBody: no-op for empty peerId', () => {
  const body = Buffer.from(JSON.stringify({ model: 'model-default' }))
  const result = rewriteRequestBody(body, '')
  const parsed = JSON.parse(result.body.toString('utf8')) as { model: string }
  assert.equal(parsed.model, 'model-default')
  assert.equal(result.modelRouted, false)
})

test('rewriteRequestBody: passes through non-JSON unchanged', () => {
  const raw = Buffer.from('not json at all')
  const result = rewriteRequestBody(raw, 'peer')
  assert.deepEqual(result.body, raw)
  assert.equal(result.modelRouted, false)
})

test('rewriteRequestBody: passes through empty buffer unchanged', () => {
  const result = rewriteRequestBody(Buffer.alloc(0), 'peer')
  assert.equal(result.body.length, 0)
  assert.equal(result.modelRouted, false)
})

test('rewriteRequestBody: handles model as non-string (leaves unchanged)', () => {
  const body = Buffer.from(JSON.stringify({ model: 42 }))
  const result = rewriteRequestBody(body, 'peer')
  const parsed = JSON.parse(result.body.toString('utf8')) as { model: unknown }
  assert.equal(parsed.model, 42)
  assert.equal(result.modelRouted, false)
})

test('rewriteRequestBody: uses default model when requested model is not served by the peer', () => {
  const body = Buffer.from(JSON.stringify({ model: 'gpt-5.5', messages: [] }))
  const result = rewriteRequestBody(body, 'peer', {
    defaultModel: 'model-large',
    servedModels: new Set(['model-large']),
  })
  const parsed = JSON.parse(result.body.toString('utf8')) as { model: string }
  assert.equal(parsed.model, 'peer@model-large')
  assert.equal(result.modelRouted, true)
})

test('rewriteRequestBody: selected default overrides a client model served by the peer', () => {
  const body = Buffer.from(JSON.stringify({ model: 'model-large', messages: [] }))
  const result = rewriteRequestBody(body, 'peer', {
    defaultModel: 'model-small',
    servedModels: new Set(['model-large', 'model-small']),
  })
  const parsed = JSON.parse(result.body.toString('utf8')) as { model: string }
  assert.equal(parsed.model, 'peer@model-small')
  assert.equal(result.modelRouted, true)
})

test('shouldSystemProxyRequest: only matches configured model API routes', () => {
  const routes = new Map<string, Set<string>>([
    ['api-a.example.test', new Set(['/v1/messages', '/v1/complete'])],
    ['api-b.example.test', new Set(['/v1/responses', '/v1/chat/completions'])],
  ])

  assert.equal(shouldSystemProxyRequest('api-a.example.test', '/v1/messages', routes), true)
  assert.equal(shouldSystemProxyRequest('api-a.example.test', '/v1/messages?beta=true', routes), true)
  assert.equal(shouldSystemProxyRequest('api-b.example.test', '/v1/responses', routes), true)
  assert.equal(shouldSystemProxyRequest('api-a.example.test', '/auth', routes), false)
  assert.equal(shouldSystemProxyRequest('api-a.example.test', '/v1/oauth/token', routes), false)
  assert.equal(shouldSystemProxyRequest('console.example.test', '/v1/messages', routes), false)
})

test('transformRequestBody: converts configured message body to chat completions completions', () => {
  const body = Buffer.from(JSON.stringify({
    action: 'next',
    model: 'auto',
    messages: [
      {
        id: 'msg-1',
        author: { role: 'user' },
        content: { content_type: 'text', parts: ['hello from profile'] },
      },
    ],
  }))

  const result = transformRequestBody(body, 'peer123', CONVERSATION_FORWARD_RULE.request!)
  assert.ok(result)
  const parsed = JSON.parse(result.toString('utf8')) as {
    model: string
    messages: Array<{ role: string; content: string }>
    stream: boolean
  }
  assert.equal(parsed.model, 'peer123@auto')
  assert.deepEqual(parsed.messages, [{ role: 'user', content: 'hello from profile' }])
  assert.equal(parsed.stream, true)
})

test('transformRequestBody: maps auto model to selected default model', () => {
  const body = Buffer.from(JSON.stringify({
    action: 'next',
    model: 'auto',
    messages: [
      {
        id: 'msg-1',
        author: { role: 'user' },
        content: { content_type: 'text', parts: ['hello from profile'] },
      },
    ],
  }))

  const result = transformRequestBody(body, 'peer123', CONVERSATION_FORWARD_RULE.request!, {
    defaultModel: 'model-large',
    servedModels: new Set(['model-large']),
  })
  assert.ok(result)
  const parsed = JSON.parse(result.toString('utf8')) as { model: string }
  assert.equal(parsed.model, 'peer123@model-large')
})

test('transformRequestBody: returns null for configured message transform without messages', () => {
  const body = Buffer.from(JSON.stringify({
    action: 'next',
    model: 'auto',
    client_prepare_state: 'none',
    client_contextual_info: { app_name: 'conversation.com' },
  }))

  assert.equal(transformRequestBody(body, 'peer123', CONVERSATION_FORWARD_RULE.request!), null)
})

test('buildBuyerForwardRequest: routes conversation message requests to chat completions completions', () => {
  const routes = new Map<string, Set<string>>([
    ['conversation.com', new Set(['/profile-api/conversation'])],
  ])
  const rawBody = Buffer.from(JSON.stringify({
    model: 'auto',
    messages: [
      {
        author: { role: 'user' },
        content: { parts: ['hello'] },
      },
    ],
  }))

  const result = buildBuyerForwardRequest({
    host: 'conversation.com',
    path: '/profile-api/conversation',
    rawBody,
    isJson: true,
    peerId: 'peer123',
    prefixesByHost: routes,
    forwardRulesByHost: new Map([
      ['conversation.com', CONVERSATION_FORWARD_RULE],
    ]),
  })

  assert.ok(result)
  assert.equal(result.path, '/v1/chat/completions')
  assert.equal(result.source, 'conversation')
  assert.equal(result.modelRouted, true)
  assert.ok(result.conversation)
  assert.equal(result.conversation.conversationId.length > 0, true)
  assert.equal(result.conversation.modelSlug, 'auto')
})

test('buildBuyerForwardRequest: passes conversation prepare requests through when no messages are present', () => {
  const routes = new Map<string, Set<string>>([
    ['conversation.com', new Set(['/profile-api/conversation'])],
  ])

  const result = buildBuyerForwardRequest({
    host: 'conversation.com',
    path: '/profile-api/conversation/prepare',
    rawBody: Buffer.from(JSON.stringify({ model: 'auto', client_prepare_state: 'none' })),
    isJson: true,
    peerId: 'peer123',
    prefixesByHost: routes,
    forwardRulesByHost: new Map([
      ['conversation.com', CONVERSATION_FORWARD_RULE],
    ]),
  })

  assert.equal(result, null)
})

test('buildBuyerForwardRequest: attributes standard proxy routes to the matched profile source', () => {
  const routes = new Map<string, Set<string>>([
    ['api.anthropic.com', new Set(['/v1/messages'])],
  ])
  const result = buildBuyerForwardRequest({
    host: 'api.anthropic.com',
    path: '/v1/messages',
    rawBody: Buffer.from(JSON.stringify({ model: 'claude', messages: [] })),
    isJson: true,
    peerId: 'peer123',
    prefixesByHost: routes,
    sourcesByHost: new Map([
      ['api.anthropic.com', new Map([['/v1/messages', 'custom-api-anthropic-com']])],
    ]),
  })

  assert.ok(result)
  assert.equal(result.source, 'custom-api-anthropic-com')
})

test('transformRequestBody: converts configured nested message body to responses', () => {
  const body = Buffer.from(JSON.stringify({
    input: {
      messages: [
        {
          content: [
            { annotations: [], text: 'hi', type: 'output_text' },
          ],
          id: 'workflow-msg-1',
          role: 'user',
          status: 'completed',
          type: 'message',
        },
      ],
    },
  }))

  const result = transformRequestBody(body, 'peer123', WORKFLOW_FORWARD_RULE.request!, {
    defaultModel: 'model-large',
    servedModels: new Set(['model-large']),
  })
  assert.ok(result)
  const parsed = JSON.parse(result.toString('utf8')) as {
    model: string
    input: Array<{ role: string; content: string }>
    stream: boolean
  }
  assert.equal(parsed.model, 'peer123@model-large')
  assert.deepEqual(parsed.input, [{ role: 'user', content: 'hi' }])
  assert.equal(parsed.stream, true)
})

test('buildBuyerForwardRequest: routes workflow requests to responses', () => {
  const routes = new Map<string, Set<string>>([
    ['workflow.example.test', new Set(['/profile-api/workflow'])],
  ])
  const rawBody = Buffer.from(JSON.stringify({
    input: {
      messages: [
        {
          role: 'user',
          content: [{ text: 'hello workflow', type: 'output_text' }],
        },
      ],
    },
  }))

  const result = buildBuyerForwardRequest({
    host: 'workflow.example.test',
    path: '/profile-api/workflow',
    rawBody,
    isJson: true,
    peerId: 'peer123',
    defaultModel: 'model-default',
    servedModels: new Set(['model-default']),
    prefixesByHost: routes,
    forwardRulesByHost: new Map([
      ['workflow.example.test', WORKFLOW_FORWARD_RULE],
    ]),
  })

  assert.ok(result)
  assert.equal(result.path, '/v1/responses')
  assert.equal(result.source, 'workflow')
  const parsed = JSON.parse(result.body.toString('utf8')) as {
    model: string
    input: Array<{ role: string; content: string }>
    stream: boolean
  }
  assert.equal(parsed.model, 'peer123@model-default')
  assert.deepEqual(parsed.input, [{ role: 'user', content: 'hello workflow' }])
  assert.equal(parsed.stream, true)
})

test('ConversationSseAdapter: converts chat completions SSE into conversation events', () => {
  const adapter = new ConversationSseAdapter({
    conversationId: 'conv-1',
    parentMessageId: 'parent-1',
    userMessageId: 'user-1',
    assistantMessageId: 'assistant-1',
  })
  const input = [
    'data: {"id":"chatcmpl_1","choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl_1","choices":[{"delta":{"content":" there"},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl_1","choices":[{"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n')

  const output = adapter.feed(Buffer.from(input), false).map((chunk) => chunk.toString('utf8')).join('')
  assert.ok(output.includes('"conversation_id":"conv-1"'))
  assert.ok(output.includes('"id":"assistant-1"'))
  assert.ok(output.includes('"parts":["hi"]'))
  assert.ok(output.includes('"parts":["hi there"]'))
  assert.ok(output.includes('"status":"finished_successfully"'))
  assert.ok(output.includes('"message_type":"next"'))
  assert.ok(output.includes('"parent_id":"parent-1"'))
  assert.ok(output.includes('"is_complete":true'))
  assert.ok(output.includes('"content_references":[]'))
  assert.ok(output.includes('data: [DONE]'))
})

test('ConversationSseAdapter: can parent assistant messages to the user message', () => {
  const adapter = new ConversationSseAdapter({
    conversationId: 'conv-1',
    parentMessageId: 'parent-1',
    userMessageId: 'user-1',
    assistantMessageId: 'assistant-1',
    assistantParent: 'user-message',
  })

  const output = adapter
    .feed(Buffer.from('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'), false)
    .map((chunk) => chunk.toString('utf8'))
    .join('')
  assert.ok(output.includes('"parent_id":"user-1"'))
  assert.equal(output.includes('"parent_id":"parent-1"'), false)
})

test('ConversationSseAdapter: preserves configured assistant create time', () => {
  const adapter = new ConversationSseAdapter({
    conversationId: 'conv-1',
    parentMessageId: 'parent-1',
    userMessageId: 'user-1',
    assistantMessageId: 'assistant-1',
    assistantCreateTime: 123.456,
  })

  const output = adapter
    .feed(Buffer.from('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'), false)
    .map((chunk) => chunk.toString('utf8'))
    .join('')
  assert.ok(output.includes('"create_time":123.456'))
})

test('ConversationSseAdapter: converts non-streaming chat completions JSON into conversation events', () => {
  const adapter = new ConversationSseAdapter({
    conversationId: 'conv-1',
    parentMessageId: 'parent-1',
    userMessageId: 'user-1',
    assistantMessageId: 'assistant-1',
  })
  const body = Buffer.from(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  }))

  const output = adapter.fromJsonResponse(body).map((chunk) => chunk.toString('utf8')).join('')
  assert.ok(output.includes('"parts":["hello"]'))
  assert.ok(output.includes('"status":"finished_successfully"'))
  assert.ok(output.includes('data: [DONE]'))
})

test('ResponsesSseNormalizer: removes duplicate terminal text payloads', () => {
  const normalizer = new ResponsesSseNormalizer({
    kind: 'responses-sse',
    injectResponseId: true,
    stripDataType: true,
    stripItemPhase: true,
    emptyContentPartDoneText: true,
    emptyOutputItemDoneContent: true,
    messageOutputIndex: 1,
    messageItemId: 'agent-node:llm:0',
  })
  const input = [
    'event: response.created',
    'data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_1","status":"in_progress"}}',
    '',
    'event: response.output_item.added',
    'data: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","status":"in_progress","content":[],"phase":"final_answer"}}',
    '',
    'event: response.output_text.done',
    'data: {"type":"response.output_text.done","sequence_number":2,"output_index":0,"item_id":"msg_1","text":"Hi"}',
    '',
    'event: response.content_part.done',
    'data: {"type":"response.content_part.done","sequence_number":3,"output_index":0,"item_id":"msg_1","part":{"type":"output_text","text":"Hi","annotations":[]}}',
    '',
    'event: response.output_item.done',
    'data: {"type":"response.output_item.done","sequence_number":4,"output_index":0,"item":{"type":"message","id":"msg_1","content":[{"type":"output_text","text":"Hi"}],"phase":"final_answer"}}',
    '',
    '',
  ].join('\n')

  const output = normalizer.feed(Buffer.from(input), true).map((chunk) => chunk.toString('utf8')).join('')
  assert.equal(output.includes('"type":"response.output_text.done"'), false)
  assert.ok(output.includes('"response_id":"resp_1"'))
  assert.ok(output.includes('"text":"Hi"'))
  assert.ok(output.includes('"item":{"type":"message","id":"agent-node:llm:0","role":"assistant","status":"in_progress","content":[]}'))
  assert.ok(output.includes('"item_id":"agent-node:llm:0"'))
  assert.ok(output.includes('"output_index":1'))
  assert.equal(output.includes('"phase":"final_answer"'), false)
  assert.ok(output.includes('"part":{"type":"output_text","text":"","annotations":[]}'))
  assert.ok(output.includes('"item":{"type":"message","id":"agent-node:llm:0","content":[]}'))
})

// ── Integration tests ─────────────────────────────────────────────────────────
// Tests connect directly to the inner TLS server (innerTlsPort), bypassing the
// CONNECT tunnel. This keeps tests reliable while covering the critical
// handleDecrypted logic: body rewriting, header stripping, response forwarding.

async function startFakeBuyerProxy(
  /** Optional pre-handler; return true when the response was written. */
  respond?: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => boolean,
): Promise<{
  port: number
  captured: { method: string; path: string; headers: http.IncomingHttpHeaders; body: Buffer }[]
  close: () => Promise<void>
}> {
  const captured: { method: string; path: string; headers: http.IncomingHttpHeaders; body: Buffer }[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      captured.push({
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: req.headers,
        body,
      })
      if (respond?.(req, res, body)) return
      if (req.url === '/v1/responses') {
        const responseBody = [
          'event: response.created',
          'data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_1","object":"response","status":"in_progress"}}',
          '',
          'event: response.output_item.added',
          'data: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","status":"in_progress","content":[],"phase":"final_answer"}}',
          '',
          'event: response.content_part.added',
          'data: {"type":"response.content_part.added","sequence_number":2,"output_index":0,"item_id":"msg_1","content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}',
          '',
          'event: response.output_text.delta',
          'data: {"type":"response.output_text.delta","sequence_number":3,"output_index":0,"item_id":"msg_1","content_index":0,"delta":"Hi"}',
          '',
          'event: response.output_text.done',
          'data: {"type":"response.output_text.done","sequence_number":4,"output_index":0,"item_id":"msg_1","content_index":0,"text":"Hi"}',
          '',
          'event: response.content_part.done',
          'data: {"type":"response.content_part.done","sequence_number":5,"output_index":0,"item_id":"msg_1","content_index":0,"part":{"type":"output_text","text":"Hi","annotations":[]}}',
          '',
          'event: response.output_item.done',
          'data: {"type":"response.output_item.done","sequence_number":6,"output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Hi","annotations":[]}],"phase":"final_answer"}}',
          '',
          'data: [DONE]',
          '',
          '',
        ].join('\n')
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'content-length': String(Buffer.byteLength(responseBody)),
          'connection': 'close',
        })
        res.end(responseBody)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'connection': 'close' })
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as net.AddressInfo).port
  return {
    port,
    captured,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

// Send one HTTP/1.1 request over a TLS connection directly to the inner server.
function tlsHttpRequest(opts: {
  host: string
  port: number
  servername: string
  caCert: string
  method: string
  path: string
  headers: Record<string, string>
  body: Buffer
}): Promise<{ statusCode: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: opts.host, port: opts.port, servername: opts.servername, ca: opts.caCert, rejectUnauthorized: true },
      () => {
        const headerPairs = [
          `${opts.method} ${opts.path} HTTP/1.1`,
          `Host: ${opts.servername}`,
          `Connection: close`,
          ...Object.entries(opts.headers).map(([k, v]) => `${k}: ${v}`),
          `Content-Length: ${opts.body.length}`,
          '',
        ]
        socket.write(headerPairs.join('\r\n') + '\r\n')
        if (opts.body.length > 0) socket.write(opts.body)
      },
    )

    const chunks: Buffer[] = []
    socket.on('data', (c: Buffer) => chunks.push(c))
    socket.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const bodyStart = raw.indexOf('\r\n\r\n')
      const headerLines = (bodyStart >= 0 ? raw.slice(0, bodyStart) : raw).split('\r\n')
      const statusLine = headerLines[0] ?? ''
      const statusMatch = /HTTP\/\d+\.?\d* (\d+)/.exec(statusLine)
      const headers: Record<string, string> = {}
      for (const line of headerLines.slice(1)) {
        const separator = line.indexOf(':')
        if (separator <= 0) continue
        headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim()
      }
      resolve({
        statusCode: statusMatch ? parseInt(statusMatch[1]!, 10) : 0,
        headers,
        body: bodyStart >= 0 ? Buffer.from(raw.slice(bodyStart + 4)) : Buffer.alloc(0),
      })
    })
    socket.on('error', reject)
    setTimeout(() => { socket.destroy(); reject(new Error('TLS request timed out')) }, 8_000)
  })
}

async function makeProxy(tmpDir: string, buyerPort: number, buyerAuthHeaders?: () => Record<string, string>) {
  const caManager = new CAManager(tmpDir)
  const caKeys = await caManager.generate()
  const certCache = new CertCache(caKeys)
  const proxy = new SystemProxyServer({
    port: 0,
    buyerProxyPort: buyerPort,
    ...(buyerAuthHeaders ? { buyerAuthHeaders } : {}),
    certCache,
    proxiedDomains: new Set(['api-b.example.test', 'api-a.example.test', 'conversation.com', 'workflow.example.test']),
    proxiedPathPrefixes: new Map([
      ['api-b.example.test', new Set(['/v1/audio/transcriptions', '/v1/chat/completions'])],
      ['api-a.example.test', new Set(['/v1/messages'])],
      ['conversation.com', new Set(['/profile-api/conversation', '/profile-api/conversation/prepare'])],
      ['workflow.example.test', new Set(['/profile-api/workflow'])],
    ]),
    proxiedSources: new Map([
      ['api-b.example.test', new Map([
        ['/v1/audio/transcriptions', 'api-b-profile'],
        ['/v1/chat/completions', 'api-b-profile'],
      ])],
      ['api-a.example.test', new Map([['/v1/messages', 'api-a-profile']])],
      ['conversation.com', new Map([
        ['/profile-api/conversation', 'conversation'],
        ['/profile-api/conversation/prepare', 'conversation'],
      ])],
      ['workflow.example.test', new Map([['/profile-api/workflow', 'workflow']])],
    ]),
    systemProxyForwardRules: new Map([
      ['conversation.com', CONVERSATION_FORWARD_RULE],
      ['workflow.example.test', WORKFLOW_FORWARD_RULE],
    ]),
    defaultPeerId: 'testPeer',
    defaultModel: 'model-default',
    servedModels: new Set(['model-default']),
  })
  await proxy.start()
  return { proxy, caKeys }
}

test('Proxy: rewrites model field and strips Authorization header', { timeout: 15_000 }, async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'antseed-proxy-test-'))
  try {
    const buyer = await startFakeBuyerProxy()
    const { proxy, caKeys } = await makeProxy(tmpDir, buyer.port)
    try {
      const requestBody = Buffer.from(JSON.stringify({ model: 'model-default', messages: [{ role: 'user', content: 'hi' }] }))
      const result = await tlsHttpRequest({
        host: '127.0.0.1',
        port: proxy.innerTlsPort,
        servername: 'api-b.example.test',
        caCert: caKeys.certPem,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer sk-secret-key',
        },
        body: requestBody,
      })

      assert.equal(result.statusCode, 200, 'should get 200 from buyer proxy')
      assert.equal(buyer.captured.length, 1, 'buyer proxy should receive exactly one request')

      const captured = buyer.captured[0]!
      const capturedBody = JSON.parse(captured.body.toString('utf8')) as { model: string }
      assert.equal(capturedBody.model, 'testPeer@model-default', 'model should be rewritten with peerId prefix')
      assert.equal(captured.headers['authorization'], undefined, 'Authorization header should be stripped')
    } finally {
      await proxy.stop()
      await buyer.close()
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

test('Proxy: strips every client credential header and authenticates to a token-protected buyer (#1104)', { timeout: 15_000 }, async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'antseed-proxy-test-'))
  try {
    const buyer = await startFakeBuyerProxy()
    const { proxy, caKeys } = await makeProxy(tmpDir, buyer.port, () => ({ authorization: 'Bearer buyer-token-0123456789' }))
    try {
      const result = await tlsHttpRequest({
        host: '127.0.0.1',
        port: proxy.innerTlsPort,
        servername: 'api-b.example.test',
        caCert: caKeys.certPem,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer sk-secret-key',
          'x-api-key': 'sk-ant-secret',
          'x-goog-api-key': 'AIza-secret',
          'api-key': 'azure-secret',
          'cookie': 'session=secret',
        },
        body: Buffer.from(JSON.stringify({ model: 'model-default', messages: [] })),
      })
      assert.equal(result.statusCode, 200)
      const captured = buyer.captured[0]!
      assert.equal(captured.headers['authorization'], 'Bearer buyer-token-0123456789')
      assert.equal(captured.headers['x-api-key'], undefined)
      assert.equal(captured.headers['x-goog-api-key'], undefined)
      assert.equal(captured.headers['api-key'], undefined)
      assert.equal(captured.headers['cookie'], undefined)
    } finally {
      await proxy.stop()
      await buyer.close()
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

test('Proxy: passes non-JSON body through without modification', { timeout: 15_000 }, async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'antseed-proxy-test-'))
  try {
    const buyer = await startFakeBuyerProxy()
    const { proxy, caKeys } = await makeProxy(tmpDir, buyer.port)
    try {
      const rawBody = Buffer.from('raw binary data')
      await tlsHttpRequest({
        host: '127.0.0.1',
        port: proxy.innerTlsPort,
        servername: 'api-b.example.test',
        caCert: caKeys.certPem,
        method: 'POST',
        path: '/v1/audio/transcriptions',
        headers: { 'content-type': 'application/octet-stream' },
        body: rawBody,
      })

      assert.equal(buyer.captured.length, 1)
      assert.deepEqual(buyer.captured[0]!.body, rawBody)
    } finally {
      await proxy.stop()
      await buyer.close()
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

test('Proxy: forwards correct path to buyer proxy', { timeout: 15_000 }, async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'antseed-proxy-test-'))
  try {
    const buyer = await startFakeBuyerProxy()
    const { proxy, caKeys } = await makeProxy(tmpDir, buyer.port)
    try {
      await tlsHttpRequest({
        host: '127.0.0.1',
        port: proxy.innerTlsPort,
        servername: 'api-a.example.test',
        caCert: caKeys.certPem,
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json', 'profile-version': '2023-06-01' },
        body: Buffer.from(JSON.stringify({ model: 'model-legacy', messages: [] })),
      })

      assert.equal(buyer.captured[0]?.path, '/v1/messages', 'path should be preserved')
      assert.equal(buyer.captured[0]?.headers['profile-version'], '2023-06-01', 'non-hop-by-hop headers preserved')
      assert.equal(buyer.captured[0]?.headers['x-antseed-system-proxy-source'], 'api-a-profile')
    } finally {
      await proxy.stop()
      await buyer.close()
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

test('Proxy: strips oversized conversation browser headers before forwarding', { timeout: 15_000 }, async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'antseed-proxy-test-'))
  try {
    const buyer = await startFakeBuyerProxy()
    const { proxy, caKeys } = await makeProxy(tmpDir, buyer.port)
    try {
      const requestBody = Buffer.from(JSON.stringify({
        action: 'next',
        model: 'auto',
        messages: [
          {
            id: 'msg-1',
            author: { role: 'user' },
            content: { content_type: 'text', parts: ['hi'] },
          },
        ],
        parent_message_id: 'client-created-root',
      }))
      const hugeHeader = 'x'.repeat(48 * 1024)
      const result = await tlsHttpRequest({
        host: '127.0.0.1',
        port: proxy.innerTlsPort,
        servername: 'conversation.com',
        caCert: caKeys.certPem,
        method: 'POST',
        path: '/profile-api/conversation',
        headers: {
          'accept': 'text/event-stream',
          'content-type': 'application/json',
          'authorization': `Bearer ${hugeHeader}`,
          'cookie': `session=${hugeHeader}`,
          'x-large-profile-token': hugeHeader,
          'x-profile-route-token': hugeHeader,
        },
        body: requestBody,
      })

      assert.equal(result.statusCode, 200, 'should get 200 from buyer proxy')
      assert.equal(buyer.captured.length, 1, 'buyer proxy should receive exactly one request')

      const captured = buyer.captured[0]!
      assert.equal(captured.path, '/v1/chat/completions')
      assert.equal(captured.headers['accept'], 'text/event-stream')
      assert.equal(captured.headers['content-type'], 'application/json')
      assert.equal(captured.headers['authorization'], undefined)
      assert.equal(captured.headers['cookie'], undefined)
      assert.equal(captured.headers['x-large-profile-token'], undefined)
      assert.equal(captured.headers['x-profile-route-token'], undefined)

      const capturedBody = JSON.parse(captured.body.toString('utf8')) as {
        model: string
        messages: Array<{ role: string; content: string }>
        stream: boolean
      }
      assert.equal(capturedBody.model, 'testPeer@model-default')
      assert.deepEqual(capturedBody.messages, [{ role: 'user', content: 'hi' }])
      assert.equal(capturedBody.stream, true)
    } finally {
      await proxy.stop()
      await buyer.close()
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

test('Proxy: routes workflow requests to responses and strips browser headers', { timeout: 15_000 }, async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'antseed-proxy-test-'))
  try {
    const buyer = await startFakeBuyerProxy()
    const { proxy, caKeys } = await makeProxy(tmpDir, buyer.port)
    try {
      const requestBody = Buffer.from(JSON.stringify({
        input: {
          messages: [
            {
              id: 'workflow-msg-1',
              role: 'user',
              status: 'completed',
              type: 'message',
              content: [{ annotations: [], text: 'hi', type: 'output_text' }],
            },
          ],
        },
      }))
      const hugeHeader = 'x'.repeat(48 * 1024)
      const result = await tlsHttpRequest({
        host: '127.0.0.1',
        port: proxy.innerTlsPort,
        servername: 'workflow.example.test',
        caCert: caKeys.certPem,
        method: 'POST',
        path: '/profile-api/workflow',
        headers: {
          'accept': 'text/event-stream',
          'content-type': 'application/json',
          'origin': 'https://app.example.test',
          'cookie': `session=${hugeHeader}`,
          'x-workflow-distinct-id': hugeHeader,
        },
        body: requestBody,
      })

      assert.equal(result.statusCode, 200, 'should get 200 from buyer proxy')
      assert.equal(result.headers['access-control-allow-origin'], 'https://app.example.test')
      assert.equal(result.headers['access-control-allow-credentials'], 'true')
      assert.equal(result.headers['vary'], 'Origin')
      const responseText = result.body.toString('utf8')
      assert.equal(responseText.includes('"type":"response.output_text.delta"'), false)
      assert.ok(responseText.includes('"response_id":"resp_1"'))
      assert.ok(responseText.includes('"item_id":"agent-node:llm:0"'))
      assert.ok(responseText.includes('"output_index":1'))
      assert.equal(responseText.includes('"phase":"final_answer"'), false)
      assert.ok(responseText.includes('"part":{"type":"output_text","text":"","annotations":[]}'))
      assert.ok(responseText.includes('"item":{"type":"message","id":"agent-node:llm:0","role":"assistant","status":"completed","content":[]}'))
      assert.equal(buyer.captured.length, 1, 'buyer proxy should receive exactly one request')

      const captured = buyer.captured[0]!
      assert.equal(captured.path, '/v1/responses')
      assert.equal(captured.headers['accept'], 'text/event-stream')
      assert.equal(captured.headers['content-type'], 'application/json')
      assert.equal(captured.headers['cookie'], undefined)
      assert.equal(captured.headers['x-workflow-distinct-id'], undefined)

      const capturedBody = JSON.parse(captured.body.toString('utf8')) as {
        model: string
        input: Array<{ role: string; content: string }>
        stream: boolean
      }
      assert.equal(capturedBody.model, 'testPeer@model-default')
      assert.deepEqual(capturedBody.input, [{ role: 'user', content: 'hi' }])
      assert.equal(capturedBody.stream, true)
    } finally {
      await proxy.stop()
      await buyer.close()
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

test('Proxy: handles profile CORS preflight without forwarding', { timeout: 15_000 }, async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'antseed-proxy-test-'))
  try {
    const buyer = await startFakeBuyerProxy()
    const { proxy, caKeys } = await makeProxy(tmpDir, buyer.port)
    try {
      const result = await tlsHttpRequest({
        host: '127.0.0.1',
        port: proxy.innerTlsPort,
        servername: 'workflow.example.test',
        caCert: caKeys.certPem,
        method: 'OPTIONS',
        path: '/profile-api/workflow?agentModelId=kimi-k2-5',
        headers: {
          'origin': 'https://app.example.test',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,x-workflow-version,x-workflow-distinct-id',
        },
        body: Buffer.alloc(0),
      })

      assert.equal(result.statusCode, 204)
      assert.equal(result.headers['access-control-allow-origin'], 'https://app.example.test')
      assert.equal(result.headers['access-control-allow-credentials'], 'true')
      assert.equal(result.headers['access-control-allow-methods'], 'GET, POST, OPTIONS')
      assert.equal(result.headers['access-control-allow-headers'], 'content-type,x-workflow-version,x-workflow-distinct-id')
      assert.equal(result.headers['access-control-max-age'], '600')
      assert.equal(buyer.captured.length, 0, 'preflight should not hit buyer proxy')
    } finally {
      await proxy.stop()
      await buyer.close()
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

// ── 402 → plain-text out-of-credits notice ───────────────────────────────────

function respond402PaymentRequired(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const body = JSON.stringify({
    error: 'payment_required',
    code: 'insufficient_deposits',
    peerId: 'testPeer',
    message: 'You are out of AntSeed credits for this request.',
  })
  res.writeHead(402, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    'connection': 'close',
  })
  res.end(body)
  return true
}

test('Proxy: rewrites a 402 body into a plain-text out-of-credits notice', { timeout: 15_000 }, async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'antseed-proxy-test-'))
  try {
    const buyer = await startFakeBuyerProxy(respond402PaymentRequired)
    const { proxy, caKeys } = await makeProxy(tmpDir, buyer.port)
    try {
      const requestBody = Buffer.from(JSON.stringify({
        model: 'model-default',
        stream: true,
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hi' }],
      }))
      const result = await tlsHttpRequest({
        host: '127.0.0.1',
        port: proxy.innerTlsPort,
        servername: 'api-a.example.test',
        caCert: caKeys.certPem,
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
        body: requestBody,
      })

      assert.equal(result.statusCode, 402, 'payment failures keep their 402 status')
      assert.ok(result.headers['content-type']?.includes('text/plain'), 'body is plain text, not JSON')
      const text = result.body.toString('utf8')
      assert.ok(text.includes('out of credits'), 'notice tells the user what happened')
      assert.ok(text.includes('AntSeed app'), 'notice tells the user where to fix it')
      assert.ok(!text.includes('payment_required'), 'raw error JSON never reaches the client')
      assert.ok(!text.includes('{'), 'no JSON syntax leaks into the notice')
    } finally {
      await proxy.stop()
      await buyer.close()
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

test('Proxy: rewrites non-chat 402s with the same plain-text notice', { timeout: 15_000 }, async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'antseed-proxy-test-'))
  try {
    const buyer = await startFakeBuyerProxy(respond402PaymentRequired)
    const { proxy, caKeys } = await makeProxy(tmpDir, buyer.port)
    try {
      const result = await tlsHttpRequest({
        host: '127.0.0.1',
        port: proxy.innerTlsPort,
        servername: 'api-b.example.test',
        caCert: caKeys.certPem,
        method: 'POST',
        path: '/v1/audio/transcriptions',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from('raw audio'),
      })

      assert.equal(result.statusCode, 402)
      assert.ok(result.headers['content-type']?.includes('text/plain'))
      assert.ok(result.body.toString('utf8').includes('out of credits'))
    } finally {
      await proxy.stop()
      await buyer.close()
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})
