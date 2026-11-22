// A local OpenAI-compatible upstream over TLS 1.2 for `stress-seller-blind-relay`: the relay needs a TLS upstream,
// and this one costs nothing. Its certificate is the keyed-relay test fixture's, signed by that test CA.
// usage: node mock-upstream.mjs [port] [expected bearer key]
// HTTPS on 127.0.0.1 and ::1 at <port> (default 18443); plain-HTTP stats on 127.0.0.1 at <port + 1> (GET /stats).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = fileURLToPath(new URL('../../../../packages/keyed-relay/test/fixtures', import.meta.url));
const port = Number(process.argv[2] ?? 18443);
const expectedKey = process.argv[3] ?? process.env.TESTBENCH_UPSTREAM_KEY ?? 'sk-testbench-not-a-real-key';
const FIRST_BYTE_MS = Number(process.env.MOCK_FIRST_BYTE_MS ?? 250);
const CHUNK_GAP_MS = Number(process.env.MOCK_CHUNK_GAP_MS ?? 60);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const seen = [];
let inFlight = 0;
let maxInFlight = 0;

async function answer(req, res) {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  const keyOk = req.headers.authorization === `Bearer ${expectedKey}`;
  const entry = { at: Date.now(), path: req.url, keyOk, connection: req.headers.connection ?? null, userAgent: req.headers['user-agent'] ?? null, headerNames: Object.keys(req.headers) };
  seen.push(entry);
  if (!keyOk) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'bad key' } }));
    return;
  }
  let body;
  try { body = JSON.parse(raw); } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'bad json' } }));
    return;
  }
  const prompt = String(body.messages?.at(-1)?.content ?? '');
  const marker = /\[\[([^\]]+)\]\]/.exec(prompt)?.[1] ?? null;
  const digest = createHash('sha256').update(raw).digest();
  const cap = Number(body.max_tokens ?? body.max_completion_tokens ?? 64);
  const usage = { prompt_tokens: 20 + (digest.readUInt16BE(0) % 900), completion_tokens: 1 + (digest.readUInt16BE(2) % Math.max(1, Math.min(cap, 400))) };
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  Object.assign(entry, { marker, stream: Boolean(body.stream), model: body.model, usage, bodyKeys: Object.keys(body) });
  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    const id = `chatcmpl-${digest.subarray(4, 12).toString('hex')}`;
    const words = ['echo', ` ${marker ?? 'none'}`, ' done'];
    await sleep(FIRST_BYTE_MS);
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const base = { id, object: 'chat.completion.chunk', model: body.model };
      for (const word of words) {
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: word }, finish_reason: null }] })}\n\n`);
        await sleep(CHUNK_GAP_MS);
      }
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [], usage })}\n\n`);
      res.write('data: [DONE]\n\n');
      await sleep(20);
      res.end();
    } else {
      await sleep(CHUNK_GAP_MS * words.length);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id, object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: words.join('') }, finish_reason: 'stop' }], usage }));
    }
    entry.done = Date.now();
  } finally {
    inFlight -= 1;
  }
}

const tlsOptions = { key: readFileSync(join(fixtures, 'localhost.key')), cert: readFileSync(join(fixtures, 'localhost.pem')), maxVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'] };
for (const host of ['127.0.0.1', '::1']) {
  https.createServer(tlsOptions, (req, res) => { answer(req, res).catch((error) => { console.error(error); res.destroy(); }); }).listen(port, host);
}
http.createServer((req, res) => {
  if (req.url === '/reset') { seen.length = 0; maxInFlight = 0; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ inFlight, maxInFlight, seen }));
}).listen(port + 1, '127.0.0.1', () => console.log(`mock upstream https://localhost:${port} stats http://127.0.0.1:${port + 1}/stats`));
