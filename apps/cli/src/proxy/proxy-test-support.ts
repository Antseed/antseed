/** Test-only: a request and a response to hand the buyer proxy's handler, without a socket. */
import { Readable } from 'node:stream'
import type { BuyerProxy } from './buyer-proxy.js'

export function makeProxyRequest(options: {
  method?: string
  path?: string
  headers?: Record<string, string>
  body?: Record<string, unknown>
  rawBody?: string
}): Readable {
  const body = options.rawBody ?? JSON.stringify(options.body ?? { model: 'gpt-4o', messages: [] })
  const req = Readable.from([Buffer.from(body)]) as Readable & {
    method: string
    url: string
    headers: Record<string, string>
    complete: boolean
  }
  req.method = options.method ?? 'POST'
  req.url = options.path ?? '/v1/chat/completions'
  req.headers = {
    'content-type': 'application/json',
    ...(options.headers ?? {}),
  }
  req.complete = true
  return req
}

export function makeProxyResponse(): {
  statusCode: number
  headers: Record<string, string>
  body: string
  headersSent: boolean
  writableEnded: boolean
  writeHead: (statusCode: number, headers: Record<string, string>) => unknown
  setHeader: (name: string, value: string) => unknown
  write: (chunk: string | Buffer | Uint8Array) => unknown
  end: (chunk?: string | Buffer | Uint8Array) => unknown
  once: () => unknown
  on: () => unknown
  getHeader: (name: string) => string | undefined
} {
  // Headers set before writeHead merge into it, as on a Node ServerResponse.
  const pending: Record<string, string> = {}
  return {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
    writeHead(statusCode: number, headers: Record<string, string>) {
      this.statusCode = statusCode
      this.headers = { ...pending, ...headers }
      this.headersSent = true
      return this
    },
    setHeader(name: string, value: string) {
      pending[name.toLowerCase()] = value
      return this
    },
    write(chunk: string | Buffer | Uint8Array) {
      this.body += Buffer.from(chunk).toString('utf8')
      return true
    },
    end(chunk?: string | Buffer | Uint8Array) {
      if (chunk !== undefined) {
        this.body += Buffer.from(chunk).toString('utf8')
      }
      this.writableEnded = true
      return this
    },
    once() {
      return this
    },
    on() {
      return this
    },
    getHeader(name: string) {
      return pending[name.toLowerCase()]
    },
  }
}

export async function invokeProxy(proxy: BuyerProxy, req: Readable): Promise<ReturnType<typeof makeProxyResponse>> {
  const res = makeProxyResponse()
  await (proxy as any)._handleRequest(req, res)
  return res
}
