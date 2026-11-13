// JSON-RPC proxy in front of anvil that behaves more like a public Base RPC:
// per-call latency with a slow tail, a per-client rate limit answered with
// HTTP 429, and load-balanced nodes that lag a block behind for a while after
// a transaction (stale eth_call / eth_getBalance, receipts not found yet).
// Proxies in front of one chain share a `chain` clock: a transaction sent
// through one makes reads through every one of them lag.
//
// holdTopUp() makes the proxy keep the next AntseedChannels topUp()
// transaction instead of sending it: the node sees a send that never returns,
// as if it stopped right before the transaction went out. dropHeldTopUp()
// answers it with an error once the node is gone; the chain never sees it.
import { createServer } from 'node:http';
import { Transaction, id } from 'ethers';

const TOP_UP_SELECTOR = id('topUp(bytes32,uint128,bytes,bytes,uint128,uint256,bytes)').slice(0, 10);

function isTopUpTransaction(raw) {
  try {
    return Transaction.from(raw).data.slice(0, 10).toLowerCase() === TOP_UP_SELECTOR;
  } catch {
    return false;
  }
}

export async function startRpcProxy({
  port,
  upstream,
  latencyMinMs = 120,
  latencyMaxMs = 400,
  slowTailRate = 0.05,
  slowTailMs = [1000, 2500],
  ratePerSec = 12,
  burst = 25,
  lagWindowMs = Number(process.env.RPC_LAG_WINDOW_MS ?? 4000),
  staleReadRate = 0.35,
  receiptMissRate = 0.4,
  seed = 1,
  chain = { lastTxAt: 0 },
}) {
  let rnd = seed >>> 0;
  const random = () => {
    rnd = (rnd * 1664525 + 1013904223) >>> 0;
    return rnd / 2 ** 32;
  };
  const stats = { calls: 0, rateLimited: 0, staleReads: 0, receiptMisses: 0, heldTopUps: 0 };
  // One topUp() to keep back: armed by holdTopUp(), then the held request until dropHeldTopUp().
  let topUpHold = null;
  let tokens = burst;
  let refilledAt = Date.now();

  const takeTokens = (n) => {
    const now = Date.now();
    tokens = Math.min(burst, tokens + ((now - refilledAt) / 1000) * ratePerSec);
    refilledAt = now;
    if (tokens < n) return false;
    tokens -= n;
    return true;
  };
  const delay = () => {
    const ms = random() < slowTailRate
      ? slowTailMs[0] + random() * (slowTailMs[1] - slowTailMs[0])
      : latencyMinMs + random() * (latencyMaxMs - latencyMinMs);
    return new Promise((r) => setTimeout(r, ms));
  };
  const forward = async (body) => {
    const r = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  };
  const latestBlock = async () => {
    const j = await forward({ jsonrpc: '2.0', id: 0, method: 'eth_blockNumber', params: [] });
    return BigInt(j.result);
  };

  // Rewrites one request the way a lagging node would answer it.
  const lagged = async (req) => {
    const inWindow = Date.now() - chain.lastTxAt < lagWindowMs;
    if (!inWindow) return null;
    if (req.method === 'eth_getTransactionReceipt' && random() < receiptMissRate) {
      stats.receiptMisses += 1;
      return { jsonrpc: '2.0', id: req.id, result: null };
    }
    if ((req.method === 'eth_call' || req.method === 'eth_getBalance') && random() < staleReadRate) {
      const params = [...(req.params ?? [])];
      const tagIndex = req.method === 'eth_call' ? 1 : 1;
      const tag = params[tagIndex];
      if (tag === undefined || tag === 'latest' || tag === 'pending') {
        const behind = (await latestBlock()) - 1n;
        if (behind > 0n) {
          params[tagIndex] = '0x' + behind.toString(16);
          stats.staleReads += 1;
          return forward({ ...req, params });
        }
      }
    }
    return null;
  };

  const handleOne = async (req) => {
    if (req.method === 'eth_sendRawTransaction' && topUpHold && !topUpHold.heldAt && isTopUpTransaction(req.params?.[0])) {
      const hold = topUpHold;
      hold.heldAt = Date.now();
      stats.heldTopUps += 1;
      hold.onHeld();
      await hold.dropped;
      return { jsonrpc: '2.0', id: req.id, error: { code: -32603, message: 'stress rpc proxy: held topUp transaction dropped' } };
    }
    if (req.method === 'eth_sendRawTransaction') {
      const res = await forward(req);
      chain.lastTxAt = Date.now();
      return res;
    }
    return (await lagged(req)) ?? forward(req);
  };

  const server = createServer((httpReq, httpRes) => {
    let raw = '';
    httpReq.on('data', (c) => { raw += c; });
    httpReq.on('end', async () => {
      let body;
      try { body = JSON.parse(raw); } catch { httpRes.writeHead(400); httpRes.end(); return; }
      const batch = Array.isArray(body) ? body : [body];
      stats.calls += batch.length;
      if (!takeTokens(batch.length)) {
        stats.rateLimited += batch.length;
        await delay();
        httpRes.writeHead(429, { 'content-type': 'application/json' });
        httpRes.end(JSON.stringify({ jsonrpc: '2.0', id: batch[0]?.id ?? null, error: { code: 429, message: 'Too many requests' } }));
        return;
      }
      await delay();
      try {
        const results = await Promise.all(batch.map(handleOne));
        httpRes.writeHead(200, { 'content-type': 'application/json' });
        httpRes.end(JSON.stringify(Array.isArray(body) ? results : results[0]));
      } catch (err) {
        httpRes.writeHead(502, { 'content-type': 'application/json' });
        httpRes.end(JSON.stringify({ jsonrpc: '2.0', id: batch[0]?.id ?? null, error: { code: -32603, message: String(err) } }));
      }
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    stats,
    /** Keeps the next topUp() transaction back. Resolves once one is held; the chain has not seen it. */
    holdTopUp() {
      if (topUpHold) throw new Error('a topUp hold is already armed');
      let onHeld; let drop;
      const held = new Promise((resolve) => { onHeld = resolve; });
      const dropped = new Promise((resolve) => { drop = resolve; });
      topUpHold = { heldAt: null, onHeld, drop, held, dropped };
      return held;
    },
    /** Whether a held topUp() is waiting, and when it arrived. */
    topUpHoldState: () => (topUpHold ? { armed: true, heldAt: topUpHold.heldAt } : { armed: false, heldAt: null }),
    /** Answers the held topUp() with an error without sending it, and disarms the hold. */
    dropHeldTopUp() {
      const hold = topUpHold;
      topUpHold = null;
      hold?.drop();
      return Boolean(hold?.heldAt);
    },
    close: () => new Promise((resolve) => { topUpHold?.drop(); topUpHold = null; server.close(() => resolve()); }),
  };
}
