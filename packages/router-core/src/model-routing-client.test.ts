import { describe, expect, it, vi } from 'vitest'
import type { PeerInfo, RouteSelectionContext, SerializedHttpRequest } from '@antseed/node'
import { ModelRoutingClient, RouterCannotRankError, routingCandidateId } from './model-routing-client.js'

const routerId = 'a'.repeat(40)
const inferenceId = 'b'.repeat(40)
const target = { peerId: routerId, provider: 'alpha', serviceId: 'route' }
const peer = { peerId: routerId, metadata: { version: 12, peerId: routerId, providers: [{
  provider: 'alpha', services: ['route'], defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }, maxConcurrency: 1, currentLoad: 0,
  serviceApiProtocols: { route: ['model-routing'] },
  serviceUnitBillingModels: { route: { 'model-routing': { version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.001 }] } } },
}] } } as unknown as PeerInfo
const modelsResponse = { object: 'list', data: [{ id: 'model-a', object: 'model', owned_by: 'x' }, { id: 'model-b', object: 'model' }] }
const idA = `openai:model-a@${'b'.repeat(40)}`
const ranking = (ranked: unknown[]) => ({ id: 'rank-1', object: 'routing.ranking', created: 1, router: { id: 'alpha', version: '1' }, ranked })
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const decode = (body: Uint8Array) => JSON.parse(new TextDecoder().decode(body))

function request(text = 'Help me'): SerializedHttpRequest {
  return { requestId: 'inference', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' },
    body: encode({ model: 'antseed', messages: [{ role: 'user', content: text }] }) }
}

function setup(respond: (body: any) => { statusCode?: number; body: unknown } = body => ({
  body: ranking([{ candidate_id: body.routing.candidates[0].id }]),
})) {
  const accepted = vi.fn(() => true)
  const sendRequest = vi.fn<RouteSelectionContext['sendRequest']>(async (_peer, serviceRequest) => {
    const reply = respond(decode(serviceRequest.body))
    return { requestId: serviceRequest.requestId, statusCode: reply.statusCode ?? 200, headers: {}, body: encode(reply.body) }
  })
  const context: RouteSelectionContext = {
    routingService: target, costQualityTradeoff: 9, signal: new AbortController().signal, conversationKey: 'chat-1',
    candidates: [{ serviceId: 'model-a', peerId: inferenceId, provider: 'openai', inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.1 }],
    acceptRecommendations: accepted, sendRequest,
  }
  return { client: new ModelRoutingClient(), context, accepted, sendRequest }
}

describe('ModelRoutingClient', () => {
  it('lists the router models through a free request to the selected peer', async () => {
    const client = new ModelRoutingClient()
    const sendRequest = vi.fn(async (_peer: PeerInfo, serviceRequest: SerializedHttpRequest) =>
      ({ requestId: serviceRequest.requestId, statusCode: 200, headers: {}, body: encode(modelsResponse) }))
    expect(await client.listModels(target, [peer], { signal: new AbortController().signal, sendRequest })).toEqual(['model-a', 'model-b'])
    expect(sendRequest.mock.calls[0]![1]).toMatchObject({ method: 'GET', path: '/v1/routing/models',
      headers: { 'x-antseed-provider': 'alpha', 'x-antseed-service': 'route' } })
    sendRequest.mockResolvedValueOnce({ requestId: 'x', statusCode: 200, headers: {}, body: encode({ ...modelsResponse, data: 'model-a' }) })
    await expect(client.listModels(target, [peer], { signal: new AbortController().signal, sendRequest })).rejects.toThrow('models response')
    sendRequest.mockResolvedValueOnce({ requestId: 'x', statusCode: 503, headers: {}, body: encode({ type: 'urn:irp:problem:unavailable', title: 'Unavailable', status: 503, detail: 'Try later.' }) })
    await expect(client.listModels(target, [peer], { signal: new AbortController().signal, sendRequest })).rejects.toThrow('temporarily unavailable: Try later.')
  })

  it('sends a plain IRP rank request with the routing service in a header', async () => {
    const state = setup()
    expect(await state.client.selectRoute(request(), [peer], state.context)).toEqual([{ serviceId: 'model-a', peerId: inferenceId, provider: 'openai' }])
    const [, serviceRequest, options] = state.sendRequest.mock.calls[0]!
    expect(serviceRequest.path).toBe('/v1/routing/rank')
    expect(serviceRequest.requestId).not.toBe('inference')
    expect(serviceRequest.headers['x-antseed-provider']).toBe('alpha')
    expect(serviceRequest.headers['x-antseed-service']).toBe('route')
    expect(options.signal).toBe(state.context.signal)
    expect(decode(serviceRequest.body)).toEqual({
      request: { messages: [{ role: 'user', content: 'Help me' }] },
      routing: {
        cost_quality_tradeoff: 9,
        candidates: [{ id: idA, model: 'model-a', pricing: { input: 1, cache_read: 0.1, output: 2 } }],
      },
    })
  })

  it('omits an unset tradeoff and prices cache reads at the input price when unpriced', async () => {
    const state = setup()
    delete state.context.costQualityTradeoff
    state.context.candidates = [{ serviceId: 'model-a', peerId: inferenceId, provider: 'openai', inputUsdPerMillion: 1, outputUsdPerMillion: 2 }]
    await state.client.selectRoute(request(), [peer], state.context)
    const { routing } = decode(state.sendRequest.mock.calls[0]![1].body)
    expect(routing).not.toHaveProperty('cost_quality_tradeoff')
    expect(routing.candidates[0].pricing).toEqual({ input: 1, cache_read: 1, output: 2 })
  })

  it('sends the router model name when one was resolved, and still dispatches the seller service', async () => {
    const state = setup()
    state.context.candidates = [{ serviceId: 'model-a', routerModel: 'vendor/model-a', peerId: inferenceId, provider: 'openai', inputUsdPerMillion: 1, outputUsdPerMillion: 2 }]
    expect(await state.client.selectRoute(request(), [peer], state.context)).toEqual([{ serviceId: 'model-a', peerId: inferenceId, provider: 'openai' }])
    const { routing } = decode(state.sendRequest.mock.calls[0]![1].body)
    expect(routing.candidates[0]).toMatchObject({ id: idA, model: 'vendor/model-a' })
  })

  it('uses readable provider:model@peer IDs and hashes IDs over 128 characters', () => {
    expect(routingCandidateId({ provider: 'openai', serviceId: 'gpt-5.5', peerId: inferenceId })).toBe(`openai:gpt-5.5@${inferenceId}`)
    const long = routingCandidateId({ provider: 'openai', serviceId: 'm'.repeat(100), peerId: inferenceId })
    expect(long).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(routingCandidateId({ provider: 'openai', serviceId: 'm'.repeat(100), peerId: inferenceId })).toBe(long)
  })

  it('puts the observed cache reuse on the exact candidate', async () => {
    const state = setup()
    state.client.recordUsage({ conversationKey: 'chat-1', requestId: 'done', peerId: inferenceId, provider: 'openai', serviceId: 'model-a', inputTokens: 100, cachedInputTokens: 80 })
    state.context.candidates = [...state.context.candidates, { ...state.context.candidates[0]!, serviceId: 'model-b' }]
    await state.client.selectRoute(request('A much longer follow-up question that has plenty of tokens in it'), [peer], state.context)
    const candidates = decode(state.sendRequest.mock.calls[0]![1].body).routing.candidates
    expect(candidates[0].expected_usage.cache_read_tokens).toBeGreaterThan(0)
    // Absent means 0: candidates with no observed cache reuse omit expected_usage.
    expect(candidates[1].model).toBe('model-b')
    expect(candidates[1]).not.toHaveProperty('expected_usage')
  })

  it('keeps router order, carries reasoning effort and drops entries outside the sent candidates', async () => {
    const other = { serviceId: 'model-b', peerId: inferenceId, provider: 'openai', inputUsdPerMillion: 1, outputUsdPerMillion: 2 }
    const state = setup(() => ({ body: ranking([
      { candidate_id: `openai:model-a@${'c'.repeat(40)}` },
      { candidate_id: `openai:model-b@${inferenceId}`, reasoning_effort: 'low', expected_cost_usd: 0.01 },
      { candidate_id: idA },
    ]) }))
    state.context.candidates = [...state.context.candidates, other]
    expect(await state.client.selectRoute(request(), [peer], state.context)).toEqual([
      { serviceId: 'model-b', peerId: inferenceId, provider: 'openai', reasoningEffort: 'low' },
      { serviceId: 'model-a', peerId: inferenceId, provider: 'openai' },
    ])
    const rejected = setup(() => ({ body: ranking([{ candidate_id: 'model-z' }]) }))
    await expect(rejected.client.selectRoute(request(), [peer], rejected.context)).rejects.toThrow('no ranking among the sent candidates')
    expect(rejected.accepted).not.toHaveBeenCalled()
  })

  it('reports a well-formed answer whose models are no longer usable', async () => {
    const state = setup()
    state.accepted.mockReturnValue(false)
    await expect(state.client.selectRoute(request(), [peer], state.context)).rejects.toThrow('no usable recommendation')
    expect(state.accepted).toHaveBeenCalledOnce()
  })

  it('maps router errors and IRP problem details', async () => {
    for (const [statusCode, message] of [[400, 'rejected'], [422, RouterCannotRankError], [402, 'payment'], [503, 'temporarily unavailable'], [500, 'Routing rank failed']] as const) {
      const state = setup(() => ({ statusCode, body: { error: 'x' } }))
      await expect(state.client.selectRoute(request(), [peer], state.context)).rejects.toThrow(message)
    }
    const problem = setup(() => ({ statusCode: 422, body: { type: 'urn:irp:problem:no-scorable-candidate', title: 'No scorable candidate', status: 422, detail: 'None of the 1 candidates fit.' } }))
    await expect(problem.client.selectRoute(request(), [peer], problem.context)).rejects.toThrow('None of the 1 candidates fit.')
  })

  it('reuses a same-turn recommendation, but not after the text, tradeoff or candidates change', async () => {
    const state = setup()
    await state.client.selectRoute(request(), [peer], state.context)
    await state.client.selectRoute(request(), [peer], state.context)
    expect(state.sendRequest).toHaveBeenCalledTimes(1)
    await state.client.selectRoute(request('New turn'), [peer], state.context)
    expect(state.sendRequest).toHaveBeenCalledTimes(2)
    state.context.costQualityTradeoff = 1
    await state.client.selectRoute(request('New turn'), [peer], state.context)
    expect(state.sendRequest).toHaveBeenCalledTimes(3)
    state.context.candidates = [...state.context.candidates, { ...state.context.candidates[0]!, serviceId: 'model-b' }]
    await state.client.selectRoute(request('New turn'), [peer], state.context)
    expect(state.sendRequest).toHaveBeenCalledTimes(4)
  })

  it('validates before sending: user text, candidates, tradeoff and a model-routing service', async () => {
    const state = setup()
    await expect(state.client.selectRoute(request(''), [peer], state.context)).rejects.toThrow('user text')
    await expect(state.client.selectRoute(request(), [peer], { ...state.context, candidates: [] })).rejects.toThrow('No eligible candidates')
    await expect(state.client.selectRoute(request(), [peer], { ...state.context, costQualityTradeoff: 11 })).rejects.toThrow('Invalid model-routing rank request')
    const duplicate = state.context.candidates[0]!
    await expect(state.client.selectRoute(request(), [peer], { ...state.context, candidates: [duplicate, duplicate] })).rejects.toThrow('Duplicate')
    const plain = setup()
    await expect(plain.client.selectRoute(request(), [{ ...peer, metadata: undefined }], plain.context)).rejects.toThrow('metadata is not available')
    expect(state.sendRequest).not.toHaveBeenCalled()
    const wrongProtocol = structuredClone(peer)
    wrongProtocol.metadata!.providers[0]!.serviceApiProtocols!.route = ['openai-chat-completions']
    await expect(plain.client.selectRoute(request(), [wrongProtocol], plain.context)).rejects.toThrow('does not advertise model-routing')
    expect(plain.sendRequest).not.toHaveBeenCalled()
  })

  it('routes an Anthropic tool loop on the user prompt and reuses it for tool-result follow-ups', async () => {
    const state = setup()
    const messages = (history: unknown[]) => ({ ...request(), path: '/v1/messages', body: encode({ model: 'antseed', messages: history }) })
    const prompt = { role: 'user', content: [{ type: 'text', text: 'Fix the failing test' }] }
    const toolCall = { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'run_tests', input: {} }] }
    const toolResult = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '1 failed' }] }
    await state.client.selectRoute(messages([prompt]), [peer], state.context)
    const followUp = await state.client.selectRoute(messages([prompt, toolCall, toolResult]), [peer], state.context)
    expect(decode(state.sendRequest.mock.calls[0]![1].body).request.messages).toEqual([{ role: 'user', content: 'Fix the failing test' }])
    expect(followUp).toEqual([{ serviceId: 'model-a', peerId: inferenceId, provider: 'openai' }])
    expect(state.sendRequest).toHaveBeenCalledTimes(1)
  })

  it('reads Responses input without altering the downstream request', async () => {
    const state = setup()
    const responses = { ...request(), path: '/v1/responses', body: encode({ model: 'antseed', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Through Responses' }] }] }) }
    const before = structuredClone(responses)
    await state.client.selectRoute(responses, [peer], state.context)
    expect(decode(state.sendRequest.mock.calls[0]![1].body).request.messages).toEqual([{ role: 'user', content: 'Through Responses' }])
    expect(responses).toEqual(before)
  })

  it('sends the whole Chat Completions request, without model or stream', async () => {
    const state = setup()
    const body = {
      model: 'antseed', stream: true, stream_options: { include_usage: true }, max_tokens: 512,
      tools: [{ type: 'function', function: { name: 'search', parameters: { type: 'object', properties: {} } } }],
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'A cat.' },
      ],
    }
    await state.client.selectRoute({ ...request(), body: encode(body) }, [peer], state.context)
    const { model: _model, stream: _stream, stream_options: _options, ...expected } = body
    expect(decode(state.sendRequest.mock.calls[0]![1].body).request).toEqual(expected)
  })

  it('converts an Anthropic Messages request to Chat Completions with system, history, tools and images', async () => {
    const state = setup()
    const body = {
      model: 'antseed', max_tokens: 1024, stream: true,
      system: [{ type: 'text', text: 'You are a coding agent.', cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Look at this' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'export {}' }] },
      ],
    }
    await state.client.selectRoute({ ...request(), path: '/v1/messages', body: encode(body) }, [peer], state.context)
    const sent = decode(state.sendRequest.mock.calls[0]![1].body).request
    expect(sent.model).toBeUndefined()
    expect(sent.stream).toBeUndefined()
    expect(sent.max_tokens).toBe(1024)
    expect(sent.tools).toEqual([{ type: 'function', function: { name: 'read_file', description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } } } }])
    expect(sent.messages).toEqual([
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: [{ type: 'text', text: 'Look at this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBOR' } }] },
      { role: 'assistant', content: 'Reading.', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'export {}' },
    ])
  })

  it('converts a Responses request without adding dispatch-only instructions or tools', async () => {
    const state = setup()
    const body = {
      model: 'antseed', instructions: 'Answer in French.', stream: true,
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }],
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Find it' }] },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'found' },
      ],
    }
    await state.client.selectRoute({ ...request(), path: '/v1/responses', body: encode(body) }, [peer], state.context)
    const sent = decode(state.sendRequest.mock.calls[0]![1].body).request
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'Answer in French.' })
    expect(sent.messages.slice(1)).toEqual([
      { role: 'user', content: 'Find it' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'found' },
    ])
    expect(sent.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['lookup'])
  })

  it('rejects request formats the adapters cannot convert before paying', async () => {
    const state = setup()
    await expect(state.client.selectRoute({ ...request(), path: '/v1/embeddings' }, [peer], state.context)).rejects.toThrow('Routing supports')
    expect(state.sendRequest).not.toHaveBeenCalled()
  })
})
