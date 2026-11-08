/**
 * How the agent's shell reaches the gateway without holding its key. Any command
 * the agent runs can read its environment, so a run gets a throwaway token and
 * this loopback address instead: the relay swaps the token for the real key and
 * forwards only the API paths the bundled skills call. The token stops working
 * when the run ends. Scripts can still spend through it during the run, under
 * the key's own limits and policy, but have no credential to carry away.
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';

/** `/v1/...` for text and images; `/api/v1/video`, `/fal/...` for the video skill's retrievals. */
const FORWARDED_PATH = /^\/(?:v1|api\/v1\/video|fal\/v1\/video)(?:\/|\?|$)/;

type Gateway = { origin: string; apiKey: string };
export type ShellGatewayGrant = { url: string; token: string; revoke: () => void };

const grants = new Map<string, Gateway>();
let listening: Promise<number> | null = null;

function requestToken(req: http.IncomingMessage): string | null {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
  const apiKey = req.headers['x-api-key'];
  return bearer ?? (typeof apiKey === 'string' ? apiKey : null);
}

function refuse(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message } }));
}

function forward(req: http.IncomingMessage, res: http.ServerResponse): void {
  const token = requestToken(req);
  const gateway = token ? grants.get(token) : undefined;
  if (!gateway) {
    refuse(res, 401, 'This token is not valid, or its chat run has ended.');
    return;
  }
  // Checked once normalized: `/v1/../console` passes as raw text but lands on the console, with the real key.
  let target: URL;
  try {
    target = new URL(req.url ?? '/', gateway.origin);
  } catch {
    // A raw target like `//[/` throws here, in the main process: answer it instead.
    refuse(res, 400, 'This request path is not valid.');
    return;
  }
  if (target.origin !== new URL(gateway.origin).origin || !FORWARDED_PATH.test(target.pathname + target.search)) {
    refuse(res, 403, 'This path is not available from the chat\'s shell.');
    return;
  }
  const headers: http.OutgoingHttpHeaders = { ...req.headers, authorization: `Bearer ${gateway.apiKey}` };
  delete headers.host;
  delete headers.connection;
  delete headers['x-api-key'];
  const send = target.protocol === 'https:' ? https.request : http.request;
  const upstream = send(target, { method: req.method, headers }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(res);
  });
  upstream.on('error', () => {
    if (res.headersSent) res.destroy();
    else refuse(res, 502, 'Could not reach the gateway.');
  });
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

function ensureListening(): Promise<number> {
  listening ??= new Promise<number>((resolve, reject) => {
    const server = http.createServer(forward);
    server.once('error', (err) => {
      listening = null;
      reject(err);
    });
    server.listen(0, '127.0.0.1', () => {
      server.unref();
      resolve((server.address() as AddressInfo).port);
    });
  });
  return listening;
}

export async function grantShellGateway(gateway: Gateway): Promise<ShellGatewayGrant> {
  const port = await ensureListening();
  const token = randomBytes(32).toString('hex');
  grants.set(token, gateway);
  return { url: `http://127.0.0.1:${port}`, token, revoke: () => { grants.delete(token); } };
}
