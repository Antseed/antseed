import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { controlClient, newToken, startControlServer } from '../lib/control.mjs';
import { MOCK_USAGE, startMock } from '../lib/mock.mjs';
import { createSandboxApi, parseSse } from '../lib/sb.mjs';

describe('mock upstream', () => {
  it('answers every configured model: models, chat, streaming, images', async () => {
    const mock = await startMock({ models: ['m1', 'm2'], label: 'seller s1' });
    try {
      assert.match(mock.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      const models = await (await fetch(`${mock.url}/v1/models`)).json();
      assert.deepEqual(models.data.map((entry) => entry.id).sort(), ['m1', 'm2']);

      const post = (path, body) => fetch(`${mock.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const chat = await (await post('/v1/chat/completions', { model: 'm2', messages: [{ role: 'user', content: 'hi' }] })).json();
      assert.match(chat.choices[0].message.content, /seller s1.*m2/);
      assert.deepEqual(chat.usage, MOCK_USAGE);

      const stream = await post('/v1/chat/completions', { model: 'm1', stream: true, messages: [] });
      assert.match(stream.headers.get('content-type'), /text\/event-stream/);
      const parsed = parseSse(await stream.text());
      assert.equal(parsed.done, true);
      assert.match(parsed.content, /m1/);
      assert.deepEqual(parsed.usage, MOCK_USAGE);

      const image = await (await post('/v1/images/generations', { model: 'm1', prompt: 'x' })).json();
      assert.equal(Buffer.from(image.data[0].b64_json, 'base64').subarray(1, 4).toString(), 'PNG');

      const missing = await post('/v1/chat/completions', { model: 'nope', messages: [] });
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).error.code, 'model_not_found');
      assert.equal(mock.chatCount(), 3);
    } finally {
      await mock.stop();
    }
  });

  it('applies configurable latency', async () => {
    const mock = await startMock({ models: ['m'], latencyMs: 150 });
    try {
      const started = Date.now();
      await fetch(`${mock.url}/v1/models`);
      assert.ok(Date.now() - started >= 140);
      mock.setLatency(0);
      const fast = Date.now();
      await fetch(`${mock.url}/v1/models`);
      assert.ok(Date.now() - fast < 140);
    } finally {
      await mock.stop();
    }
  });
});

describe('control API', () => {
  it('requires the bearer token and routes with params', async () => {
    const token = newToken();
    const server = await startControlServer({
      token,
      routes: {
        'GET /status': () => ({ hello: 'world' }),
        'POST /sellers/:id/stop': ({ params, body }) => ({ id: params.id, body }),
        'POST /fail': () => { throw Object.assign(new Error('bad input'), { statusCode: 400 }); },
      },
    });
    try {
      assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal((await fetch(`${server.url}/status`)).status, 401);
      assert.equal((await fetch(`${server.url}/status`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
      const client = controlClient({ url: server.url, token });
      assert.equal((await client.status()).hello, 'world');
      assert.deepEqual(await client.stopSeller('s-1'), { ok: true, id: 's-1', body: {} });
      const missing = await fetch(`${server.url}/nope`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(missing.status, 404);
      const failed = await fetch(`${server.url}/fail`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      assert.equal(failed.status, 400);
      assert.throws(() => controlClient({ url: 'http://example.com:1', token }), /owned http/);
    } finally {
      await server.stop();
    }
  });
});

describe('scenario api', () => {
  const manifest = {
    proxyUrl: 'http://127.0.0.1:9', rpcUrl: 'http://127.0.0.1:9', buyer: { address: '0x0' },
    sellers: [{ id: 's', peerId: 'a'.repeat(40), address: '0x1', models: ['m'] }],
    topology: { sellers: [{ id: 's', providers: { p: { plugin: 'openai', defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { m: {}, pricey: { pricing: { inputUsdPerMillion: 100, outputUsdPerMillion: 200 } } } } } }] },
  };
  const chain = { depositsContractAddress: '0x' + '1'.repeat(40), usdcContractAddress: '0x' + '2'.repeat(40), channelsContractAddress: '0x' + '3'.repeat(40) };

  it('records checks, known issues and mock pricing', () => {
    const sb = createSandboxApi({ manifest, control: {}, eventsPath: '/dev/null', chain });
    try {
      sb.check('ok', true);
      assert.throws(() => sb.check('bad', false, { x: 1 }), /bad/);
      sb.knownIssue('tracked', false, { a: 1 }, 'bug-123');
      assert.equal(sb.mockCostPerChat('s', 'm'), 18n);
      assert.equal(sb.mockCostPerChat('s', 'pricey'), 2600n);
      const summary = sb.summary();
      assert.deepEqual(summary.checks.map((entry) => [entry.name, entry.ok]), [['ok', true], ['bad', false]]);
      assert.deepEqual(summary.knownIssues, [{ name: 'tracked', ok: false, issue: 'bug-123', detail: { a: 1 } }]);
    } finally {
      sb.dispose();
    }
  });

  it('known issues fail the run under --strict', () => {
    const sb = createSandboxApi({ manifest, control: {}, eventsPath: '/dev/null', chain, strict: true });
    try {
      assert.throws(() => sb.knownIssue('tracked', false, {}, 'bug-123'), /known issue: bug-123/);
      assert.doesNotThrow(() => sb.knownIssue('fixed', true, {}, 'bug-123'));
    } finally {
      sb.dispose();
    }
  });

  it('refuses a non-loopback proxy', () => {
    assert.throws(() => createSandboxApi({ manifest: { ...manifest, proxyUrl: 'http://10.0.0.1:1' }, control: {}, eventsPath: '/dev/null', chain }), /owned http/);
  });

  it('parses SSE text', () => {
    const text = 'data: {"choices":[{"delta":{"content":"he"}}]}\n\ndata: {"choices":[{"delta":{"content":"llo"}}]}\n\ndata: {"choices":[],"usage":{"total_tokens":3}}\n\ndata: [DONE]\n\n';
    assert.deepEqual(parseSse(text), { content: 'hello', usage: { total_tokens: 3 }, done: true });
  });
});
