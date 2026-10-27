import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CaddyUnderscoreHeaders,
  findGatewayServer,
  hyphenTwin,
  normalizeUnderscoreHeaderNames,
} from './caddy-headers.js'

/** Caddy's `apps/http/servers` as install-gateway.sh's Caddyfile adapts it. */
function installerServers(port = 8379): Record<string, unknown> {
  return {
    srv0: {
      listen: [':443'],
      routes: [{
        match: [{ host: ['gateway.example.com'] }],
        handle: [{
          handler: 'subroute',
          routes: [{
            handle: [
              { handler: 'headers', response: { set: { 'Strict-Transport-Security': ['max-age=31536000'] } } },
              { handler: 'headers', request: { delete: ['X-Forwarded-For'] } },
              { handler: 'reverse_proxy', flush_interval: -1, upstreams: [{ dial: `127.0.0.1:${port}` }] },
            ],
          }],
        }],
        terminal: true,
      }],
    },
  }
}

/** A stand-in for Caddy's admin API: the server config, and every write it was sent. */
function fakeCaddy(servers: Record<string, unknown> = installerServers()) {
  const writes: Array<{ method: string; path: string; body: unknown }> = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
    const json = (value: unknown, status = 200) => new Response(value === undefined ? '' : JSON.stringify(value), { status })
    // Caddy refuses fetch's browser-like requests without an allowed Origin.
    if (new Headers(init?.headers).get('origin') !== 'http://127.0.0.1:2019') return json({ error: "client is not allowed to access from origin ''" }, 403)
    if (url.pathname === '/config/apps/http/servers') return json(servers)
    const match = /^\/config\/apps\/http\/servers\/([^/]+)\/expected_underscore_headers$/.exec(url.pathname)
    const server = match ? servers[decodeURIComponent(match[1]!)] as Record<string, unknown> | undefined : undefined
    if (!server) return json({ error: 'unknown path' }, 404)
    if (method === 'GET') return json(server['expected_underscore_headers'] ?? null)
    writes.push({ method, path: url.pathname, body })
    if (method === 'PUT') {
      if (server['expected_underscore_headers'] !== undefined) return json({ error: 'key already exists' }, 409)
      server['expected_underscore_headers'] = body
    } else if (method === 'PATCH') {
      server['expected_underscore_headers'] = body
    } else if (method === 'DELETE') {
      delete server['expected_underscore_headers']
    }
    return json(undefined)
  }) as typeof fetch
  return { servers, writes, fetch: fetchImpl }
}

test('underscore header names: lower-cased, de-duplicated, an underscore required', () => {
  assert.deepEqual(normalizeUnderscoreHeaderNames([' Session_ID ', 'session_id', 'x_custom_*', '']), ['session_id', 'x_custom_*'])
  assert.throws(() => normalizeUnderscoreHeaderNames(['session-id']), /no underscore/)
  assert.throws(() => normalizeUnderscoreHeaderNames(['a_b.c']), /not a header name/)
  assert.throws(() => normalizeUnderscoreHeaderNames(['a_*b']), /not a header name/)
  assert.throws(() => normalizeUnderscoreHeaderNames(Array.from({ length: 51 }, (_, i) => `h_${i}`)), /at most 50/)
  assert.equal(hyphenTwin('x_trace_id'), 'x-trace-id')
})

test('the Caddy server for the gateway is the one that proxies to its port', () => {
  assert.equal(findGatewayServer(installerServers(), 8379), 'srv0')
  assert.equal(findGatewayServer(installerServers(), 9000), null)
  assert.equal(findGatewayServer({ other: { routes: [{ handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '10.0.0.5:8379' }] }] }] } }, 8379), null)
  assert.equal(findGatewayServer(null, 8379), null)
})

test('a setting never made leaves Caddy alone', async () => {
  const caddy = fakeCaddy()
  const headers = new CaddyUnderscoreHeaders({ port: 8379, names: () => null, fetch: caddy.fetch })
  assert.equal((await headers.sync()).state, 'off')
  assert.deepEqual(caddy.writes, [])
})

test('the list is written into Caddy, replaced when it changes and removed when cleared', async () => {
  const caddy = fakeCaddy()
  let names: string[] = ['session_id']
  const headers = new CaddyUnderscoreHeaders({ port: 8379, names: () => names, fetch: caddy.fetch })

  assert.deepEqual(await headers.sync().then((s) => [s.state, s.server]), ['applied', 'srv0'])
  assert.deepEqual((caddy.servers['srv0'] as Record<string, unknown>)['expected_underscore_headers'], ['session_id'])

  // Already in place: nothing is written.
  await headers.sync()
  assert.equal(caddy.writes.length, 1)

  names = ['session_id', 'smith_id']
  await headers.sync()
  assert.equal(caddy.writes.at(-1)?.method, 'PATCH')
  assert.deepEqual((caddy.servers['srv0'] as Record<string, unknown>)['expected_underscore_headers'], ['session_id', 'smith_id'])

  names = []
  assert.equal((await headers.sync()).state, 'off')
  assert.equal(caddy.writes.at(-1)?.method, 'DELETE')
  assert.equal((caddy.servers['srv0'] as Record<string, unknown>)['expected_underscore_headers'], undefined)
})

test('a Caddy reload that dropped the list gets it back on the next check', async () => {
  const caddy = fakeCaddy()
  const headers = new CaddyUnderscoreHeaders({ port: 8379, names: () => ['session_id'], fetch: caddy.fetch })
  await headers.sync()
  delete (caddy.servers['srv0'] as Record<string, unknown>)['expected_underscore_headers']
  await headers.sync()
  assert.deepEqual(caddy.writes.map((w) => w.method), ['PUT', 'PUT'])
})

test('without a reachable Caddy, or a Caddy site for this gateway, the list is unavailable', async () => {
  const unreachable = new CaddyUnderscoreHeaders({
    port: 8379,
    names: () => ['session_id'],
    fetch: (async () => { throw new TypeError('fetch failed') }) as typeof fetch,
  })
  const status = await unreachable.sync()
  assert.equal(status.state, 'unavailable')
  assert.match(status.reason ?? '', /admin API is not reachable/)

  const elsewhere = new CaddyUnderscoreHeaders({ port: 9000, names: () => ['session_id'], fetch: fakeCaddy().fetch })
  assert.match((await elsewhere.sync()).reason ?? '', /no Caddy site forwards to port 9000/)
})
