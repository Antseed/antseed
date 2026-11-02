import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * A loopback JSON-RPC relay so Anvil never gets the fork URL on its command line, where every user on the
 * machine can read it with `ps`. Anvil is pointed at http://127.0.0.1:<port>/<token>; only this process holds
 * the real URL (with its API key). Requests without the token get a 404, so other local users cannot spend
 * the key through the relay without also reading the sandbox's command line.
 */
export async function startRpcRelay(upstreamUrl, { fetchImpl = fetch } = {}) {
  const token = randomBytes(16).toString('hex');
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== `/${token}`) {
      res.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const upstream = await fetchImpl(upstreamUrl, {
        method: 'POST',
        headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
        body: Buffer.concat(chunks),
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      res.end(body);
    } catch {
      // Never echo the upstream error: it can contain the URL.
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'sandbox RPC relay: upstream request failed' } }));
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/${token}`,
    close: () => new Promise((resolveClose) => { server.closeAllConnections?.(); server.close(() => resolveClose()); }),
  };
}
