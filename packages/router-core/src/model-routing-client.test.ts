import { describe, expect, it, vi } from 'vitest'
import { RoutingDescriptionChangedError, type PeerInfo, type RouteSelectionContext, type RoutingDescribeResponseV1, type SerializedHttpRequest } from '@antseed/node'
import { ModelRoutingClient } from './model-routing-client.js'

const routerId = 'a'.repeat(40)
const inferenceId = 'b'.repeat(40)
const target = { peerId: routerId, provider: 'alpha', serviceId: 'route' }
const peer = { peerId: routerId, metadata: { version: 12, peerId: routerId, providers: [{
  provider: 'alpha', services: ['route'], defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }, maxConcurrency: 1, currentLoad: 0,
  serviceApiProtocols: { route: ['model-routing'] },
  serviceUnitBillingModels: { route: { 'model-routing': { version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.001 }] } } },
}] } } as unknown as PeerInfo
const description: RoutingDescribeResponseV1 = {
  version: 1, revision: 'rev-1', supportedServiceIds: ['model-a', 'model-b'],
  preferences: { tradeoff: { options: ['1', '5', '9'], default: '5' } },
}
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const decode = (body: Uint8Array) => JSON.parse(new TextDecoder().decode(body))

function request(text = 'Help me'): SerializedHttpRequest {
  return { requestId: 'inference', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' },
    body: encode({ model: 'antseed', messages: [{ role: 'user', content: text }] }) }
}

function setup(respond: (body: any) => { statusCode?: number; body: unknown } = body => ({
  body: { version: 1, recommendations: [{ model: body.candidates[0].model, peer: body.candidates[0].peer, provider: body.candidates[0].provider }] },
})) {
  const accepted = vi.fn(() => true)
  const sendRequest = vi.fn<RouteSelectionContext['sendRequest']>(async (_peer, serviceRequest, options) => {
    const reply = respond(decode(serviceRequest.body))
    const response = { requestId: serviceRequest.requestId, statusCode: reply.statusCode ?? 200, headers: {}, body: encode(reply.body) }
    if (response.statusCode === 200 && !options.acceptResponse?.(response)) throw new Error('Not accepted')
    return response
  })
  const context: RouteSelectionContext = {
    routingService: target, description, preferences: { tradeoff: '9' }, signal: new AbortController().signal, conversationKey: 'chat-1',
    candidates: [{ serviceId: 'model-a', peerId: inferenceId, provider: 'openai', inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.1 }],
    acceptRecommendations: accepted, sendRequest,
  }
  return { client: new ModelRoutingClient(), context, accepted, sendRequest }
}

describe('ModelRoutingClient', () => {
  it('describes the router through a free request to the selected peer', async () => {
    const client = new ModelRoutingClient()
    const sendRequest = vi.fn(async (_peer: PeerInfo, serviceRequest: SerializedHttpRequest) =>
      ({ requestId: serviceRequest.requestId, statusCode: 200, headers: {}, body: encode(description) }))
    expect(await client.describe(target, [peer], { signal: new AbortController().signal, sendRequest })).toEqual(description)
    expect(sendRequest.mock.calls[0]![1]).toMatchObject({ method: 'GET', path: '/v1/routing/describe?service=route' })
    sendRequest.mockResolvedValueOnce({ requestId: 'x', statusCode: 200, headers: {}, body: encode({ ...description, supportedServiceIds: 'model-a' }) })
    await expect(client.describe(target, [peer], { signal: new AbortController().signal, sendRequest })).rejects.toThrow('describe response')
  })

  it('sends a generic rank request with prices, preferences and a fixed fee', async () => {
    const state = setup()
    expect(await state.client.selectRoute(request(), [peer], state.context)).toEqual([{ serviceId: 'model-a', peerId: inferenceId, provider: 'openai' }])
    const [, serviceRequest, options] = state.sendRequest.mock.calls[0]!
    expect(serviceRequest.path).toBe('/v1/routing/rank')
    expect(serviceRequest.requestId).not.toBe('inference')
    expect(options.maxFeeMicroUsdc).toBe('1000')
    expect(options.unitBilling).toMatchObject({ provider: 'alpha', service: 'route', serviceApiProtocol: 'model-routing' })
    expect(decode(serviceRequest.body)).toEqual({
      version: 1, service: 'route', revision: 'rev-1', preferences: { tradeoff: '9' },
      input: { text: 'Help me', estimatedTokens: expect.any(Number) },
      candidates: [{ model: 'model-a', peer: inferenceId, provider: 'openai',
        price: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.1 }, expectedCachedInputTokens: 0 }],
    })
  })

  it('puts the observed cache reuse on the exact candidate', async () => {
    const state = setup()
    state.client.recordUsage({ conversationKey: 'chat-1', requestId: 'done', peerId: inferenceId, provider: 'openai', serviceId: 'model-a', inputTokens: 100, cachedInputTokens: 80 })
    state.context.candidates = [...state.context.candidates, { ...state.context.candidates[0]!, serviceId: 'model-b' }]
    await state.client.selectRoute(request('A much longer follow-up question that has plenty of tokens in it'), [peer], state.context)
    const candidates = decode(state.sendRequest.mock.calls[0]![1].body).candidates
    expect(candidates.map((candidate: { model: string; expectedCachedInputTokens: number }) => [candidate.model, candidate.expectedCachedInputTokens]))
      .toEqual([['model-a', expect.any(Number)], ['model-b', 0]])
    expect(candidates[0].expectedCachedInputTokens).toBeGreaterThan(0)
  })

  it('keeps router order, drops recommendations outside the sent candidates and pays only for a usable answer', async () => {
    const other = { serviceId: 'model-b', peerId: inferenceId, provider: 'openai', inputUsdPerMillion: 1, outputUsdPerMillion: 2 }
    const state = setup(() => ({ body: { version: 1, recommendations: [
      { model: 'model-a', peer: 'c'.repeat(40), provider: 'openai' },
      { model: 'model-b', peer: inferenceId, provider: 'openai' },
      { model: 'model-a', peer: inferenceId, provider: 'openai' },
    ] } }))
    state.context.candidates = [...state.context.candidates, other]
    expect(await state.client.selectRoute(request(), [peer], state.context)).toEqual([
      { serviceId: 'model-b', peerId: inferenceId, provider: 'openai' },
      { serviceId: 'model-a', peerId: inferenceId, provider: 'openai' },
    ])
    const rejected = setup(() => ({ body: { version: 1, recommendations: [{ model: 'model-z', peer: inferenceId, provider: 'openai' }] } }))
    await expect(rejected.client.selectRoute(request(), [peer], rejected.context)).rejects.toThrow('no recommendation')
    expect(rejected.accepted).not.toHaveBeenCalled()
  })

  it('maps router errors, including a changed description', async () => {
    for (const [statusCode, message] of [[409, RoutingDescriptionChangedError], [422, 'cannot rank'], [402, 'payment'], [500, 'Routing failed']] as const) {
      const state = setup(() => ({ statusCode, body: { error: 'x' } }))
      await expect(state.client.selectRoute(request(), [peer], state.context)).rejects.toThrow(message)
    }
  })

  it('reuses a same-turn recommendation, but not after the text, preferences or candidates change', async () => {
    const state = setup()
    await state.client.selectRoute(request(), [peer], state.context)
    await state.client.selectRoute(request(), [peer], state.context)
    expect(state.sendRequest).toHaveBeenCalledTimes(1)
    await state.client.selectRoute(request('New turn'), [peer], state.context)
    expect(state.sendRequest).toHaveBeenCalledTimes(2)
    state.context.preferences = { tradeoff: '1' }
    await state.client.selectRoute(request('New turn'), [peer], state.context)
    expect(state.sendRequest).toHaveBeenCalledTimes(3)
    state.context.candidates = [...state.context.candidates, { ...state.context.candidates[0]!, serviceId: 'model-b' }]
    await state.client.selectRoute(request('New turn'), [peer], state.context)
    expect(state.sendRequest).toHaveBeenCalledTimes(4)
  })

  it('validates before paying: user text, supported models and a model-routing offer', async () => {
    const state = setup()
    await expect(state.client.selectRoute(request(''), [peer], state.context)).rejects.toThrow('user text')
    state.context.candidates = [{ ...state.context.candidates[0]!, serviceId: 'unsupported' }]
    await expect(state.client.selectRoute(request(), [peer], state.context)).rejects.toThrow('does not support')
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
    expect(decode(state.sendRequest.mock.calls[0]![1].body).input.text).toBe('Fix the failing test')
    expect(followUp).toEqual([{ serviceId: 'model-a', peerId: inferenceId, provider: 'openai' }])
    expect(state.sendRequest).toHaveBeenCalledTimes(1)
  })

  it('reads Responses input without altering the downstream request', async () => {
    const state = setup()
    const responses = { ...request(), path: '/v1/responses', body: encode({ model: 'antseed', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Through Responses' }] }] }) }
    const before = structuredClone(responses)
    await state.client.selectRoute(responses, [peer], state.context)
    expect(decode(state.sendRequest.mock.calls[0]![1].body).input.text).toBe('Through Responses')
    expect(responses).toEqual(before)
  })
})
