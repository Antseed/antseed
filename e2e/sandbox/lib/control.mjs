import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { assertLocalUrl } from './env.mjs';
import { readJson } from './manifest.mjs';

export function newToken() {
  return randomBytes(24).toString('hex');
}

function tokenMatches(header, token) {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Loopback-only control API for the supervisor. Routes are "METHOD /path" keys; a ":id" segment
 * is passed to the handler as params.id. Every request needs the bearer token.
 */
export async function startControlServer({ token, routes, log = () => {} }) {
  const compiled = Object.entries(routes).map(([key, handler]) => {
    const [method, pattern] = key.split(' ');
    const regex = new RegExp(`^${pattern.replace(/:([a-z]+)/g, '(?<$1>[a-z0-9-]+)')}$`);
    return { method, regex, handler };
  });
  const server = createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body, (key, value) => (typeof value === 'bigint' ? value.toString() : value)));
    };
    if (!tokenMatches(request.headers.authorization, token)) return send(401, { ok: false, error: 'unauthorized' });
    const path = (request.url ?? '/').split('?')[0];
    const route = compiled.find((entry) => entry.method === request.method && entry.regex.test(path));
    if (!route) return send(404, { ok: false, error: `No control route ${request.method} ${path}` });
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? JSON.parse(text) : {};
      const result = await route.handler({ body, params: path.match(route.regex).groups ?? {} });
      send(200, { ok: true, ...result });
    } catch (error) {
      log(`control ${request.method} ${path} failed: ${error.message}`);
      send(error.statusCode ?? 500, { ok: false, error: error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export function controlClient({ url, token }) {
  assertLocalUrl(url, 'controlUrl');
  const call = async (method, path, body, timeoutMs = 120_000) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const value = await response.json();
    if (!response.ok || !value.ok) throw new Error(value.error ?? `Control ${method} ${path} failed with ${response.status}`);
    return value;
  };
  return {
    status: () => call('GET', '/status', undefined, 30_000),
    closeChannels: (sellerId) => call('POST', '/channels/close', sellerId ? { sellerId } : {}, 300_000),
    warp: (seconds) => call('POST', '/chain/warp', { seconds }),
    stopSeller: (id) => call('POST', `/sellers/${id}/stop`),
    startSeller: (id) => call('POST', `/sellers/${id}/start`, {}, 180_000),
    setMockLatency: (id, latencyMs) => call('POST', `/sellers/${id}/mock`, { latencyMs }),
    setMockProfile: (id, patch, { replace = false, resetDraws = false } = {}) => call('POST', `/sellers/${id}/mock`, { patch, replace, resetDraws }),
    resetMockDraws: (id) => call('POST', `/sellers/${id}/mock`, { resetDraws: true }),
    mockRequests: (id) => call('GET', `/sellers/${id}/mock`),
    seedRouter: (id, seed) => call('POST', `/routers/${id}/seed`, { seed }),
    routerStats: (id) => call('GET', `/routers/${id}`),
    shutdown: () => call('POST', '/shutdown', {}, 10_000),
  };
}

export async function loadControlClient(controlPath) {
  const control = await readJson(controlPath);
  if (!control?.url || !control?.token) throw new Error('Sandbox control endpoint is not available');
  return controlClient(control);
}
