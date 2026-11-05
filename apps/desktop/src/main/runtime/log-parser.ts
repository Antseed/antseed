import type { RuntimeMode } from './process-manager.js';

export type LogEvent = {
  mode: RuntimeMode;
  stream: 'stdout' | 'stderr' | 'system';
  line: string;
  timestamp: number;
};

export type RuntimeActivityTone = 'active' | 'idle' | 'warn' | 'bad';

export type RuntimeActivityEvent = {
  mode: RuntimeMode;
  tone: RuntimeActivityTone;
  stage: string;
  message: string;
  holdMs: number;
  timestamp: number;
  requestId?: string;
  peerId?: string;
};

export function stripAnsi(input: string): string {
  return input.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

export function shortId(value: string | undefined): string {
  if (!value) {
    return 'unknown';
  }
  return value.length > 8 ? value.slice(0, 8) : value;
}

export function toRuntimeActivity(event: Omit<RuntimeActivityEvent, 'timestamp'>): RuntimeActivityEvent {
  return {
    ...event,
    timestamp: Date.now(),
  };
}

// When a specific connect error (e.g. port-in-use) is detected, suppress the
// generic "exited unexpectedly" message for a short window so the specific
// error isn't overwritten by the process-exit log that immediately follows.
let connectSpecificErrorAt = 0;
const CONNECT_EXIT_SUPPRESS_WINDOW_MS = 5_000;

export function parseConnectRuntimeActivity(lineRaw: string): RuntimeActivityEvent | null {
  const line = stripAnsi(lineRaw).trim();
  if (line.length === 0) {
    return null;
  }

  const proxyBindErrorMatch = /failed to start proxy:\s*listen\s+eaddrinuse:\s*address already in use.*:(\d+)/i.exec(line);
  if (proxyBindErrorMatch) {
    const port = proxyBindErrorMatch[1] ?? '8377';
    connectSpecificErrorAt = Date.now();
    return toRuntimeActivity({
      mode: 'gateway',
      tone: 'bad',
      stage: 'proxy-port-in-use',
      message: `Buyer proxy port :${port} is already in use.`,
      holdMs: 120_000,
    });
  }

  if (/process exited \(code=\d+\)/i.test(line)) {
    // If a specific error was just shown (e.g. port in use), don't overwrite it
    // with the generic exit message — the process exiting is a consequence, not the cause.
    if (Date.now() - connectSpecificErrorAt < CONNECT_EXIT_SUPPRESS_WINDOW_MS) {
      return null;
    }
    return toRuntimeActivity({
      mode: 'gateway',
      tone: 'bad',
      stage: 'connect-exit',
      message: 'Buyer runtime exited unexpectedly.',
      holdMs: 90_000,
    });
  }

  const adapterMatch = /\[proxy\]\s+Applying protocol adapter\s+([^\s]+)\s*->\s*([^\s]+)\s+via provider\s+"([^"]+)"/i.exec(line);
  if (adapterMatch) {
    const from = adapterMatch[1] ?? 'unknown';
    const to = adapterMatch[2] ?? 'unknown';
    const provider = adapterMatch[3] ?? 'unknown';
    return toRuntimeActivity({
      mode: 'gateway',
      tone: 'warn',
      stage: 'protocol-adapter',
      message: `Adapting protocol ${from} -> ${to} via ${provider}.`,
      holdMs: 15_000,
    });
  }

  const sendMatch = /\[Node\]\s+sendRequest(?:Stream)?\s+([A-Z]+)\s+(\S+)\s+.*peer\s+([a-f0-9]+)\.\.\.\s+\(reqId=([a-f0-9-]+)\)/i.exec(line);
  if (sendMatch) {
    const method = sendMatch[1] ?? 'REQ';
    const path = sendMatch[2] ?? '/';
    const peerId = sendMatch[3] ?? '';
    const requestId = sendMatch[4] ?? '';
    return toRuntimeActivity({
      mode: 'gateway',
      tone: 'warn',
      stage: 'request-dispatched',
      message: `Request ${shortId(requestId)}: ${method} ${path} to peer ${shortId(peerId)}...`,
      holdMs: 20_000,
      requestId,
      peerId,
    });
  }

  const routingMatch = /\[proxy\]\s+Routing to peer\s+([a-f0-9]+)\.\.\./i.exec(line);
  if (routingMatch) {
    const peerId = routingMatch[1] ?? '';
    return toRuntimeActivity({
      mode: 'gateway',
      tone: 'warn',
      stage: 'routing',
      message: `Routing request to peer ${shortId(peerId)}...`,
      holdMs: 15_000,
      peerId,
    });
  }

  const connectingMatch = /\[Node\]\s+Connecting to\s+([a-f0-9]+)\.\.\.\s+at\s+([0-9a-z.:_-]+)/i.exec(line);
  if (connectingMatch) {
    const peerId = connectingMatch[1] ?? '';
    const endpoint = connectingMatch[2] ?? 'unknown';
    return toRuntimeActivity({
      mode: 'gateway',
      tone: 'warn',
      stage: 'peer-connecting',
      message: `Connecting to peer ${shortId(peerId)} at ${endpoint}...`,
      holdMs: 15_000,
      peerId,
    });
  }

  const connectionStateMatch = /\[Node\]\s+Connection(?: to [a-f0-9.]+)? state:\s*(\w+)/i.exec(line);
  if (connectionStateMatch) {
    const state = (connectionStateMatch[1] ?? '').toLowerCase();
    if (state === 'open') {
      return toRuntimeActivity({
        mode: 'gateway',
        tone: 'active',
        stage: 'peer-connected',
        message: 'Peer connection open.',
        holdMs: 12_000,
      });
    }
  }

  const responseMatch = /\[Node\]\s+Response for\s+([a-f0-9-]+):\s+status=(\d+)\s+\((\d+)ms/i.exec(line);
  if (responseMatch) {
    const requestId = responseMatch[1] ?? '';
    const status = Number(responseMatch[2] ?? 0);
    const latencyMs = Number(responseMatch[3] ?? 0);
    const ok = status >= 200 && status < 400;
    return toRuntimeActivity({
      mode: 'gateway',
      tone: ok ? 'active' : 'bad',
      stage: 'response',
      message: ok
        ? `Request ${shortId(requestId)} succeeded (${status}, ${String(latencyMs)}ms).`
        : `Request ${shortId(requestId)} failed (${status}, ${String(latencyMs)}ms).`,
      holdMs: ok ? 12_000 : 45_000,
      requestId,
    });
  }

  const timeoutMatch = /\[Node\]\s+Request\s+([a-f0-9-]+)\s+timed out after\s+(\d+)ms/i.exec(line);
  if (timeoutMatch) {
    const requestId = timeoutMatch[1] ?? '';
    const timeoutMs = timeoutMatch[2] ?? '30000';
    return toRuntimeActivity({
      mode: 'gateway',
      tone: 'bad',
      stage: 'request-timeout',
      message: `Request ${shortId(requestId)} timed out after ${timeoutMs}ms.`,
      holdMs: 60_000,
      requestId,
    });
  }

  const retryMatch = /\[proxy\]\s+Peer\s+([a-f0-9]+)\.\.\.\s+returned\s+(\d+),\s+retrying.*\(attempt\s+(\d+)\/(\d+)\)/i.exec(line);
  if (retryMatch) {
    const peerId = retryMatch[1] ?? '';
    const code = retryMatch[2] ?? 'unknown';
    const attempt = retryMatch[3] ?? '?';
    const max = retryMatch[4] ?? '?';
    return toRuntimeActivity({
      mode: 'gateway',
      tone: 'warn',
      stage: 'peer-retry',
      message: `Peer ${shortId(peerId)} returned ${code}. Retrying (${attempt}/${max})...`,
      holdMs: 25_000,
      peerId,
    });
  }

  const allFailedMatch = /\[proxy\]\s+All\s+\d+\s+peer\(s\)\s+failed, returning last error \((\d+)\)/i.exec(line);
  if (allFailedMatch) {
    const code = allFailedMatch[1] ?? 'unknown';
    return toRuntimeActivity({
      mode: 'gateway',
      tone: 'bad',
      stage: 'routing-failed',
      message: `All candidate peers failed (${code}).`,
      holdMs: 60_000,
    });
  }

  if (/\[proxy\]\s+No peers available for request/i.test(line)) {
    return toRuntimeActivity({
      mode: 'gateway',
      tone: 'bad',
      stage: 'no-peers',
      message: 'No peers available for this request.',
      holdMs: 60_000,
    });
  }

  if (/\[Node\]\s+Discovering peers/i.test(line)) {
    return toRuntimeActivity({
      mode: 'gateway',
      tone: 'warn',
      stage: 'discovering-peers',
      message: 'Discovering peers from DHT...',
      holdMs: 12_000,
    });
  }

  const dhtResultMatch = /\[Node\]\s+DHT returned\s+(\d+)\s+result\(s\)/i.exec(line);
  if (dhtResultMatch) {
    const count = Number(dhtResultMatch[1] ?? 0);
    return toRuntimeActivity({
      mode: 'gateway',
      tone: count > 0 ? 'active' : 'warn',
      stage: 'dht-results',
      message: `DHT discovery returned ${String(count)} peer result${count === 1 ? '' : 's'}.`,
      holdMs: 12_000,
    });
  }

  if (/\[proxy\]\s+POST \/v1\/messages/i.test(line)) {
    return toRuntimeActivity({
      mode: 'gateway',
      tone: 'warn',
      stage: 'chat-request',
      message: 'Submitting chat request to buyer proxy...',
      holdMs: 18_000,
    });
  }

  if (/\[proxy\]\s+GET \/v1\/models/i.test(line)) {
    return toRuntimeActivity({
      mode: 'gateway',
      tone: 'warn',
      stage: 'service-request',
      message: 'Loading available services from peers...',
      holdMs: 20_000,
    });
  }

  return null;
}

export function parseRuntimeActivityFromLog(event: LogEvent): RuntimeActivityEvent | null {
  if (event.mode === 'gateway') {
    return parseConnectRuntimeActivity(event.line);
  }
  return null;
}
