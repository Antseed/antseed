// A local OpenAI-compatible upstream for the full-stack KBF round test. It answers like a
// deterministic model "world": question-writing prompts get facts whose value is printed in the
// fact name, and KBF answer prompts get that value back from the genuine model and a value outside
// the probe tolerance from every other model (contrast models and the impostor seller's upstream).
// It also serves an OpenRouter-style `/models` catalog and `/models/<id>/endpoints` prices.

import { createServer } from 'node:http';

/** Per canonical KBF domain: genuine values are drawn from [low, high]; `wrong` maps one to a value outside the probe tolerance. */
const DOMAIN_VALUES = {
  chemistry_bp: { low: 100, high: 300, wrong: (value) => value + 40 },
  chemistry_mp: { low: 200, high: 1200, wrong: (value) => value + 60 },
  physics: { low: 1000, high: 9000, wrong: (value) => Math.round(value * 1.5) },
  astronomy: { low: 1000, high: 9000, wrong: (value) => Math.round(value * 1.5) },
  biology: { low: 10, high: 400, wrong: (value) => value + 7 },
  math: { low: 100, high: 5000, wrong: (value) => value + 13 },
  programming: { low: 1960, high: 1995, wrong: (value) => value + 9 },
  medical: { low: 2, high: 200, wrong: (value) => Math.round(value * 1.6) + 1 },
  pop_culture: { low: 100, high: 5000, wrong: (value) => value + 17 },
  internet_culture: { low: 1990, high: 2005, wrong: (value) => value + 11 },
  chinese_history: { low: 100, high: 1500, wrong: (value) => value + 23 },
  chinese_geography: { low: 1000, high: 90000, wrong: (value) => Math.round(value * 1.5) },
  chinese_internet: { low: 1995, high: 2010, wrong: (value) => value + 9 },
  chinese_literature: { low: 100, high: 1500, wrong: (value) => value + 19 },
  crypto_params: { low: 16, high: 4096, wrong: (value) => value + 8 },
};
const FALLBACK_VALUES = { low: 100, high: 900, wrong: (value) => value + 50 };
const VALUE_MARK = /\[k(-?\d+)\]/;
const LINE_LABEL = /^(\(\d+\)|\d+\.|\d+\)|Q\d+:)\s+(.*)$/;

function hashInt(text) {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.codePointAt(0), 16777619) >>> 0;
  return hash;
}

function domainOf(text) {
  for (const key of Object.keys(DOMAIN_VALUES)) if (text.includes(key)) return key;
  return null;
}

function userText(body) {
  return (Array.isArray(body.messages) ? body.messages : [])
    .filter((message) => message.role === 'user')
    .map((message) => (typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content) ? message.content.map((part) => part?.text ?? '').join('') : ''))
    .join('\n');
}

function writeFacts(prompt) {
  const match = /Generate exactly (\d+) facts in canonical KBF domain (\S+) for generation round (\d+), batch (\d+)\./.exec(prompt);
  if (!match) return null;
  const [, count, domain, round, batch] = match;
  const values = DOMAIN_VALUES[domain] ?? FALLBACK_VALUES;
  const lines = [];
  for (let index = 1; index <= Number(count); index++) {
    const name = `${domain} sim item r${round}b${batch}n${index}`;
    const value = values.low + (hashInt(name) % (values.high - values.low + 1));
    lines.push(`${name} [k${value}] | ${value}`);
  }
  return lines.join('\n');
}

function answerProbes(prompt, genuine) {
  const lines = [];
  for (const raw of prompt.split('\n')) {
    const line = LINE_LABEL.exec(raw.trim());
    if (!line) continue;
    // Questions the stub wrote carry their value; any other question gets a stable made-up one.
    const mark = VALUE_MARK.exec(line[2]);
    const values = DOMAIN_VALUES[domainOf(line[2])] ?? FALLBACK_VALUES;
    const value = mark ? Number(mark[1]) : values.low + (hashInt(line[2]) % (values.high - values.low + 1));
    lines.push(`${line[1]} ${genuine ? value : values.wrong(value)}`);
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

export function stubCompletionText(body, genuineModels) {
  const prompt = userText(body);
  const facts = writeFacts(prompt);
  if (facts !== null) return facts;
  return answerProbes(prompt, genuineModels.has(String(body.model ?? '').trim().toLowerCase())) ?? '1';
}

/**
 * Starts the stub. `catalog` lists `{ id, inputUsdPerMillion, outputUsdPerMillion, intelligence? }`.
 * Requests are counted per model in `stats`.
 */
export async function startStubUpstream({ genuineModels, catalog, port = 0 }) {
  const genuine = new Set(genuineModels.map((model) => model.toLowerCase()));
  const stats = { completions: new Map(), failures: 0 };
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      try {
        const url = new URL(request.url ?? '/', 'http://stub');
        const path = url.pathname.replace(/\/+$/, '');
        if (request.method === 'GET' && path.endsWith('/models')) {
          return json(response, 200, {
            data: catalog.map((model) => ({
              id: model.id,
              pricing: { prompt: String(model.inputUsdPerMillion / 1e6), completion: String(model.outputUsdPerMillion / 1e6) },
              ...(model.intelligence !== undefined ? { benchmarks: { artificial_analysis: { intelligence_index: model.intelligence } } } : {}),
            })),
          });
        }
        const endpoints = /\/models\/(.+)\/endpoints$/.exec(path);
        if (request.method === 'GET' && endpoints) {
          const model = catalog.find((entry) => entry.id === decodeURIComponent(endpoints[1]));
          if (!model) return json(response, 404, { error: { message: 'not found' } });
          return json(response, 200, {
            data: { id: model.id, endpoints: [{ provider_name: 'Stub', tag: 'stub', pricing: { prompt: String(model.inputUsdPerMillion / 1e6), completion: String(model.outputUsdPerMillion / 1e6) } }] },
          });
        }
        if (request.method === 'POST' && path.endsWith('/chat/completions')) {
          const body = JSON.parse(raw || '{}');
          const model = String(body.model ?? '');
          stats.completions.set(model, (stats.completions.get(model) ?? 0) + 1);
          const text = stubCompletionText(body, genuine);
          const usage = { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: Math.ceil(text.length / 4) + 1 };
          usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
          const id = `chatcmpl-stub-${hashInt(raw + Date.now()).toString(16)}`;
          if (body.stream) {
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            const chunk = (delta, finish, extra = {}) => response.write(`data: ${JSON.stringify({
              id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, provider: 'Stub',
              choices: [{ index: 0, delta, finish_reason: finish }], ...extra,
            })}\n\n`);
            chunk({ role: 'assistant', content: text }, null);
            chunk({}, 'stop', { usage });
            response.end('data: [DONE]\n\n');
            return undefined;
          }
          return json(response, 200, {
            id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, provider: 'Stub',
            choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
            usage,
          });
        }
        return json(response, 404, { error: { message: `no route ${request.method} ${path}` } });
      } catch (error) {
        stats.failures += 1;
        return json(response, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
      }
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stats,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}
