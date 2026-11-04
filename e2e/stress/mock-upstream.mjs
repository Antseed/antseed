// OpenAI-compatible mock upstream: chat completions, streaming SSE and JSON,
// random latency, realistic usage, optional fault injection.
import http from 'node:http';

const WORDS = 'the quick brown fox jumps over lazy dogs while seven agents argue about payment channels'.split(' ');

function rand(min, max) { return min + Math.random() * (max - min); }
function randInt(min, max) { return Math.floor(rand(min, max + 1)); }

function makeText(tokens) {
  // ~4 chars per token
  const parts = [];
  let len = 0;
  const target = tokens * 4;
  while (len < target) {
    const w = WORDS[(len * 7 + parts.length) % WORDS.length];
    parts.push(w);
    len += w.length + 1;
  }
  return parts.join(' ').slice(0, target);
}

/**
 * opts: { minLatencyMs, maxLatencyMs, minOut, maxOut, fault500Rate, disconnectRate,
 *         inPrice, outPrice } (prices in USD per 1M tokens; for expected-cost accounting)
 */
export function startMockUpstream(opts = {}) {
  const o = {
    minLatencyMs: 50, maxLatencyMs: 3000, minOut: 100, maxOut: 4000,
    fault500Rate: 0, disconnectRate: 0, inPrice: 3, outPrice: 15, ...opts,
  };
  const stats = {
    requests: 0, completed: 0, faults500: 0, disconnects: 0, clientGone: 0,
    expectedCostBaseUnits: 0n, // sum over fully delivered responses (with usage)
    perRequest: new Map(), // tag -> {status, cost, prompt, completion, stream}
    active: 0, maxActive: 0,
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => handle(req, res, body).catch((err) => {
      try { res.destroy(err); } catch {}
    }));
  });

  async function handle(req, res, raw) {
    if (/\/images\/generations$/.test(req.url.split('?')[0])) {
      stats.requests++;
      let parsed = {};
      try { parsed = JSON.parse(raw); } catch {}
      const prompt = String(parsed.prompt ?? '');
      const tagMatch = prompt.match(/\[req:([a-z0-9-]+)\]/i);
      const tag = tagMatch ? tagMatch[1] : `img-untagged-${stats.requests}`;
      const n = Math.max(1, Number(parsed.n ?? 1));
      await sleep(rand(o.minLatencyMs, o.maxLatencyMs));
      // 1x1 PNG
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const promptTokens = Math.max(1, Math.ceil(prompt.length / 4));
      const imgCost = BigInt(Math.round((o.imagePriceUsd ?? 0.04) * 1e6)) * BigInt(n);
      stats.imageRequests = (stats.imageRequests ?? 0) + 1;
      stats.images = (stats.images ?? 0) + n;
      stats.perRequest.set(tag, { status: 'ok', image: true, n, prompt: promptTokens, unitCost: imgCost.toString() });
      stats.expectedImageUnitCost = (stats.expectedImageUnitCost ?? 0n) + imgCost;
      stats.expectedCostBaseUnits += imgCost + BigInt(Math.round(promptTokens * o.inPrice));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ created: Math.floor(Date.now() / 1000), data: Array.from({ length: n }, () => ({ b64_json: png })), usage: { input_tokens: promptTokens, output_tokens: 0, total_tokens: promptTokens, input_tokens_details: { text_tokens: promptTokens, image_tokens: 0 } } }));
      stats.completed++;
      return;
    }
    if (!/\/chat\/completions$/.test(req.url.split('?')[0])) {
      if (req.url.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-upstream', object: 'model' }] }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    stats.requests++;
    stats.active++; stats.maxActive = Math.max(stats.maxActive, stats.active);
    let gone = false;
    res.on('close', () => { if (!res.writableEnded) gone = true; });
    try {
      let parsed = {};
      try { parsed = JSON.parse(raw); } catch {}
      const content = JSON.stringify(parsed.messages ?? '');
      const tagMatch = content.match(/\[req:([a-z0-9-]+)\]/i);
      const tag = tagMatch ? tagMatch[1] : `untagged-${stats.requests}`;
      // Health probes and tiny requests: small, fast.
      const isProbe = !tagMatch;
      const promptTokens = Math.max(1, Math.ceil(content.length / 4));
      const completionTokens = isProbe ? 1 : randInt(o.minOut, o.maxOut);
      const latency = isProbe ? 5 : rand(o.minLatencyMs, o.maxLatencyMs);
      const stream = parsed.stream === true;
      const cost = BigInt(Math.max(0, Math.round(promptTokens * o.inPrice + completionTokens * o.outPrice)));
      const rec = { status: 'pending', cost: cost.toString(), prompt: promptTokens, completion: completionTokens, stream };
      stats.perRequest.set(tag, rec);

      if (!isProbe && Math.random() < o.fault500Rate) {
        await sleep(latency / 3);
        stats.faults500++;
        rec.status = '500';
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock upstream internal error', type: 'server_error' } }));
        return;
      }
      const disconnect = !isProbe && Math.random() < o.disconnectRate;
      const text = makeText(completionTokens);
      const id = `chatcmpl-${tag}`;
      const created = Math.floor(Date.now() / 1000);
      const model = parsed.model ?? 'mock-upstream';
      const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };

      if (!stream) {
        await sleep(latency);
        if (gone) { stats.clientGone++; rec.status = 'client-gone'; return; }
        if (disconnect) { stats.disconnects++; rec.status = 'disconnect'; res.socket?.destroy(); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id, object: 'chat.completion', created, model,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage,
        }));
        stats.completed++; rec.status = 'ok';
        stats.expectedCostBaseUnits += cost;
        return;
      }

      // Streaming: first byte after ~20% of latency, then chunks over the rest.
      await sleep(latency * 0.2);
      if (gone) { stats.clientGone++; rec.status = 'client-gone'; return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const nChunks = Math.max(2, Math.min(40, Math.ceil(text.length / 400)));
      const step = Math.ceil(text.length / nChunks);
      const per = (latency * 0.8) / nChunks;
      const cutAt = disconnect ? randInt(1, nChunks - 1) : -1;
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);
      for (let i = 0; i < nChunks; i++) {
        if (gone) { stats.clientGone++; rec.status = 'client-gone'; return; }
        if (i === cutAt) { stats.disconnects++; rec.status = 'disconnect'; res.socket?.destroy(); return; }
        const piece = text.slice(i * step, (i + 1) * step);
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
        await sleep(per);
      }
      if (gone) { stats.clientGone++; rec.status = 'client-gone'; return; }
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      stats.completed++; rec.status = 'ok';
      stats.expectedCostBaseUnits += cost;
    } finally {
      stats.active--;
    }
  }

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        stats,
        setFaults(f) { Object.assign(o, f); },
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
