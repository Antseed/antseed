import { describe, expect, it, vi } from 'vitest';
import {
  ModelHealthChecker,
  buildHealthProbeRequest,
  classifyProbeStatus,
  supportsHealthProbe,
  type ModelHealthEvent,
} from '../src/health/model-health-checker.js';
import type { Provider } from '../src/interfaces/seller-provider.js';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../src/types/http.js';

type ProbeHandler = (req: SerializedHttpRequest) => Promise<SerializedHttpResponse>;

function jsonResponse(requestId: string, statusCode: number, body: unknown = {}): SerializedHttpResponse {
  return {
    requestId,
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
}

function makeProvider(overrides: Partial<Provider> & { onRequest?: ProbeHandler } = {}): Provider {
  const { onRequest, ...rest } = overrides;
  return {
    name: 'test-provider',
    services: ['model-a', 'model-b'],
    pricing: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } },
    maxConcurrency: 4,
    handleRequest: onRequest ?? (async (req) => jsonResponse(req.requestId, 200)),
    getCapacity: () => ({ current: 0, max: 4 }),
    ...rest,
  };
}

function statusSequence(statuses: Record<string, number[]>): ProbeHandler {
  return async (req) => {
    const body = JSON.parse(new TextDecoder().decode(req.body)) as { model: string };
    const queue = statuses[body.model];
    const status = queue && queue.length > 0 ? queue.shift()! : 200;
    return jsonResponse(req.requestId, status);
  };
}

describe('classifyProbeStatus', () => {
  it('maps status codes to outcomes', () => {
    expect(classifyProbeStatus(200)).toBe('healthy');
    expect(classifyProbeStatus(304)).toBe('healthy');
    expect(classifyProbeStatus(401)).toBe('unhealthy');
    expect(classifyProbeStatus(402)).toBe('unhealthy');
    expect(classifyProbeStatus(403)).toBe('unhealthy');
    expect(classifyProbeStatus(404)).toBe('unhealthy');
    expect(classifyProbeStatus(500)).toBe('unhealthy');
    expect(classifyProbeStatus(502)).toBe('unhealthy');
    expect(classifyProbeStatus(429)).toBe('unhealthy');
    // Endpoint alive but probe rejected — must never unadvertise over these.
    expect(classifyProbeStatus(400)).toBe('inconclusive');
    expect(classifyProbeStatus(422)).toBe('inconclusive');
  });
});

describe('buildHealthProbeRequest', () => {
  it('builds a 1-token anthropic-messages probe', () => {
    const req = buildHealthProbeRequest('claude-x', 'anthropic-messages');
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/v1/messages');
    const body = JSON.parse(new TextDecoder().decode(req.body));
    expect(body).toMatchObject({ model: 'claude-x', max_tokens: 1 });
  });

  it('builds an openai-chat-completions probe by default shape', () => {
    const req = buildHealthProbeRequest('gpt-x', 'openai-chat-completions');
    expect(req.path).toBe('/v1/chat/completions');
    const body = JSON.parse(new TextDecoder().decode(req.body));
    expect(body).toMatchObject({ model: 'gpt-x', max_tokens: 1 });
  });

  it('builds a canonical responses message-list probe', () => {
    const req = buildHealthProbeRequest('codex-x', 'openai-responses');
    expect(req.path).toBe('/v1/responses');
    const body = JSON.parse(new TextDecoder().decode(req.body));
    expect(body).toEqual({
      model: 'codex-x',
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'ping' }],
      }],
      max_output_tokens: 16,
    });
  });

  it('builds a single-question systemone probe', () => {
    expect(supportsHealthProbe('typesafe-systemone')).toBe(true);
    const req = buildHealthProbeRequest('jev-latest', 'typesafe-systemone');
    expect(req.path).toBe('/v1/systemone');
    const body = JSON.parse(new TextDecoder().decode(req.body));
    expect(body).toEqual({
      model: 'jev-latest',
      state: 'ping',
      questions: { ok: { type: 'noul', instructions: 'Is the state the word ping?' } },
    });
  });

  it('does not fall back to a chat probe for image services', () => {
    expect(supportsHealthProbe('openai-images')).toBe(false);
    expect(supportsHealthProbe('seedance-video')).toBe(false);
    expect(supportsHealthProbe('veo-video')).toBe(false);
    expect(supportsHealthProbe('seedance-video')).toBe(false);
    expect(() => buildHealthProbeRequest('gpt-image-1', 'openai-images')).toThrow(
      'Health probes are not supported for openai-images services',
    );
  });
});

describe('ModelHealthChecker', () => {
  it('unadvertises a service after the failure threshold and emits an event', async () => {
    const provider = makeProvider({
      onRequest: statusSequence({ 'model-a': [500, 500, 500], 'model-b': [200, 200, 200] }),
    });
    const events: ModelHealthEvent[] = [];
    const checker = new ModelHealthChecker({
      targets: [{ provider }],
      failureThreshold: 3,
      onChange: (event) => { events.push(event); },
    });

    await checker.runSweep();
    await checker.runSweep();
    expect(provider.services).toContain('model-a');

    await checker.runSweep();
    expect(provider.services).toEqual(['model-b']);
    expect(events).toEqual([
      expect.objectContaining({ provider: 'test-provider', service: 'model-a', status: 'removed', consecutiveFailures: 3 }),
    ]);
  });

  it('keeps probing a removed service and restores it at its original position on recovery', async () => {
    const provider = makeProvider({
      onRequest: statusSequence({ 'model-a': [502, 502, 200] }),
    });
    const events: ModelHealthEvent[] = [];
    const checker = new ModelHealthChecker({
      targets: [{ provider }],
      failureThreshold: 2,
      onChange: (event) => { events.push(event); },
    });

    await checker.runSweep();
    await checker.runSweep();
    expect(provider.services).toEqual(['model-b']);

    await checker.runSweep();
    expect(provider.services).toEqual(['model-a', 'model-b']);
    expect(events.map((e) => e.status)).toEqual(['removed', 'restored']);
  });

  it('resets the failure streak on a healthy probe', async () => {
    const provider = makeProvider({
      onRequest: statusSequence({ 'model-a': [500, 500, 200, 500, 500] }),
    });
    const checker = new ModelHealthChecker({ targets: [{ provider }], failureThreshold: 3 });

    for (let i = 0; i < 5; i += 1) {
      await checker.runSweep();
    }
    expect(provider.services).toContain('model-a');
  });

  it('does not count inconclusive probes (400, 422) as failures', async () => {
    const provider = makeProvider({
      onRequest: statusSequence({ 'model-a': [400, 422, 400, 422, 400] }),
    });
    const checker = new ModelHealthChecker({ targets: [{ provider }], failureThreshold: 2 });

    for (let i = 0; i < 5; i += 1) {
      await checker.runSweep();
    }
    expect(provider.services).toEqual(['model-a', 'model-b']);
  });

  it('unadvertises after three 429 responses and restores after a 200', async () => {
    const provider = makeProvider({
      onRequest: statusSequence({
        'model-a': [429, 429, 429, 200],
        'model-b': [200, 200, 200, 200],
      }),
    });
    const checker = new ModelHealthChecker({ targets: [{ provider }], failureThreshold: 3 });

    await checker.runSweep();
    await checker.runSweep();
    expect(provider.services).toEqual(['model-a', 'model-b']);

    await checker.runSweep();
    expect(provider.services).toEqual(['model-b']);

    await checker.runSweep();
    expect(provider.services).toEqual(['model-a', 'model-b']);
  });

  it('removes the final service, marks the provider unavailable, and restores both', async () => {
    const provider = makeProvider({
      services: ['only-model'],
      onRequest: statusSequence({ 'only-model': [402, 200] }),
    });
    const events: ModelHealthEvent[] = [];
    const checker = new ModelHealthChecker({
      targets: [{ provider }],
      failureThreshold: 1,
      onChange: (event) => { events.push(event); },
    });

    await checker.runSweep();
    expect(provider.services).toEqual([]);
    expect(provider.healthCheckAvailable).toBe(false);

    await checker.runSweep();
    expect(provider.services).toEqual(['only-model']);
    expect(provider.healthCheckAvailable).toBe(true);
    expect(events.map((event) => event.status)).toEqual(['removed', 'restored']);
  });

  it('removes every service when the whole upstream is unavailable', async () => {
    const provider = makeProvider({
      onRequest: async (req) => jsonResponse(req.requestId, 402),
    });
    const checker = new ModelHealthChecker({
      targets: [{ provider }],
      failureThreshold: 1,
    });

    await checker.runSweep();
    expect(provider.services).toEqual([]);
    expect(provider.healthCheckAvailable).toBe(false);
    expect(checker.getSnapshot()).toEqual([
      expect.objectContaining({ service: 'model-a', advertised: false, lastStatusCode: 402 }),
      expect.objectContaining({ service: 'model-b', advertised: false, lastStatusCode: 402 }),
    ]);
  });

  it('treats a thrown probe as unhealthy', async () => {
    const provider = makeProvider({
      onRequest: async (req) => {
        const body = JSON.parse(new TextDecoder().decode(req.body)) as { model: string };
        if (body.model === 'model-a') throw new Error('socket hang up');
        return jsonResponse(req.requestId, 200);
      },
    });
    const checker = new ModelHealthChecker({ targets: [{ provider }], failureThreshold: 2 });

    await checker.runSweep();
    await checker.runSweep();
    expect(provider.services).toEqual(['model-b']);
  });

  it('treats a hanging probe as unhealthy via the probe timeout', async () => {
    const provider = makeProvider({
      onRequest: (req) => {
        const body = JSON.parse(new TextDecoder().decode(req.body)) as { model: string };
        if (body.model === 'model-a') return new Promise<never>(() => {});
        return Promise.resolve(jsonResponse(req.requestId, 200));
      },
    });
    const checker = new ModelHealthChecker({
      targets: [{ provider }],
      failureThreshold: 1,
      probeTimeoutMs: 20,
    });

    await checker.runSweep();
    expect(provider.services).toEqual(['model-b']);
  });

  it('skips providers that are at capacity without counting failures', async () => {
    const handleRequest = vi.fn(async (req: SerializedHttpRequest) => jsonResponse(req.requestId, 500));
    const provider = makeProvider({
      onRequest: handleRequest,
      getCapacity: () => ({ current: 4, max: 4 }),
    });
    const checker = new ModelHealthChecker({ targets: [{ provider }], failureThreshold: 1 });

    await checker.runSweep();
    expect(handleRequest).not.toHaveBeenCalled();
    expect(provider.services).toEqual(['model-a', 'model-b']);
  });

  it('probes through the probeProvider when supplied, but mutates the advertised provider services', async () => {
    const services = ['model-a', 'model-b'];
    const advertised = makeProvider({
      services,
      onRequest: async () => { throw new Error('advertised provider must not be probed'); },
    });
    const probeProvider = makeProvider({
      services,
      onRequest: statusSequence({ 'model-a': [500], 'model-b': [200] }),
    });
    const checker = new ModelHealthChecker({
      targets: [{ provider: advertised, probeProvider }],
      failureThreshold: 1,
    });

    await checker.runSweep();
    expect(advertised.services).toEqual(['model-b']);
  });

  it('picks the probe shape from the service API protocol', async () => {
    const paths: string[] = [];
    const provider = makeProvider({
      services: ['claude-x', 'gpt-x'],
      serviceApiProtocols: {
        'claude-x': ['anthropic-messages'],
        'gpt-x': ['openai-chat-completions'],
      },
      onRequest: async (req) => {
        paths.push(req.path);
        return jsonResponse(req.requestId, 200);
      },
    });
    const checker = new ModelHealthChecker({ targets: [{ provider }] });

    await checker.runSweep();
    expect(paths.sort()).toEqual(['/v1/chat/completions', '/v1/messages']);
  });

  it('skips image services without calling the provider or changing availability', async () => {
    const handleRequest = vi.fn(async (req: SerializedHttpRequest) => jsonResponse(req.requestId, 500));
    const provider = makeProvider({
      services: ['gpt-image-1'],
      serviceApiProtocols: { 'gpt-image-1': ['openai-images'] },
      onRequest: handleRequest,
    });
    const checker = new ModelHealthChecker({ targets: [{ provider }], failureThreshold: 1 });

    await checker.runSweep();

    expect(handleRequest).not.toHaveBeenCalled();
    expect(provider.services).toEqual(['gpt-image-1']);
    expect(checker.getSnapshot()).toEqual([
      expect.objectContaining({
        service: 'gpt-image-1',
        advertised: true,
        consecutiveFailures: 0,
        lastStatusCode: null,
        lastDetail: 'Skipped health probe for unsupported protocol openai-images',
      }),
    ]);
  });

  it('reports state via getSnapshot', async () => {
    const provider = makeProvider({
      onRequest: statusSequence({ 'model-a': [500], 'model-b': [200] }),
    });
    const checker = new ModelHealthChecker({ targets: [{ provider }], failureThreshold: 2 });

    await checker.runSweep();
    const snapshot = checker.getSnapshot();
    const a = snapshot.find((s) => s.service === 'model-a');
    const b = snapshot.find((s) => s.service === 'model-b');
    expect(a).toMatchObject({ advertised: true, consecutiveFailures: 1, lastStatusCode: 500 });
    expect(b).toMatchObject({ advertised: true, consecutiveFailures: 0, lastStatusCode: 200 });
  });
});
