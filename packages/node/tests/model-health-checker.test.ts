import { describe, expect, it, vi } from 'vitest';
import {
  ModelHealthChecker,
  buildHealthProbeRequest,
  classifyProbeStatus,
  supportsHealthProbe,
  type ModelHealthEvent,
} from '../src/health/model-health-checker.js';
import type { Provider, ServiceHealthStatus, UpstreamAccountStatus } from '../src/interfaces/seller-provider.js';
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
    expect(supportsHealthProbe('venice-video')).toBe(false);
    expect(() => buildHealthProbeRequest('gpt-image-1', 'openai-images')).toThrow(
      'Health probes are not supported for openai-images services',
    );
  });
});

describe('ModelHealthChecker', () => {
  it('does not probe routing services as inference models even without unit pricing', async () => {
    const onRequest = vi.fn(async request => jsonResponse(request.requestId, 200));
    const provider = makeProvider({
      services: ['alpha-route', 'model-a'], onRequest,
      serviceApiProtocols: { 'alpha-route': ['irp-suggest'] },
    });
    const checker = new ModelHealthChecker({ targets: [{ provider }] });
    await checker.runSweep();
    expect(onRequest).toHaveBeenCalledOnce();
    expect(JSON.parse(new TextDecoder().decode(onRequest.mock.calls[0]![0].body)).model).toBe('model-a');
    expect(provider.services).toEqual(['alpha-route', 'model-a']);
  });
  it('quarantines initial auth failures and restores only models with successful probes', async () => {
    const provider = makeProvider({
      healthCheckAvailable: false,
      onRequest: statusSequence({ 'model-a': [200], 'model-b': [400, 200] }),
    });
    const onChange = vi.fn();
    const checker = new ModelHealthChecker({ targets: [{ provider }], onChange });
    expect(provider.services).toEqual([]);
    expect(checker.getSnapshot().every((s) => !s.advertised)).toBe(true);
    await checker.runSweep();
    expect(provider.services).toEqual(['model-a']);
    expect(provider.healthCheckAvailable).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    await checker.runSweep();
    expect(provider.services).toEqual(['model-a', 'model-b']);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('reports services withdrawn at initialization once, when it starts', async () => {
    const provider = makeProvider({ healthCheckAvailable: false, onRequest: statusSequence({ 'model-a': [500], 'model-b': [500] }) });
    const events: ModelHealthEvent[] = [];
    const checker = new ModelHealthChecker({ targets: [{ provider }], onChange: (event) => { events.push(event); } });
    expect(events).toEqual([]);
    checker.start();
    checker.stop();
    checker.start();
    checker.stop();
    expect(events.map((event) => [event.service, event.status])).toEqual([['model-a', 'removed'], ['model-b', 'removed']]);
  });

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

describe('ModelHealthChecker free media health checks', () => {
  type Results = Record<string, ServiceHealthStatus>;
  const next = <T>(answers: Array<T | Error>): T => {
    const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  function makeCheckedProvider(answers: Array<Results | Error>, accounts?: UpstreamAccountStatus[]) {
    const checkServiceHealth = vi.fn(async (_services: string[]): Promise<Results> => next(answers));
    const checkUpstreamAccount = accounts ? vi.fn(async (): Promise<UpstreamAccountStatus> => next(accounts)) : undefined;
    const handleRequest = vi.fn(async (req: SerializedHttpRequest) => jsonResponse(req.requestId, 200));
    const provider = makeProvider({
      name: 'venice-video',
      services: ['wan-2.5', 'kling-2'],
      serviceApiProtocols: { 'wan-2.5': ['venice-video'], 'kling-2': ['venice-video'] },
      checkServiceHealth,
      checkUpstreamAccount,
      handleRequest,
    });
    return { provider, checkServiceHealth, checkUpstreamAccount, handleRequest };
  }
  const both = (wan: ServiceHealthStatus, kling: ServiceHealthStatus = wan): Results => ({ 'wan-2.5': wan, 'kling-2': kling });
  const available = both({ status: 'available' });
  const funded = (balanceUsd?: number): UpstreamAccountStatus => ({ status: 'available', balanceUsd });
  const noCredits: UpstreamAccountStatus = { status: 'unavailable', reason: 'Venice balance $0.00 is at or below the $0 minimum' };

  it('calls the free check once per sweep with every media service and never sends a paid probe', async () => {
    const { provider, checkServiceHealth, checkUpstreamAccount, handleRequest } = makeCheckedProvider([available], [funded(5)]);
    const checker = new ModelHealthChecker({ targets: [{ provider }], failureThreshold: 1 });
    await checker.runSweep();
    expect(checkUpstreamAccount).toHaveBeenCalledTimes(1);
    expect(checkServiceHealth).toHaveBeenCalledTimes(1);
    expect(checkServiceHealth).toHaveBeenCalledWith(['wan-2.5', 'kling-2']);
    expect(handleRequest).not.toHaveBeenCalled();
    expect(provider.services).toEqual(['wan-2.5', 'kling-2']);
  });

  it('unadvertises every media model after repeated failed account checks and re-advertises once it passes', async () => {
    const { provider } = makeCheckedProvider([available], [noCredits, noCredits, noCredits, funded(20)]);
    const onChange = vi.fn();
    const checker = new ModelHealthChecker({ targets: [{ provider }], failureThreshold: 3, onChange });
    await checker.runSweep();
    await checker.runSweep();
    expect(provider.services).toEqual(['wan-2.5', 'kling-2']);
    await checker.runSweep();
    expect(provider.services).toEqual([]);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ service: 'wan-2.5', status: 'removed', detail: noCredits.reason }));

    await checker.runSweep();
    expect([...provider.services].sort()).toEqual(['kling-2', 'wan-2.5']);
    expect(provider.healthCheckAvailable).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ service: 'kling-2', status: 'restored' }));
  });

  it('hides only the model the provider no longer offers', async () => {
    const { provider } = makeCheckedProvider([both({ status: 'unavailable', reason: 'Venice no longer offers this model' }, { status: 'available' })], [funded(5)]);
    const checker = new ModelHealthChecker({ targets: [{ provider }], failureThreshold: 1 });
    await checker.runSweep();
    expect(provider.services).toEqual(['kling-2']);
  });

  it('treats unknown answers, missing answers, and failed checks as inconclusive', async () => {
    const { provider } = makeCheckedProvider([
      both({ status: 'unknown', reason: 'Venice account check returned HTTP 500' }),
      {},
      new Error('network down'),
    ]);
    const checker = new ModelHealthChecker({ targets: [{ provider }], failureThreshold: 1 });
    for (let i = 0; i < 3; i++) await checker.runSweep();
    expect(provider.services).toEqual(['wan-2.5', 'kling-2']);
    expect(checker.getSnapshot().every((s) => s.consecutiveFailures === 0)).toBe(true);
  });

  it('uses the account check alone when the provider has no model check', async () => {
    const { provider } = makeCheckedProvider([available], [noCredits]);
    const accountOnly = { ...provider, checkServiceHealth: undefined, services: provider.services };
    const checker = new ModelHealthChecker({ targets: [{ provider: accountOnly }], failureThreshold: 1 });
    await checker.runSweep();
    expect(accountOnly.services).toEqual([]);
  });

  it('uses the unwrapped probe provider for the free check', async () => {
    const { provider: inner, checkUpstreamAccount } = makeCheckedProvider([available], [noCredits]);
    const wrapper = { ...inner, checkServiceHealth: undefined, checkUpstreamAccount: undefined, services: inner.services };
    const checker = new ModelHealthChecker({ targets: [{ provider: wrapper, probeProvider: inner }], failureThreshold: 1 });
    await checker.runSweep();
    expect(checkUpstreamAccount).toHaveBeenCalledTimes(1);
    expect(wrapper.services).toEqual([]);
  });
});

describe('ModelHealthChecker with providers that share a name', () => {
  it('probes a withdrawn service only on its own provider and keeps its upstream error', async () => {
    // Two upstreams on the same plugin: each one's relay refuses the other's models.
    const allowedOnly = (allowed: string[], statuses: Record<string, number[]>): ProbeHandler => async (req) => {
      const body = JSON.parse(new TextDecoder().decode(req.body)) as { model: string };
      if (!allowed.includes(body.model)) return jsonResponse(req.requestId, 403, { error: `Service "${body.model}" is not in the allowed list` });
      return statusSequence(statuses)(req);
    };
    const upstreamA = makeProvider({ name: 'openai', services: ['model-a'], onRequest: allowedOnly(['model-a'], { 'model-a': [429, 429] }) });
    const upstreamB = makeProvider({ name: 'openai', services: ['model-b'], onRequest: allowedOnly(['model-b'], {}) });
    const checker = new ModelHealthChecker({ targets: [{ provider: upstreamA }, { provider: upstreamB }], failureThreshold: 2 });

    const probedOnB = vi.spyOn(upstreamB, 'handleRequest');
    await checker.runSweep();
    await checker.runSweep();
    expect(upstreamA.services).toEqual([]);
    // The withdrawn model keeps its real upstream error, not the other relay's refusal.
    expect(probedOnB.mock.calls.map(([req]) => JSON.parse(new TextDecoder().decode(req.body)).model)).not.toContain('model-a');
    const withdrawn = checker.getSnapshot().find((entry) => entry.service === 'model-a')!;
    expect(withdrawn).toMatchObject({ advertised: false, consecutiveFailures: 2, lastStatusCode: 429 });

    // The upstream recovers: one healthy probe on its own provider restores it,
    // and the other provider never probes it.
    await checker.runSweep();
    expect(upstreamA.services).toEqual(['model-a']);
    expect(upstreamB.services).toEqual(['model-b']);
    expect(checker.getSnapshot().every((entry) => entry.advertised && entry.consecutiveFailures === 0)).toBe(true);
  });
});

describe('upstream credit', () => {
  it('reports an out-of-credit upstream on its first 402, once, and funded when a probe answers again', async () => {
    const provider = makeProvider({ onRequest: statusSequence({ 'model-a': [402, 402], 'model-b': [402, 402] }) });
    const events: Array<{ status: string; providerId: string; services: string[] }> = [];
    const checker = new ModelHealthChecker({ targets: [{ provider, id: 'deepinfra' }], failureThreshold: 3, onUpstreamAccount: (event) => { events.push(event); } });
    await checker.runSweep();
    expect(events).toEqual([expect.objectContaining({ status: 'out_of_credit', providerId: 'deepinfra', services: ['model-a', 'model-b'] })]);
    expect(provider.services).toEqual(['model-a', 'model-b']);
    await checker.runSweep();
    expect(events).toHaveLength(1);
    await checker.runSweep();
    expect(events.map((event) => event.status)).toEqual(['out_of_credit', 'funded']);
  });

  it('reads billing errors from live requests and account checks, and warns under the low-balance line', async () => {
    let account: UpstreamAccountStatus = { status: 'available', balanceUsd: 40 };
    const provider = makeProvider({ services: ['image-a'], checkUpstreamAccount: async () => account, serviceApiProtocols: { 'image-a': ['venice-video'] } } as Partial<Provider>);
    const events: Array<{ status: string; balanceUsd: number | null }> = [];
    let line = 10;
    const checker = new ModelHealthChecker({ targets: [{ provider }], lowBalanceUsd: () => line, onUpstreamAccount: (event) => { events.push(event); } });
    await checker.runSweep();
    expect(events).toEqual([]);
    account = { status: 'available', balanceUsd: 4 };
    await checker.runSweep();
    expect(events.at(-1)).toMatchObject({ status: 'low_balance', balanceUsd: 4 });
    account = { status: 'unavailable', reason: 'Insufficient balance: top up your account' };
    await checker.runSweep();
    expect(events.at(-1)!.status).toBe('out_of_credit');
    line = 1;
    account = { status: 'available', balanceUsd: 4 };
    await checker.runSweep();
    expect(events.at(-1)!.status).toBe('funded');
    // A live 402 is reported without waiting for a probe; polling a video already paid for proves nothing; a billable success clears it.
    checker.reportUpstreamResponse(provider, 402, '{"error":{"message":"You need positive balance to do inference"}}');
    checker.reportUpstreamResponse(provider, 200, '', false);
    expect(events.at(-1)!.status).toBe('out_of_credit');
    checker.reportUpstreamResponse(provider, 200, '');
    expect(events.map((event) => event.status)).toEqual(['low_balance', 'out_of_credit', 'funded', 'out_of_credit', 'funded']);
  });
});

describe('isUpstreamOutOfCredit', () => {
  it('reads 402s and billing messages, not other failures', async () => {
    const { isUpstreamOutOfCredit } = await import('../src/health/upstream-credit.js');
    expect(isUpstreamOutOfCredit(402, '')).toBe(true);
    expect(isUpstreamOutOfCredit(400, 'You need positive balance to do inference. Please add balance manually or setup top-up')).toBe(true);
    expect(isUpstreamOutOfCredit(429, 'insufficient_quota: You exceeded your current quota')).toBe(true);
    expect(isUpstreamOutOfCredit(500, 'upstream connect error')).toBe(false);
    expect(isUpstreamOutOfCredit(429, 'Rate limit reached for requests')).toBe(false);
    expect(isUpstreamOutOfCredit(404, 'model not found')).toBe(false);
  });
});

describe('upstream credit classification in probes and requests', () => {
  it('reads an Anthropic credit 400 in a probe as out of credit, and tells each round it ended', async () => {
    const provider = makeProvider({
      services: ['model-a'],
      onRequest: async (req) => jsonResponse(req.requestId, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }),
    });
    const statuses: string[] = [];
    let rounds = 0;
    const checker = new ModelHealthChecker({ targets: [{ provider }], failureThreshold: 1, onUpstreamAccount: (event) => { statuses.push(event.status); }, onSweepComplete: () => { rounds += 1; } });
    await checker.runSweep();
    expect(statuses).toEqual(['out_of_credit']);
    expect(provider.services).toEqual([]);
    expect(rounds).toBe(1);
  });

  it('finds a billing code that follows a long error message in a probe', async () => {
    const provider = makeProvider({
      services: ['model-a'],
      onRequest: async (req) => jsonResponse(req.requestId, 429, { error: { message: `You exceeded your current quota. ${'Please review your plan and billing details. '.repeat(10)}`, type: 'insufficient_quota', code: 'insufficient_quota' } }),
    });
    const statuses: string[] = [];
    const checker = new ModelHealthChecker({ targets: [{ provider }], failureThreshold: 1, onUpstreamAccount: (event) => { statuses.push(event.status); } });
    await checker.runSweep();
    expect(statuses).toEqual(['out_of_credit']);
  });

  it('ignores rate limits and a buyer\'s echoed input, and takes a provider\'s own out-of-credit mark', async () => {
    const { isUpstreamOutOfCredit, isLiveResponseOutOfCredit } = await import('../src/health/upstream-credit.js');
    expect(isUpstreamOutOfCredit(429, '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED"}}')).toBe(false);
    expect(isUpstreamOutOfCredit(429, '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}')).toBe(true);
    expect(isLiveResponseOutOfCredit(400, "Invalid input: 'insufficient balance'")).toBe(false);
    expect(isLiveResponseOutOfCredit(403, 'Insufficient credits. Add more using https://openrouter.ai/settings/credits')).toBe(true);
    expect(isUpstreamOutOfCredit(500, 'desktop upload failed')).toBe(false);
    const provider = makeProvider({ services: ['image-a'], checkUpstreamAccount: async () => ({ status: 'unavailable', reason: 'fal balance $3.00 is at or below the $5 minimum', outOfCredit: true }), serviceApiProtocols: { 'image-a': ['venice-video'] } } as Partial<Provider>);
    const statuses: string[] = [];
    const checker = new ModelHealthChecker({ targets: [{ provider }], onUpstreamAccount: (event) => { statuses.push(event.status); } });
    await checker.runSweep();
    expect(statuses).toEqual(['out_of_credit']);
  });
  it('reads a $0 balance as out of credit, and an account check without a balance never clears it', async () => {
    const answers: UpstreamAccountStatus[] = [{ status: 'available', balanceUsd: 0 }, { status: 'available' }, { status: 'available', balanceUsd: 12 }];
    const provider = makeProvider({ services: ['image-a'], checkUpstreamAccount: async () => answers.shift()!, serviceApiProtocols: { 'image-a': ['venice-video'] } } as Partial<Provider>);
    const statuses: string[] = [];
    const checker = new ModelHealthChecker({ targets: [{ provider }], onUpstreamAccount: (event) => { statuses.push(event.status); } });
    await checker.runSweep();
    expect(statuses).toEqual(['out_of_credit']);
    await checker.runSweep();
    expect(statuses).toEqual(['out_of_credit']);
    await checker.runSweep();
    expect(statuses).toEqual(['out_of_credit', 'funded']);
  });
  it('never reads a 422 probe reply as the account running out', async () => {
    const provider = makeProvider({
      services: ['model-a'],
      onRequest: async (req) => jsonResponse(req.requestId, 422, { error: { message: 'max_tokens: insufficient funds limit must be a number' } }),
    });
    const statuses: string[] = [];
    const checker = new ModelHealthChecker({ targets: [{ provider }], failureThreshold: 1, onUpstreamAccount: (event) => { statuses.push(event.status); } });
    await checker.runSweep();
    expect(statuses).toEqual([]);
  });
});
