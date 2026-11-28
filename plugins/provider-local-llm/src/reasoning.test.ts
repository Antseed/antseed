import { afterEach, describe, expect, it, vi } from 'vitest';
import plugin from './index.js';
import { llamaCppReasoning, ollamaReasoning } from './reasoning.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const notFound = () => new Response('404 page not found', { status: 404 });

/** Answers `/props` and `/api/show` by path; anything else is a 404. */
function mockServer(routes: { props?: (url: URL) => Response | Promise<Response>; show?: (model: string) => Response | Promise<Response> }) {
  const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname === '/props' && routes.props) return routes.props(url);
    if (url.pathname === '/api/show' && routes.show) return routes.show((JSON.parse(String(init?.body)) as { model: string }).model);
    return notFound();
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function startedProvider(config: Record<string, string>) {
  const provider = await plugin.createProvider({ LOCAL_LLM_BASE_URL: 'http://localhost:11434', ...config });
  await provider.init?.();
  return provider;
}

// Ollama `/api/show` and llama.cpp `/props` shapes; model names are placeholders.
const ollamaShow = { capabilities: ['completion', 'thinking'], thinking: { values: ['low', 'medium', 'high'], default: 'medium' } };
const llamaProps = {
  model_path: '../models/example.gguf',
  chat_template_caps: { reasoning_effort_levels: ['none', 'low', 'medium', 'high', 'xhigh'], reasoning_effort_rejected: ['xhigh'] },
};

describe('reasoning efforts from Ollama', () => {
  it('fills the list from /api/show', async () => {
    const fetchMock = mockServer({ show: (model) => (model === 'example-model:20b' ? json(ollamaShow) : notFound()) });
    const provider = await startedProvider({
      ANTSEED_ALLOWED_SERVICES: 'example',
      ANTSEED_SERVICE_ALIAS_MAP_JSON: '{"example":"example-model:20b"}',
    });
    expect(provider.serviceCapabilities?.example).toEqual({ reasoning: true, reasoningEfforts: ['low', 'medium', 'high'] });
    const show = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/show')) as [string, RequestInit];
    expect(show[1].method).toBe('POST');
    expect(show[1].redirect).toBe('error');
  });

  it('fills nothing for an on/off model, a model that cannot think, or one without thinking metadata', async () => {
    mockServer({
      show: (model) => json(model === 'onoff'
        ? { thinking: { values: [true, false], default: false } }
        : model === 'plain' ? { thinking: { values: [false], default: false } } : { capabilities: ['completion'] }),
    });
    const provider = await startedProvider({ ANTSEED_ALLOWED_SERVICES: 'onoff,plain,legacy' });
    expect(provider.serviceCapabilities?.onoff).toBeUndefined();
    expect(provider.serviceCapabilities?.plain).toBeUndefined();
    expect(provider.serviceCapabilities?.legacy).toBeUndefined();
  });

  it('keeps what the seller configured and never fills reasoning false', async () => {
    mockServer({ show: () => json(ollamaShow) });
    const provider = await startedProvider({
      ANTSEED_ALLOWED_SERVICES: 'own,off,empty',
      ANTSEED_SERVICE_CAPABILITIES_JSON: JSON.stringify({
        own: { reasoningEfforts: ['high'] },
        off: { reasoning: false },
        empty: { reasoningEfforts: [] },
      }),
    });
    expect(provider.serviceCapabilities?.own).toEqual({ reasoningEfforts: ['high'] });
    expect(provider.serviceCapabilities?.off).toEqual({ reasoning: false });
    expect(provider.serviceCapabilities?.empty).toEqual({ reasoningEfforts: [] });
  });

  it('drops a list with an invalid label, whole', async () => {
    mockServer({ show: () => json({ thinking: { values: ['low', 'very high', 3] } }) });
    const provider = await startedProvider({ ANTSEED_ALLOWED_SERVICES: 'bad-list' });
    expect(provider.serviceCapabilities?.['bad-list']).toBeUndefined();
  });
});

describe('reasoning efforts from llama.cpp', () => {
  it('fills the levels the template accepts and asks for the model without loading it', async () => {
    const fetchMock = mockServer({ props: () => json(llamaProps) });
    const provider = await startedProvider({ LOCAL_LLM_BASE_URL: 'http://127.0.0.1:8080/', ANTSEED_ALLOWED_SERVICES: 'example' });
    expect(provider.serviceCapabilities?.example).toEqual({ reasoning: true, reasoningEfforts: ['none', 'low', 'medium', 'high'] });
    const props = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(props.origin + props.pathname).toBe('http://127.0.0.1:8080/props');
    expect(props.searchParams.get('model')).toBe('example');
    expect(props.searchParams.get('autoload')).toBe('false');
    // Recognised from the first answer: Ollama's endpoint is not tried.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fills nothing from a template without levels', async () => {
    mockServer({ props: () => json({ chat_template_caps: {} }) });
    const provider = await startedProvider({ ANTSEED_ALLOWED_SERVICES: 'example' });
    expect(provider.serviceCapabilities?.example).toBeUndefined();
  });

  it('sends the key the relay uses', async () => {
    const fetchMock = mockServer({ props: () => json(llamaProps) });
    await startedProvider({ ANTSEED_ALLOWED_SERVICES: 'example', LOCAL_LLM_API_KEY: 'local-key' });
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toEqual({ authorization: 'Bearer local-key' });
  });
});

describe('a local server that does not answer', () => {
  it('leaves capabilities unchanged and starts when both endpoints fail, are too large or time out', async () => {
    const answers: Array<() => Response | Promise<Response>> = [
      () => json({ error: 'boom' }, 500),
      () => new Response(new Uint8Array(4 * 1024 * 1024 + 1).fill(0x20)),
      () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')),
      () => Promise.reject(new TypeError('fetch failed')),
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const answer of answers) {
        warn.mockClear();
        mockServer({ props: answer, show: answer });
        const provider = await startedProvider({
          ANTSEED_ALLOWED_SERVICES: 'example,second',
          ANTSEED_SERVICE_CAPABILITIES_JSON: '{"example":{"contextWindow":32000}}',
          LOCAL_LLM_API_KEY: 'local-key',
        });
        expect(provider.serviceCapabilities?.example).toEqual({ contextWindow: 32000 });
        // One line for the server however many models failed, with host and path only.
        const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('reasoning efforts:'));
        expect(lines).toEqual(['reasoning efforts: could not read localhost:11434/props or localhost:11434/api/show; announcing no list']);
        expect(lines[0]).not.toContain('local-key');
      }
    } finally {
      warn.mockRestore();
    }
  });

  it('logs nothing when the server answers without levels', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockServer({ show: () => json({ capabilities: ['completion'] }) });
      await startedProvider({ ANTSEED_ALLOWED_SERVICES: 'example' });
      expect(warn.mock.calls.filter((call) => String(call[0]).startsWith('reasoning efforts:'))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('parses only the documented shapes', () => {
    expect(ollamaReasoning(null)).toBeNull();
    expect(ollamaReasoning({ thinking: { values: 'low' } })).toBeNull();
    expect(llamaCppReasoning({ chat_template_caps: { reasoning_effort_levels: 'low' } })).toBeNull();
    expect(llamaCppReasoning({ default_generation_settings: {} })).toBeNull();
  });
});
