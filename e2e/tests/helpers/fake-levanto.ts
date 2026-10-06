import type { Provider, RoutingRankRequestV1, SerializedHttpRequest, SerializedHttpResponse, ServiceApiProtocol, ServiceUnitBillingModelsV1 } from '@antseed/node';
import { validateRoutingRankRequest } from '@antseed/node';

export type FakeRoutingMode = 'first' | 'second' | 'fallback' | 'invalid-json' | 'empty' | 'foreign-peer' | 'wrong-model' | 'unavailable' | 'delayed' | 'ignore-constraints' | 'wrong-provider' | 'cannot-rank';

export class FakeLevantoProvider implements Provider {
  readonly name = 'fake-levanto';
  readonly services = ['levanto-route'];
  readonly pricing = { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } };
  readonly maxConcurrency = 10;
  readonly serviceApiProtocols: Record<string, ServiceApiProtocol[]> = { 'levanto-route': ['model-routing'] };
  readonly serviceUnitBillingModels: ServiceUnitBillingModelsV1;
  models = ['model-a', 'model-b'];
  modelsRequests = 0;
  mode: FakeRoutingMode = 'first';
  requests: Array<Record<string, unknown>> = [];
  candidates: Array<{ model: string; peer: string }> = [];

  constructor(priceUsd = 0) {
    this.serviceUnitBillingModels = { 'levanto-route': { 'model-routing': { version: 1, components: [{ unit: 'completed_requests', priceUsd }] } } };
  }

  getCapacity() { return { current: 0, max: this.maxConcurrency }; }

  async handleRequest(request: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    const response = (statusCode: number, detail: string): SerializedHttpResponse => ({ requestId: request.requestId, statusCode,
      headers: { 'content-type': 'application/problem+json' }, body: Buffer.from(JSON.stringify({ detail })) });
    if (request.headers['x-antseed-service'] !== 'levanto-route') return response(404, 'Unknown service');
    if (request.method === 'GET' && request.path === '/v1/routing/models') {
      this.modelsRequests++;
      return { requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ object: 'list', data: this.models.map(id => ({ id, object: 'model' })) })) };
    }
    let body: RoutingRankRequestV1;
    try {
      body = JSON.parse(Buffer.from(request.body).toString());
      validateRoutingRankRequest(body);
    } catch { return response(400, 'Invalid IRP rank request'); }
    this.requests.push(body);
    if (this.mode === 'cannot-rank') return response(422, 'No scorable candidates');
    const mode = this.mode;
    if (mode === 'delayed') await new Promise((resolve) => setTimeout(resolve, 500));
    let candidates = mode === 'second' ? this.candidates.slice(1, 2)
      : mode === 'fallback' || mode === 'ignore-constraints' ? this.candidates
      : mode === 'empty' ? []
      : mode === 'foreign-peer' ? [{ model: 'model-a', peer: 'f'.repeat(40) }]
      : mode === 'wrong-model' ? [{ model: 'unadvertised-model', peer: this.candidates[0]!.peer }]
      : this.candidates.slice(0, 1);
    if (['first', 'second', 'fallback', 'delayed'].includes(mode)) {
      const allowed = body.routing.candidates;
      candidates = candidates.filter(candidate => allowed.some(entry => entry.id === 'fake-inference:' + candidate.model + '@' + candidate.peer));
      if (!candidates.length) return response(422, 'no_allowed_candidates');
    }
    return {
      requestId: request.requestId,
      statusCode: mode === 'unavailable' ? 503 : 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(mode === 'invalid-json' ? '{invalid' : JSON.stringify({
        id: request.requestId, object: 'routing.ranking', created: Math.floor(Date.now() / 1000),
        router: { id: 'fake-levanto', version: '1' }, ranked: candidates.map(candidate => ({
          candidate_id: (mode === 'wrong-provider' ? 'other-provider' : 'fake-inference') + ':' + candidate.model + '@' + candidate.peer,
        })),
      })),
    };
  }
}

export class FakeRoutedInferenceProvider implements Provider {
  readonly name = 'fake-inference';
  readonly services = ['model-a', 'model-b'];
  readonly pricing = { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } };
  readonly serviceApiProtocols: Record<string, ServiceApiProtocol[]> = {
    'model-a': ['anthropic-messages', 'openai-chat-completions'],
    'model-b': ['anthropic-messages', 'openai-chat-completions'],
  };
  readonly maxConcurrency = 10;
  requests: Array<Record<string, unknown>> = [];
  failingModels = new Set<string>();
  getCapacity() { return { current: 0, max: this.maxConcurrency }; }

  async handleRequest(request: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    const body = JSON.parse(Buffer.from(request.body).toString()) as Record<string, unknown>;
    this.requests.push(body);
    const model = String(body.model);
    const failed = this.failingModels.has(model);
    const content = `Reply from ${model}`;
    if (!failed && body.stream === true) {
      const events = request.path === '/v1/messages' ? [
        { type: 'message_start', message: { id: request.requestId, type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } },
        { type: 'message_stop' },
      ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
        : `data: ${JSON.stringify({ id: request.requestId, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: request.requestId, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`;
      return { requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: Buffer.from(events) };
    }
    const payload = failed ? { error: { message: 'Fake inference unavailable' } }
      : request.path === '/v1/messages' ? {
        id: `msg-${request.requestId}`, type: 'message', role: 'assistant', model,
        content: [{ type: 'text', text: content }], stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 10 },
      } : {
        id: request.requestId, object: 'chat.completion', model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      };
    return { requestId: request.requestId, statusCode: failed ? 503 : 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(payload)) };
  }
}
