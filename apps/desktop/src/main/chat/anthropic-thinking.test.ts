import test from 'node:test';
import assert from 'node:assert/strict';
import { streamSimple } from '@mariozechner/pi-ai';

import { anthropicEffort, anthropicThinkingMode, shapeAnthropicThinking, type ThinkingLevel } from './anthropic-thinking.js';
import { makeGatewayModel } from './gateway-model.js';

const ENDPOINT = { mode: 'local' as const, origin: 'http://127.0.0.1:8379', apiKey: 'antseed_key' };
const STOP = 'stop before sending';

/**
 * The Messages body the chat sends: pi-ai builds it for the gateway model,
 * then the chat's `before_provider_request` hook shapes it. Nothing is sent:
 * the capture stops the request before it leaves.
 */
async function chatRequestBody(modelId: string, { reasoning, level }: { reasoning: boolean; level: ThinkingLevel }): Promise<Record<string, unknown>> {
  const model = makeGatewayModel({ modelId, endpoint: ENDPOINT, protocol: 'anthropic-messages', supportsImages: false, reasoning });
  let body: Record<string, unknown> | undefined;
  const stream = streamSimple(model, { messages: [{ role: 'user', content: 'hello', timestamp: 0 }] }, {
    apiKey: ENDPOINT.apiKey,
    // How pi's agent passes its level: `off` is no reasoning option.
    ...(level === 'off' ? {} : { reasoning: level }),
    onPayload: (payload) => {
      body = shapeAnthropicThinking(payload, { modelId, reasoning: model.reasoning, level }) as Record<string, unknown>;
      throw new Error(STOP);
    },
  });
  for await (const event of stream) {
    if (event.type === 'error') assert.equal(event.error.errorMessage, STOP);
  }
  assert.ok(body, 'the request body was built');
  return body;
}

test('a current Claude model gets adaptive thinking with an effort and its summary shown, never a thinking budget', async () => {
  const body = await chatRequestBody('claude-haiku-5-5', { reasoning: true, level: 'medium' });
  // `display` defaults to `omitted` (empty thinking text) on these models; the chat shows the summary.
  assert.deepEqual(body['thinking'], { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(body['output_config'], { effort: 'medium' });
  // Pinned to a seller, the model part decides.
  const pinned = await chatRequestBody(`${'ab12'.repeat(10)}@claude-sonnet-5-5`, { reasoning: true, level: 'high' });
  assert.deepEqual([pinned['thinking'], pinned['output_config']], [{ type: 'adaptive', display: 'summarized' }, { effort: 'high' }]);
});

test('a service that does not declare reasoning gets no thinking field', async () => {
  for (const modelId of ['claude-haiku-5-5', 'claude-haiku-4-5']) {
    const body = await chatRequestBody(modelId, { reasoning: false, level: 'medium' });
    assert.equal('thinking' in body, false, modelId);
    assert.equal('output_config' in body, false, modelId);
  }
});

test('an older Claude model keeps its thinking budget', async () => {
  for (const modelId of ['claude-haiku-4-5-20251001', 'claude-opus-4-5', 'claude-sonnet-4-20250514']) {
    const body = await chatRequestBody(modelId, { reasoning: true, level: 'medium' });
    const thinking = body['thinking'] as { type: string; budget_tokens: number };
    assert.equal(thinking.type, 'enabled', modelId);
    assert.equal('display' in thinking, false, modelId);
    assert.ok(thinking.budget_tokens >= 1024 && thinking.budget_tokens < Number(body['max_tokens']), modelId);
    assert.equal('output_config' in body, false, modelId);
  }
});

test('a model the chat cannot place, or thinking off, sends no thinking field rather than one that can 400', async () => {
  // An agent's own name, another vendor's model, a version-first Claude 3 id.
  for (const modelId of ['code-helper', 'deepseek-v4-flash', 'claude-3-5-haiku-20241022']) {
    const body = await chatRequestBody(modelId, { reasoning: true, level: 'medium' });
    assert.equal('thinking' in body, false, modelId);
  }
  // Off is no field, never `disabled`: current models reject that too.
  for (const modelId of ['claude-opus-5-5', 'claude-opus-4-5']) {
    const off = await chatRequestBody(modelId, { reasoning: true, level: 'off' });
    assert.equal('thinking' in off, false, modelId);
    assert.equal('output_config' in off, false, modelId);
  }
});

test('the thinking form follows the per-model table', () => {
  const cases: Array<[string, ReturnType<typeof anthropicThinkingMode>]> = [
    ['claude-fable-5-2', 'adaptive'],
    ['claude-mythos-5', 'adaptive'],
    ['claude-opus-5-5', 'adaptive'],
    ['claude-opus-4-8', 'adaptive'],
    ['claude-opus-4.7', 'adaptive'],
    ['anthropic.claude-opus-4-6-v1', 'adaptive'],
    ['claude-sonnet-5', 'adaptive'],
    ['claude-sonnet-4-6', 'adaptive'],
    ['claude-haiku-5-5', 'adaptive'],
    ['claude-opus-4-5-20251101', 'budget'],
    ['claude-opus-4-1', 'budget'],
    ['claude-sonnet-4-5@20250929', 'budget'],
    ['claude-haiku-4-5', 'budget'],
    ['claude-3-7-sonnet-latest', null],
    ['claude-mythos-preview', null],
    ['gpt-5.5', null],
  ];
  for (const [modelId, mode] of cases) assert.equal(anthropicThinkingMode(modelId), mode, modelId);
});

test('thinking levels map to effort, xhigh only where the model has it', () => {
  assert.deepEqual(
    (['minimal', 'low', 'medium', 'high', 'xhigh'] as const).map((level) => anthropicEffort(level, 'claude-haiku-5-5')),
    ['low', 'low', 'medium', 'high', 'xhigh'],
  );
  assert.equal(anthropicEffort('xhigh', 'claude-opus-4-7'), 'xhigh');
  assert.equal(anthropicEffort('xhigh', 'claude-opus-4-6'), 'high');
  assert.equal(anthropicEffort('xhigh', 'claude-sonnet-4-6'), 'high');
});

test('shaping keeps other output_config fields and the rest of the body', () => {
  const payload = {
    model: 'claude-haiku-5-5',
    max_tokens: 1000,
    thinking: { type: 'enabled', budget_tokens: 512 },
    output_config: { format: { type: 'json_schema' }, effort: 'max' },
  };
  assert.deepEqual(shapeAnthropicThinking(payload, { modelId: 'claude-haiku-5-5', reasoning: false, level: 'medium' }), {
    model: 'claude-haiku-5-5',
    max_tokens: 1000,
    output_config: { format: { type: 'json_schema' } },
  });
  assert.deepEqual(shapeAnthropicThinking(payload, { modelId: 'claude-haiku-5-5', reasoning: true, level: 'low' }), {
    model: 'claude-haiku-5-5',
    max_tokens: 1000,
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { format: { type: 'json_schema' }, effort: 'low' },
  });
});
