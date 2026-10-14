import { describe, expect, it, vi } from 'vitest'
import { buildQuery, ConsoleApiError, createApiClient, CSRF_HEADER, errorMessage, isApiError } from './client'

function fakeFetch(response: Response) {
  return vi.fn(async (_input: string, _init?: RequestInit) => response)
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('console API client', () => {
  it('sends GETs without the CSRF header, with same-origin credentials', async () => {
    const fetch = fakeFetch(json(200, []))
    await createApiClient(fetch).keys.list({ workspace: 'ws_1' })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('/console/api/keys?workspace=ws_1')
    expect(init?.method).toBe('GET')
    expect(init?.credentials).toBe('same-origin')
    expect((init?.headers as Record<string, string>)[CSRF_HEADER]).toBeUndefined()
  })

  it('sends the CSRF header and a JSON body on mutations', async () => {
    const fetch = fakeFetch(json(200, { id: 'key_1' }))
    await createApiClient(fetch).keys.update('key/1', { label: 'New' })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('/console/api/keys/key%2F1')
    expect(init?.method).toBe('PATCH')
    const headers = init?.headers as Record<string, string>
    expect(headers[CSRF_HEADER]).toBe('1')
    expect(headers['content-type']).toBe('application/json')
    expect(JSON.parse(String(init?.body))).toEqual({ label: 'New' })
  })

  it('adds the CSRF header to DELETE without a body', async () => {
    const fetch = fakeFetch(new Response(null, { status: 204 }))
    const result = await createApiClient(fetch).invites.revoke('inv_1')
    const [, init] = fetch.mock.calls[0]!
    expect(init?.method).toBe('DELETE')
    expect((init?.headers as Record<string, string>)[CSRF_HEADER]).toBe('1')
    expect(init?.body).toBeUndefined()
    expect(result).toBeUndefined()
  })

  it('calls the authorized-wallet routes through typed wallet methods', async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => json(200, { buyer: '0xb', operator: null }))
    const client = createApiClient(fetch)
    await client.wallet.operator('ws/1')
    await client.wallet.operator('ws/1', true)
    await client.wallet.operatorSync('ws/1', '0xabc')
    await client.wallet.operatorSync('ws/1')
    await client.wallet.operatorAuth('ws/1', '0xop')
    const calls = fetch.mock.calls.map(([url, init]) => [init?.method, url, init?.body ? JSON.parse(String(init.body)) : undefined])
    expect(calls).toEqual([
      ['GET', '/console/api/workspaces/ws%2F1/wallet/operator', undefined],
      ['GET', '/console/api/workspaces/ws%2F1/wallet/operator?fresh=1', undefined],
      ['POST', '/console/api/workspaces/ws%2F1/wallet/operator/sync', { txHash: '0xabc' }],
      ['POST', '/console/api/workspaces/ws%2F1/wallet/operator/sync', {}],
      ['POST', '/console/api/workspaces/ws%2F1/wallet/operator-auth', { operator: '0xop' }],
    ])
  })

  it('turns `{ error: { code, message } }` into a typed error', async () => {
    const fetch = fakeFetch(json(403, { error: { code: 'model_not_allowed', message: 'Nope' } }))
    const error = await createApiClient(fetch).auth.me().catch((cause) => cause)
    expect(error).toBeInstanceOf(ConsoleApiError)
    expect(error).toMatchObject({ status: 403, code: 'model_not_allowed', message: 'Nope' })
    expect(isApiError(error, 'model_not_allowed')).toBe(true)
    expect(isApiError(error, 'other')).toBe(false)
  })

  it('falls back to http_<status> for non-JSON errors', async () => {
    const fetch = fakeFetch(new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }))
    const error = await createApiClient(fetch).settings.status().catch((cause) => cause)
    expect(error).toMatchObject({ status: 502, code: 'http_502', message: 'Bad Gateway' })
  })

  it('reports network failures as network_error', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    const error = await createApiClient(fetch).auth.config().catch((cause) => cause)
    expect(error).toMatchObject({ status: 0, code: 'network_error' })
  })

  it('builds query strings without empty values', () => {
    expect(buildQuery({ a: 'x', b: undefined, c: null, d: '', e: 0, f: false })).toBe('?a=x&e=0&f=false')
    expect(buildQuery({})).toBe('')
    expect(buildQuery(undefined)).toBe('')
  })

  it('builds export and OIDC URLs on the API base', () => {
    const client = createApiClient(fakeFetch(json(200, {})))
    expect(client.usage.exportUrl({ workspace: 'ws 1', groupBy: 'model' })).toBe('/console/api/usage/export.csv?workspace=ws+1&groupBy=model')
    expect(client.auth.oidcStartUrl('enr_1')).toBe('/console/api/auth/oidc/start?enrollment=enr_1')
    expect(client.auth.oidcStartUrl()).toBe('/console/api/auth/oidc/start')
  })

  it('passes opaque cursors and the new log filters through unchanged', async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => json(200, { requests: [], nextBefore: null }))
    const client = createApiClient(fetch)
    await client.usage.requests({ workspace: 'ws_1', q: 'timeout', from: 1, to: 2, before: 'b3BhcXVl:x', limit: 50 })
    expect(fetch.mock.calls[0]![0]).toBe('/console/api/requests?workspace=ws_1&q=timeout&from=1&to=2&before=b3BhcXVl%3Ax&limit=50')
    await client.usage.request('req/1')
    expect(fetch.mock.calls[1]![0]).toBe('/console/api/requests/req%2F1')
    await client.audit.list({ actor: 'dana', action: 'key.' })
    expect(fetch.mock.calls[2]![0]).toBe('/console/api/audit?actor=dana&action=key.')
  })

  it('uses clearer copy for known error codes', async () => {
    const fetch = fakeFetch(json(503, { error: { code: 'buyer_policy_unsupported', message: 'raw' } }))
    const error = await createApiClient(fetch).settings.status().catch((cause) => cause)
    expect(errorMessage(error)).toMatch(/cannot apply routing policies/)
  })
})
