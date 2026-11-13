import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';
import openaiPlugin from '../../plugins/provider-openai/src/index.js';
import { usePaymentNetwork } from './helpers/payment-network.js';

/**
 * A TEE seller runs in content-free mode, and its operator may read its logs and databases, so
 * they must never hold what a buyer sent or what the model answered. Every request and answer
 * here carries a marker; none may reach the seller's log output or data dir.
 */
const PROMPT = 'PROMPT-MARKER-7f3a';
const ANSWER = 'ANSWER-MARKER-9c1e';
const UPSTREAM = 'https://upstream.example';

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const sse = (...events: object[]) => new Response(
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
  { headers: { 'content-type': 'text/event-stream' } },
);

describe('seller logs and databases', () => {
  const network = usePaymentNetwork('content-leak');

  it('never hold prompts, answers or upstream error text', async () => {
    await network.setupRpc();
    vi.stubEnv('ANTSEED_CONTENT_FREE_LOGS', '1');
    const output: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { output.push(format(...args)); });
    }
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith(`${UPSTREAM}/`)) return originalFetch(input, init);
      const body = JSON.parse(Buffer.from(init!.body as Uint8Array).toString());
      const said = JSON.stringify(body.messages);
      expect(said).toContain(PROMPT);
      const mode = body.messages[0].content.split(' ')[0];
      // Upstreams quote requests back in their errors.
      if (mode === 'reject') return Response.json({ error: { message: `Invalid request: ${said}`, type: 'invalid_request_error', code: 'bad' } }, { status: 400 });
      if (mode === 'crash') return new Response(`internal error while handling ${said}`, { status: 500 });
      if (mode === 'short') return sse({ choices: [{ index: 0, delta: { content: ANSWER } }] });
      if (mode === 'stream') {
        return sse(
          { choices: [{ index: 0, delta: { content: `${ANSWER} `.repeat(40) } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 80 } },
        );
      }
      return Response.json({
        id: 'c1', object: 'chat.completion', model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: ANSWER }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      });
    });
    try {
      const provider = await openaiPlugin.createProvider({ OPENAI_API_KEY: 'k', OPENAI_BASE_URL: UPSTREAM, ANTSEED_ALLOWED_SERVICES: 'chat-model' });
      const { port } = await network.setupProxyNetwork(provider);
      const chat = (mode: string, stream = false) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'chat-model', stream, messages: [{ role: 'user', content: `${mode} ${PROMPT}` }] }),
      }).then(async (res) => ({ status: res.status, text: await res.text() }));

      expect((await chat('answer')).text).toContain(ANSWER);
      expect((await chat('stream', true)).text).toContain(ANSWER);
      expect((await chat('short', true)).text).toContain(ANSWER);
      expect((await chat('reject')).status).toBe(400);
      expect((await chat('crash')).status).toBeGreaterThanOrEqual(500);

      // Let metering and payment writes land.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const dataDir = network.sellerDataDir!;
      await network.sellerNode!.stop();
      network.sellerNode = null;
      vi.restoreAllMocks();

      const leaks = [PROMPT, ANSWER].flatMap((marker) => [
        ...output.filter((line) => line.includes(marker)).map((line) => `log: ${line.slice(0, 300)}`),
        ...filesUnder(dataDir).filter((path) => readFileSync(path).includes(marker)).map((path) => `${marker} in ${path.slice(dataDir.length + 1)}`),
      ]);
      expect(leaks).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  }, 60_000);
});
