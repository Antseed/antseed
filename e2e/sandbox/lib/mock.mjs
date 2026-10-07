import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_PNG = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'pixel.png');
export const MOCK_USAGE = { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 };

/**
 * OpenAI-compatible upstream for sandbox sellers. Answers every configured model with deterministic
 * content and fixed token usage so receipts and settlement are exact.
 */
export async function startMock({ models, label = 'mock', latencyMs = 0 }) {
  const png = await readFile(FIXTURE_PNG);
  const state = { latencyMs, requests: [] };
  const known = new Set(models);
  const server = createServer(async (request, response) => {
    const json = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? JSON.parse(text) : {};
      const path = (request.url ?? '/').split('?')[0];
      state.requests.push({ method: request.method, path, model: body.model ?? null, stream: Boolean(body.stream), at: Date.now() });
      if (state.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, state.latencyMs));
      if (request.method === 'GET' && path === '/v1/models') {
        return json(200, { object: 'list', data: models.map((id) => ({ id, object: 'model', owned_by: 'antseed-sandbox' })) });
      }
      if (request.method !== 'POST') return json(404, { error: { message: `No mock route for ${request.method} ${path}`, type: 'invalid_request_error' } });
      if (body.model !== undefined && !known.has(body.model)) {
        return json(404, { error: { message: `The model ${body.model} does not exist`, type: 'invalid_request_error', code: 'model_not_found' } });
      }
      if (path === '/v1/chat/completions') {
        const content = `Hello from ${label} (${body.model}).`;
        const id = `chatcmpl-${state.requests.length}`;
        const created = Math.floor(Date.now() / 1000);
        if (!body.stream) {
          return json(200, {
            id, object: 'chat.completion', created, model: body.model,
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
            usage: MOCK_USAGE,
          });
        }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const chunk = (choices, usage = null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices, usage })}\n\n`;
        response.write(chunk([{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }]));
        response.write(chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]));
        response.write(chunk([], MOCK_USAGE));
        return response.end('data: [DONE]\n\n');
      }
      if (path === '/v1/images/generations') {
        return json(200, { created: Math.floor(Date.now() / 1000), data: [{ b64_json: png.toString('base64') }], usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 } });
      }
      return json(404, { error: { message: `No mock route for ${path}`, type: 'invalid_request_error' } });
    } catch (error) {
      json(500, { error: { message: error.message, type: 'server_error' } });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    port: server.address().port,
    state,
    setLatency(ms) { state.latencyMs = ms; },
    chatCount() { return state.requests.filter((entry) => entry.path === '/v1/chat/completions').length; },
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
