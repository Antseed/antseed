import test from 'node:test';
import assert from 'node:assert/strict';
import { streamSimple } from '@mariozechner/pi-ai';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStorage, compact, createAgentSession, generateSummary, ModelRegistry, SessionManager, SettingsManager } from '@mariozechner/pi-coding-agent';

import { anthropicEffort, anthropicThinkingMode, registerGatewayAnthropic, shapeAnthropicThinking, type AnthropicGatewayModel, type ThinkingLevel } from './anthropic-thinking.js';
import { GATEWAY_PROVIDER_ID, makeGatewayModel } from './gateway-model.js';

const ENDPOINT = { mode: 'local' as const, origin: 'http://127.0.0.1:8379', apiKey: 'antseed_key' };
const STOP = 'stop before sending';

// As the chat does for a session over Anthropic Messages: from here on pi sends
// every request for that protocol through the chat's stream function.
registerGatewayAnthropic(ModelRegistry.inMemory(AuthStorage.inMemory()), GATEWAY_PROVIDER_ID);

function gatewayModel(modelId: string, reasoning: boolean): AnthropicGatewayModel {
  return makeGatewayModel({ modelId, endpoint: ENDPOINT, protocol: 'anthropic-messages', supportsImages: false, reasoning }) as AnthropicGatewayModel;
}

/**
 * The Messages body a chat turn sends, built the way pi's agent sends a turn
 * (`streamSimple` with its level). Nothing is sent: the capture stops the
 * request before it leaves.
 */
async function chatRequestBody(modelId: string, { reasoning, level }: { reasoning: boolean; level: ThinkingLevel }): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | undefined;
  const stream = streamSimple(gatewayModel(modelId, reasoning), { messages: [{ role: 'user', content: 'hello', timestamp: 0 }] }, {
    apiKey: ENDPOINT.apiKey,
    // How pi's agent passes its level: `off` is no reasoning option.
    ...(level === 'off' ? {} : { reasoning: level }),
    onPayload: (payload) => {
      body = payload as Record<string, unknown>;
      throw new Error(STOP);
    },
  });
  for await (const event of stream) {
    if (event.type === 'error') assert.equal(event.error.errorMessage, STOP);
  }
  assert.ok(body, 'the request body was built');
  return body;
}

/**
 * The Messages bodies pi's own compaction sends, in the order they left. It
 * calls the provider directly, outside a chat turn, so the only place to see
 * them is the wire: fetch is replaced and answers 400, and nothing leaves.
 */
async function compactionRequestBodies(run: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
  const bodies: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: STOP } }), { status: 400, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await assert.rejects(run, new RegExp(STOP));
  } finally {
    globalThis.fetch = originalFetch;
  }
  return bodies;
}

const HISTORY = [{ role: 'user' as const, content: 'hello', timestamp: 0 }];

test('a compaction summary for a current Claude model asks for adaptive thinking, never a thinking budget', async () => {
  const model = gatewayModel('claude-haiku-5-5', true);
  const [body] = await compactionRequestBodies(() => generateSummary(HISTORY, model, 16_384, ENDPOINT.apiKey));
  assert.ok(body, 'the summary request was built');
  assert.deepEqual(body['thinking'], { type: 'adaptive', display: 'summarized' });
  // pi asks for its summaries at `high`.
  assert.deepEqual(body['output_config'], { effort: 'high' });
});

test('a split-turn compaction sends no `disabled` thinking, which current models reject', async () => {
  const model = gatewayModel('claude-opus-5-5', true);
  const bodies = await compactionRequestBodies(() => compact({
    firstKeptEntryId: 'entry-1',
    messagesToSummarize: HISTORY,
    turnPrefixMessages: HISTORY,
    isSplitTurn: true,
    tokensBefore: 0,
    fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
    settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
  }, model, ENDPOINT.apiKey));
  // The history summary (`high`) and the turn-prefix summary (no level).
  assert.equal(bodies.length, 2);
  const thinking = bodies.map((body) => body['thinking']);
  assert.equal(thinking.some((value) => (value as { type?: string } | undefined)?.type === 'disabled'), false, JSON.stringify(thinking));
  assert.deepEqual(thinking.filter(Boolean), [{ type: 'adaptive', display: 'summarized' }]);
});

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

test('an older model whose id pi reads as a 4.6 model still gets a thinking budget, not adaptive thinking or none', async () => {
  // pi-ai matches `opus-4-6` and `sonnet-4-6` anywhere in the id, so it builds adaptive thinking for these.
  // The budget a model pi places correctly gets at the same level.
  const older = await chatRequestBody('claude-opus-4-5', { reasoning: true, level: 'medium' });
  for (const modelId of ['claude-opus-4-64k', 'claude-sonnet-4-64k']) {
    const body = await chatRequestBody(modelId, { reasoning: true, level: 'medium' });
    const thinking = body['thinking'] as { type: string; budget_tokens: number } | undefined;
    assert.deepEqual(thinking, older['thinking'], modelId);
    assert.ok(thinking && thinking.type === 'enabled' && thinking.budget_tokens >= 1024 && thinking.budget_tokens < Number(body['max_tokens']), modelId);
    assert.equal('output_config' in body, false, modelId);
  }
});

test('a thinking budget is at least 1024 tokens and below max_tokens, or it is left out', () => {
  const shaped = (maxTokens: number, level: ThinkingLevel, thinking?: Record<string, unknown>) => (shapeAnthropicThinking(
    { model: 'claude-haiku-4-5', max_tokens: maxTokens, ...(thinking ? { thinking } : {}) },
    { modelId: 'claude-haiku-4-5', reasoning: true, level },
  ) as Record<string, unknown>)['thinking'];
  // pi-ai's own budget is kept; without one the level decides.
  assert.deepEqual(shaped(32_000, 'medium', { type: 'enabled', budget_tokens: 7168 }), { type: 'enabled', budget_tokens: 7168 });
  assert.deepEqual(shaped(32_000, 'low', { type: 'adaptive' }), { type: 'enabled', budget_tokens: 2048 });
  assert.deepEqual(shaped(32_000, 'xhigh'), { type: 'enabled', budget_tokens: 16_384 });
  // A budget that does not fit shrinks to leave 1024 tokens for the answer.
  assert.deepEqual(shaped(4096, 'high'), { type: 'enabled', budget_tokens: 3072 });
  assert.deepEqual(shaped(8192, 'medium', { type: 'enabled', budget_tokens: 8192 }), { type: 'enabled', budget_tokens: 7168 });
  // No valid budget fits: no thinking field.
  assert.equal(shaped(2000, 'medium'), undefined);
  assert.equal(shaped(32_000, 'off', { type: 'disabled' }), undefined);
});

test('a resumed chat keeps its saved thinking level, off included, whether or not its sellers reason', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-thinking-level-'));
  const resumedLevel = async (saved: ThinkingLevel, reasoning: boolean): Promise<string> => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({ role: 'user', content: 'hello', timestamp: 0 });
    sessionManager.appendThinkingLevelChange(saved);
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(GATEWAY_PROVIDER_ID, ENDPOINT.apiKey);
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    registerGatewayAnthropic(modelRegistry, GATEWAY_PROVIDER_ID);
    const model = gatewayModel('claude-haiku-5-5', reasoning);
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, sessionManager, settingsManager: SettingsManager.inMemory(), authStorage, modelRegistry, model });
    await session.setModel(model);
    return session.thinkingLevel;
  };
  try {
    assert.deepEqual(
      [await resumedLevel('off', true), await resumedLevel('off', false), await resumedLevel('high', false), await resumedLevel('high', true)],
      ['off', 'off', 'high', 'high'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude 3.7 Sonnet, named version first, keeps its thinking budget', async () => {
  for (const modelId of ['claude-3-7-sonnet-20250219', 'claude-3-7-sonnet-latest', `${'ab12'.repeat(10)}@claude-3-7-sonnet-20250219`]) {
    const body = await chatRequestBody(modelId, { reasoning: true, level: 'medium' });
    const thinking = body['thinking'] as { type: string; budget_tokens: number };
    assert.equal(thinking.type, 'enabled', modelId);
    assert.ok(thinking.budget_tokens >= 1024 && thinking.budget_tokens < Number(body['max_tokens']), modelId);
    assert.equal('display' in thinking, false, modelId);
    assert.equal('output_config' in body, false, modelId);
  }
});

test('a model the chat cannot place, or thinking off, sends no thinking field rather than one that can 400', async () => {
  // An agent's own name, another vendor's model, Claude 3 models without thinking.
  for (const modelId of ['code-helper', 'deepseek-v4-flash', 'claude-3-5-haiku-20241022', 'claude-3-5-sonnet-latest', 'claude-3-opus-20240229', 'claude-3-haiku-20240307']) {
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
    ['claude-3-7-sonnet-20250219', 'budget'],
    ['anthropic.claude-3-7-sonnet-20250219-v1:0', 'budget'],
    ['claude-3-7-sonnet@20250219', 'budget'],
    ['claude-3-5-sonnet-20241022', null],
    ['claude-3-opus-latest', null],
    // Mythos Preview has no version in its id.
    ['claude-mythos-preview', 'adaptive'],
    ['anthropic.claude-mythos-preview', 'adaptive'],
    ['us.anthropic.claude-haiku-5-5', 'adaptive'],
    ['anthropic/claude-opus-4.7', 'adaptive'],
    ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'budget'],
    // A size suffix is not a minor version.
    ['claude-opus-4-32k', 'budget'],
    ['claude-sonnet-4-64k', 'budget'],
    // An agent's own name that contains a Claude id is not that model.
    ['my-agent-claude-opus-4-7', null],
    ['helper-claude-3-7-sonnet', null],
    ['team-claude-mythos-preview', null],
    ['claude-mythos-previews', null],
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
  assert.equal(anthropicEffort('xhigh', 'claude-mythos-5-2'), 'xhigh');
  assert.equal(anthropicEffort('xhigh', 'claude-mythos-preview'), 'high');
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
