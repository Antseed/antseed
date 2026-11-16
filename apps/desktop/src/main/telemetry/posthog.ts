/**
 * Minimal PostHog HTTP transport.
 *
 * Fire-and-forget by design: a short timeout, no retries, no queue, and
 * every failure swallowed. Telemetry must never affect startup, chat,
 * payments, or shutdown.
 */
export const POSTHOG_CAPTURE_TIMEOUT_MS = 4_000;

export type PostHogCapturePayload = {
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, unknown>;
};

export type PostHogTransport = (payload: PostHogCapturePayload) => Promise<void>;

export function createPostHogTransport(options: { host: string; projectApiKey: string }): PostHogTransport {
  const captureUrl = `${options.host.replace(/\/+$/, '')}/capture/`;
  const apiKey = options.projectApiKey;
  return async (payload) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POSTHOG_CAPTURE_TIMEOUT_MS);
    try {
      await fetch(captureUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, api_key: apiKey }),
        signal: controller.signal,
      });
    } catch {
      // PostHog outages, offline machines, DNS failures — all ignored.
    } finally {
      clearTimeout(timer);
    }
  };
}
