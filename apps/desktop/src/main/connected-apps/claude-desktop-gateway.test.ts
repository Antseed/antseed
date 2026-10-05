import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import {
  CLAUDE_GATEWAY_HEALTH_HEADER,
  CLAUDE_GATEWAY_HEALTH_PATH,
  ClaudeDesktopGateway,
  rewriteModel,
  type ClaudeGatewayModel,
} from './claude-desktop-gateway.js';
import { ROUTED_MODEL_ALIAS } from '../system-proxy/config-patch.js';

type StubRequest = {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
};

type StubBuyer = {
  port: number;
  requests: StubRequest[];
  close: () => Promise<void>;
};

/** A stand-in buyer proxy that records requests and streams a canned SSE reply. */
async function startStubBuyer(): Promise<StubBuyer> {
  const requests: StubRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (req.url === '/v1/messages/count_tokens') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 7 }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function withGateway(
  fn: (gateway: ClaudeDesktopGateway, buyer: StubBuyer) => Promise<void>,
  listModels?: () => readonly ClaudeGatewayModel[],
): Promise<void> {
  const buyer = await startStubBuyer();
  const gateway = new ClaudeDesktopGateway({ port: 0, buyerPort: buyer.port, ...(listModels ? { listModels } : {}) });
  await gateway.start();
  try {
    await fn(gateway, buyer);
  } finally {
    await gateway.stop();
    await buyer.close();
  }
}

function gatewayFetch(gateway: ClaudeDesktopGateway, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${gateway.port}${path}`, init);
}

test('health endpoint answers with the gateway marker header', async () => {
  await withGateway(async (gateway) => {
    const res = await gatewayFetch(gateway, CLAUDE_GATEWAY_HEALTH_PATH);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get(CLAUDE_GATEWAY_HEALTH_HEADER), '1');
  });
});

test('/v1/models without a picker snapshot serves only the Antseed Auto entry', async () => {
  await withGateway(async (gateway) => {
    const res = await gatewayFetch(gateway, '/v1/models');
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Record<string, unknown>[]; has_more: boolean; first_id: string };
    assert.equal(body.has_more, false);
    assert.equal(body.first_id, body.data[0]!['id']);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0]!['display_name'], 'Antseed Auto');
    assert.equal(body.data[0]!['anthropic_family_tier'], 'fable');
    assert.equal(body.data[0]!['is_family_default'], true);
  });
});

test('/v1/models advertises curated picker models behind the remaining Claude ids', async () => {
  const picker: ClaudeGatewayModel[] = [
    { label: 'GLM 5.2', model: 'glm-5.2' },
    { label: 'GPT 5.6 Sol', model: 'gpt-5.6-sol' },
    { label: 'GLM 5.2', model: 'glm-5.2' }, // duplicate — must be dropped
    { label: 'DeepSeek Flash', model: 'deepseek-flash' },
    { label: 'Qwen4 235B', model: 'qwen4-235b' },
    { label: 'One Too Many', model: 'overflow-model' }, // only 4 slots after Auto
  ];
  await withGateway(async (gateway) => {
    const res = await gatewayFetch(gateway, '/v1/models');
    const body = await res.json() as { data: Record<string, unknown>[] };
    assert.deepEqual(
      body.data.map((model) => [model['id'], model['display_name'], model['anthropic_family_tier']]),
      [
        ['claude-fable-5', 'Antseed Auto', 'fable'],
        ['claude-opus-5', 'GLM 5.2', 'opus'],
        ['claude-sonnet-5', 'GPT 5.6 Sol', 'sonnet'],
        ['claude-sonnet-4-6', 'DeepSeek Flash', 'sonnet'],
        ['claude-haiku-4-5-20251001', 'Qwen4 235B', 'haiku'],
      ],
    );
    for (const model of body.data) {
      assert.equal(model['type'], 'model');
      assert.equal(typeof model['created_at'], 'string');
    }
  }, () => picker);
});

test('slot bindings stay stable when the picker reorders', async () => {
  // Claude caches the catalog it fetched — an id it shows as one model must
  // keep routing to that model even after the picker order changes (e.g. the
  // user switches the AI VPN selection, which moves entries to the front).
  let picker: ClaudeGatewayModel[] = [
    { label: 'GLM 5.2', model: 'glm-5.2' },
    { label: 'GPT 5.6 Sol', model: 'gpt-5.6-sol' },
  ];
  await withGateway(async (gateway, buyer) => {
    const catalog = async () => {
      const res = await gatewayFetch(gateway, '/v1/models');
      const body = await res.json() as { data: { id: string; display_name: string }[] };
      return body.data.map((model) => [model.id, model.display_name]);
    };
    assert.deepEqual(await catalog(), [
      ['claude-fable-5', 'Antseed Auto'],
      ['claude-opus-5', 'GLM 5.2'],
      ['claude-sonnet-5', 'GPT 5.6 Sol'],
    ]);

    picker = [
      { label: 'GPT 5.6 Sol', model: 'gpt-5.6-sol' },
      { label: 'GLM 5.2', model: 'glm-5.2' },
    ];
    // Same bindings after the reorder — nothing swaps slots.
    assert.deepEqual(await catalog(), [
      ['claude-fable-5', 'Antseed Auto'],
      ['claude-opus-5', 'GLM 5.2'],
      ['claude-sonnet-5', 'GPT 5.6 Sol'],
    ]);

    await gatewayFetch(gateway, '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
    });
    const forwarded = JSON.parse(buyer.requests[buyer.requests.length - 1]!.body) as Record<string, unknown>;
    assert.equal(forwarded['model'], 'glm-5.2');
  }, () => picker);
});

test('a slot freed by a departed model is rebound to a new one', async () => {
  let picker: ClaudeGatewayModel[] = [
    { label: 'GLM 5.2', model: 'glm-5.2' },
    { label: 'GPT 5.6 Sol', model: 'gpt-5.6-sol' },
  ];
  await withGateway(async (gateway) => {
    await gatewayFetch(gateway, '/v1/models');
    picker = [
      { label: 'GPT 5.6 Sol', model: 'gpt-5.6-sol' },
      { label: 'Qwen4 235B', model: 'qwen4-235b' },
    ];
    const res = await gatewayFetch(gateway, '/v1/models');
    const body = await res.json() as { data: { id: string; display_name: string }[] };
    assert.deepEqual(body.data.map((model) => [model.id, model.display_name]), [
      ['claude-fable-5', 'Antseed Auto'],
      // GLM left the picker, so its slot went to the newcomer; GPT kept its slot.
      ['claude-opus-5', 'Qwen4 235B'],
      ['claude-sonnet-5', 'GPT 5.6 Sol'],
    ]);
  }, () => picker);
});

test('slot bindings persist across gateway restarts and survive an empty picker', async () => {
  const dir = await mkdtemp(nodePath.join(tmpdir(), 'antseed-claude-gateway-'));
  const stateFile = nodePath.join(dir, 'claude-gateway.slots.json');
  try {
    const buyer = await startStubBuyer();
    const picker: ClaudeGatewayModel[] = [{ label: 'GLM 5.2', model: 'glm-5.2' }];
    const first = new ClaudeDesktopGateway({ port: 0, buyerPort: buyer.port, stateFile, listModels: () => picker });
    await first.start();
    await fetch(`http://127.0.0.1:${first.port}/v1/models`);
    await first.stop();

    // A fresh process (app restart) with the picker not yet pushed: the
    // persisted binding must keep Claude's cached id meaning the same model.
    const second = new ClaudeDesktopGateway({ port: 0, buyerPort: buyer.port, stateFile, listModels: () => [] });
    await second.start();
    const res = await fetch(`http://127.0.0.1:${second.port}/v1/models`);
    const body = await res.json() as { data: { id: string; display_name: string }[] };
    assert.deepEqual(body.data.map((model) => [model.id, model.display_name]), [
      ['claude-fable-5', 'Antseed Auto'],
      ['claude-opus-5', 'GLM 5.2'],
    ]);
    await fetch(`http://127.0.0.1:${second.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
    });
    const forwarded = JSON.parse(buyer.requests[buyer.requests.length - 1]!.body) as Record<string, unknown>;
    assert.equal(forwarded['model'], 'glm-5.2');
    await second.stop();
    await buyer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a network model matching a Claude slot id claims that slot', async () => {
  const picker: ClaudeGatewayModel[] = [
    { label: 'GLM 5.2', model: 'glm-5.2' },
    { label: 'Claude Opus 5', model: 'claude-opus-5' },
  ];
  await withGateway(async (gateway) => {
    const res = await gatewayFetch(gateway, '/v1/models');
    const body = await res.json() as { data: { id: string; display_name: string }[] };
    assert.deepEqual(body.data.map((model) => [model.id, model.display_name]), [
      ['claude-fable-5', 'Antseed Auto'],
      // glm binds first in picker order, but the network Opus offer takes its
      // namesake slot so the id Claude sends means exactly that model.
      ['claude-opus-5', 'Claude Opus 5'],
      ['claude-sonnet-5', 'GLM 5.2'],
    ]);
  }, () => picker);
});

test('a picked slot model routes as itself; unadvertised ids fall back to the alias', async () => {
  const picker: ClaudeGatewayModel[] = [{ label: 'GLM 5.2', model: 'glm-5.2' }];
  await withGateway(async (gateway, buyer) => {
    const send = async (model: string) => {
      await gatewayFetch(gateway, '/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [] }),
      });
      return JSON.parse(buyer.requests[buyer.requests.length - 1]!.body) as Record<string, unknown>;
    };
    // The slot map builds lazily on the first message even when Claude uses a
    // catalog cached from a previous gateway process (no /v1/models call yet).
    assert.equal((await send('claude-opus-5'))['model'], 'glm-5.2');
    assert.equal((await send('claude-haiku-4-5-20251001'))['model'], ROUTED_MODEL_ALIAS);
  }, () => picker);
});

test('/v1/messages forwards to the buyer proxy with the model rewritten to the routed alias', async () => {
  await withGateway(async (gateway, buyer) => {
    const res = await gatewayFetch(gateway, '/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        authorization: 'Bearer antseed',
      },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [], stream: true }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const text = await res.text();
    assert.ok(text.includes('message_start') && text.includes('message_stop'));

    assert.equal(buyer.requests.length, 1);
    const forwarded = buyer.requests[0]!;
    assert.equal(forwarded.url, '/v1/messages');
    const body = JSON.parse(forwarded.body) as Record<string, unknown>;
    assert.equal(body['model'], ROUTED_MODEL_ALIAS);
    assert.equal(body['max_tokens'], 16);
    assert.equal(forwarded.headers['anthropic-version'], '2023-06-01');
    // Claude's placeholder credential must never reach the buyer proxy.
    assert.equal(forwarded.headers['authorization'], undefined);
    assert.equal(forwarded.headers['x-api-key'], 'antseed');
    // Attribution marker: Claude Desktop shares its session-header slug with
    // t3code's Claude Code, so the gateway names the source itself.
    assert.equal(forwarded.headers['x-antseed-system-proxy-source'], 'claude-desktop');
  });
});

test('/v1/messages/count_tokens forwards without the routing note', async () => {
  await withGateway(async (gateway, buyer) => {
    const res = await gatewayFetch(gateway, '/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-fable-5', messages: [] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { input_tokens: 7 });
    const forwarded = JSON.parse(buyer.requests[0]!.body) as Record<string, unknown>;
    assert.equal(buyer.requests[0]!.url, '/v1/messages/count_tokens');
    assert.equal(forwarded['system'], undefined);
  });
});

test('/v1/messages appends the Antseed routing note to the system prompt', async () => {
  await withGateway(async (gateway, buyer) => {
    const send = async (extra: Record<string, unknown>) => {
      await gatewayFetch(gateway, '/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(extra),
      });
      return JSON.parse(buyer.requests[buyer.requests.length - 1]!.body) as Record<string, unknown>;
    };

    // Claude's own system string is kept; the note rides at the end.
    const withSystem = await send({ model: 'claude-opus-5', system: 'You are a helpful assistant.', messages: [] });
    assert.ok((withSystem['system'] as string).startsWith('You are a helpful assistant.'));
    assert.ok((withSystem['system'] as string).includes('delivered through the Antseed peer-to-peer network'));

    // Block-array system prompts get the note as a trailing text block, so
    // earlier cache breakpoints stay valid.
    const blocks = await send({
      model: 'claude-fable-5',
      system: [{ type: 'text', text: 'base', cache_control: { type: 'ephemeral' } }],
      messages: [],
    });
    const systemBlocks = blocks['system'] as { type: string; text: string }[];
    assert.equal(systemBlocks.length, 2);
    assert.deepEqual(systemBlocks[0], { type: 'text', text: 'base', cache_control: { type: 'ephemeral' } });
    assert.equal(systemBlocks[1]!.type, 'text');
    assert.ok(systemBlocks[1]!.text.includes('Antseed peer-to-peer network'));

    // No system prompt at all still gets the note.
    const bare = await send({ model: 'antseed', messages: [] });
    assert.ok((bare['system'] as string).includes('Antseed peer-to-peer network'));
  });
});

test('requests carrying an Origin header are rejected', async () => {
  await withGateway(async (gateway) => {
    const res = await gatewayFetch(gateway, '/v1/models', { headers: { origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
  });
});

test('requests with a non-loopback Host are rejected', async () => {
  // fetch() refuses to override Host, so speak raw HTTP for this one.
  await withGateway(async (gateway) => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: gateway.port, path: '/v1/models', headers: { host: `gateway.example:${gateway.port}` } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });
});

test('unknown routes return an Anthropic-shaped 404', async () => {
  await withGateway(async (gateway) => {
    const res = await gatewayFetch(gateway, '/v1/chat/completions', { method: 'POST', body: '{}' });
    assert.equal(res.status, 404);
    const body = await res.json() as { type: string; error: { type: string } };
    assert.equal(body.type, 'error');
    assert.equal(body.error.type, 'not_found_error');
  });
});

test('an unreachable buyer proxy yields an Anthropic-shaped 502', async () => {
  const buyer = await startStubBuyer();
  const deadPort = buyer.port;
  await buyer.close();
  const gateway = new ClaudeDesktopGateway({ port: 0, buyerPort: deadPort });
  await gateway.start();
  try {
    const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5', messages: [] }),
    });
    assert.equal(res.status, 502);
    const body = await res.json() as { error: { type: string } };
    assert.equal(body.error.type, 'api_error');
  } finally {
    await gateway.stop();
  }
});

test('rewriteModel keeps explicit peer pins and the alias, and tolerates non-JSON bodies', () => {
  const slots = new Map([['claude-opus-5', 'glm-5.2']]);
  const mapped = JSON.parse(rewriteModel(Buffer.from(JSON.stringify({ model: 'claude-opus-5' })), slots).toString('utf8')) as Record<string, unknown>;
  assert.equal(mapped['model'], 'glm-5.2');

  const unmapped = JSON.parse(rewriteModel(Buffer.from(JSON.stringify({ model: 'claude-sonnet-5' })), slots).toString('utf8')) as Record<string, unknown>;
  assert.equal(unmapped['model'], ROUTED_MODEL_ALIAS);

  const pinned = JSON.parse(rewriteModel(Buffer.from(JSON.stringify({ model: '0xabc@llama-3.3-70b' })), slots).toString('utf8')) as Record<string, unknown>;
  assert.equal(pinned['model'], '0xabc@llama-3.3-70b');

  const aliased = JSON.parse(rewriteModel(Buffer.from(JSON.stringify({ model: ROUTED_MODEL_ALIAS })), slots).toString('utf8')) as Record<string, unknown>;
  assert.equal(aliased['model'], ROUTED_MODEL_ALIAS);

  const invalid = Buffer.from('not json');
  assert.equal(rewriteModel(invalid, slots), invalid);
});
