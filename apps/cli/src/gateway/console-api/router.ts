import type * as http from 'node:http'
import type { MeResponse, OrgRole, WorkspaceRole } from './types.js'

/** Who is calling the console API. */
export type Principal =
  | { kind: 'member'; memberId: string; orgRole: OrgRole; workspaceRoles: ReadonlyMap<string, WorkspaceRole>; sessionId: string }
  | { kind: 'key'; keyId: string; sessionId: string }
  | { kind: 'token'; tokenId: string; scope: 'admin' | 'read' }

export interface ConsoleRequest {
  method: string
  /** Path below `/console/api`, e.g. `/workspaces/ws_1/wallet`. */
  path: string
  params: Record<string, string>
  query: URLSearchParams
  body: unknown
  headers: http.IncomingHttpHeaders
  /** Null only on routes registered with `public: true`. */
  principal: Principal | null
  raw: http.IncomingMessage
  res: http.ServerResponse
}

/**
 * A handler returns the JSON body (status 200), a `ConsoleResponse` for other
 * statuses or content types, or `undefined` after writing to `res` itself
 * (redirects, CSV streams). Throw `ConsoleError` for error responses.
 */
export type ConsoleHandler = (request: ConsoleRequest) => Promise<unknown>

export interface ConsoleResponse {
  __consoleResponse: true
  status: number
  body?: unknown
  contentType?: string
  headers?: Record<string, string>
}

export function respond(status: number, body?: unknown, options: { contentType?: string; headers?: Record<string, string> } = {}): ConsoleResponse {
  return { __consoleResponse: true, status, body, ...options }
}

export class ConsoleError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message)
  }
}

export interface RouteOptions {
  /** Reachable without a session (auth endpoints, config). */
  public?: boolean
  /** Principals allowed; defaults to members and tokens. */
  allow?: ReadonlyArray<Principal['kind']>
}

export interface Route {
  method: string
  pattern: string
  handler: ConsoleHandler
  options: RouteOptions
}

/**
 * Minimal method + path router. Patterns use `:name` segments, e.g.
 * `/workspaces/:id/members/:memberId`. Feature modules export a
 * `register…Routes(router, deps)` function that calls `router.add`.
 */
export class ConsoleRouter {
  private readonly _routes: Route[] = []

  add(method: string, pattern: string, handler: ConsoleHandler, options: RouteOptions = {}): void {
    this._routes.push({ method: method.toUpperCase(), pattern, handler, options })
  }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    const segments = path.split('/').filter(Boolean)
    for (const route of this._routes) {
      if (route.method !== method.toUpperCase()) continue
      const pattern = route.pattern.split('/').filter(Boolean)
      if (pattern.length !== segments.length) continue
      const params: Record<string, string> = {}
      let ok = true
      for (let index = 0; index < pattern.length; index += 1) {
        const part = pattern[index]!
        const segment = segments[index]!
        if (part.startsWith(':')) {
          params[part.slice(1)] = decodeURIComponent(segment)
        } else if (part !== segment) {
          ok = false
          break
        }
      }
      if (ok) return { route, params }
    }
    return null
  }

  get routes(): readonly Route[] {
    return this._routes
  }
}

/**
 * Authentication, implemented in `../auth/`. The console API server calls it
 * to resolve the principal of every request and mounts its routes.
 */
export interface ConsoleAuth {
  /** Resolves a session cookie or management token; null when there is none or it is invalid. */
  authenticate(req: http.IncomingMessage): Promise<Principal | null>
  /** Registers `/auth/*` routes. */
  registerRoutes(router: ConsoleRouter): void
  /** Ends every session of a member (used when a member is disabled). */
  revokeMemberSessions(memberId: string): void
  /** Ends every session opened with this API key (used when a key is revoked or rotated). */
  revokeKeySessions(keyId: string): void
  /** Current principal as the console's `/auth/me` shape. */
  me(principal: Principal): Promise<MeResponse>
}
