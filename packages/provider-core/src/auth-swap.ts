import type { SerializedHttpRequest } from '@antseed/node';

/** Set of all known auth header names (lowercase). */
export const KNOWN_AUTH_HEADERS: Set<string> = new Set([
  'authorization', 'x-api-key', 'x-goog-api-key',
]);

/**
 * Strips all known auth headers and injects the seller's auth.
 * Returns a NEW object (no mutation of the original).
 */
export function swapAuthHeader(
  request: SerializedHttpRequest,
  config: { authHeaderName: string; authHeaderValue: string; extraHeaders?: Record<string, string> }
): SerializedHttpRequest {
  const newHeaders: Record<string, string> = {};

  for (const [key, value] of Object.entries(request.headers)) {
    if (!KNOWN_AUTH_HEADERS.has(key.toLowerCase())) {
      newHeaders[key] = value;
    }
  }

  newHeaders[config.authHeaderName] = config.authHeaderValue;

  // Inject any extra headers (e.g. anthropic-beta for OAuth).
  // For anthropic-beta, merge with existing values (comma-separated)
  // so the buyer's beta flags (e.g. context-management) are preserved.
  if (config.extraHeaders) {
    for (const [key, value] of Object.entries(config.extraHeaders)) {
      const lower = key.toLowerCase();
      if (lower === 'anthropic-beta' && newHeaders[key]) {
        // Merge: deduplicate comma-separated beta flags
        const existing = new Set(newHeaders[key]!.split(',').map((s) => s.trim()));
        for (const flag of value.split(',').map((s) => s.trim())) {
          existing.add(flag);
        }
        newHeaders[key] = [...existing].join(',');
      } else {
        newHeaders[key] = value;
      }
    }
  }

  return {
    requestId: request.requestId,
    method: request.method,
    path: request.path,
    headers: newHeaders,
    body: request.body,
  };
}

/**
 * Validate request against allowed services.
 * Parses JSON body and checks the `"service"` or `"model"` field against the allow-list.
 * Requests without a JSON body or without a service/model field are allowed through
 * (e.g. GET requests have no body and need no validation).
 * Returns null if ok, error string if rejected.
 */
export function validateRequestService(
  request: SerializedHttpRequest,
  allowedServices: ReadonlySet<string>,
  /** Reads the body as JSON, throwing when it is not: pass one to share a single parse with other readers. */
  readJsonBody: () => unknown = () => JSON.parse(new TextDecoder().decode(request.body)) as unknown,
): string | null {
  // If allowedServices is empty, allow everything
  if (allowedServices.size === 0) {
    return null;
  }

  // GET/HEAD have no body — nothing to validate
  if (request.method === 'GET' || request.method === 'HEAD') {
    return null;
  }

  let payload: unknown;
  try {
    payload = readJsonBody();
  } catch {
    // Non-JSON body — no service field to validate, allow through
    return null;
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    // No service field possible — allow through
    return null;
  }

  // Accept both "service" (native) and "model" (upstream API compat) fields
  const obj = payload as Record<string, unknown>;
  const service = obj["service"] ?? obj["model"];
  if (typeof service !== "string" || service.trim() === "") {
    // No service field — allow through (endpoint may not require it)
    return null;
  }

  const normalized = service.trim().toLowerCase();
  if (!allowedServices.has(normalized)) {
    return `Service "${service}" is not in the allowed list`;
  }

  return null;
}
