import type { SerializedHttpResponse } from '@antseed/node';

/** An OpenAI-style JSON error answer: `upstream_error` for 5xx, else `invalid_request_error`, with the offending `param` when known. */
export function openAiError(
  requestId: string,
  statusCode: number,
  message: string,
  param?: string,
): SerializedHttpResponse {
  return {
    requestId,
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({
      error: {
        message,
        type: statusCode >= 500 ? 'upstream_error' : 'invalid_request_error',
        ...(param ? { param } : {}),
      },
    })),
  };
}
