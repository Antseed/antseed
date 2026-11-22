// End-to-end test of the keyed-relay sidecars against a local TLS upstream.
// Needs the native binary (`pnpm --filter @antseed/keyed-relay build:native`);
// skipped without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import tls from 'node:tls';
import { KeyedRelayProcess, resolveKeyedRelayBinary } from '../dist/index.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const CA = fixture('ca.pem');
const binary = resolveKeyedRelayBinary();

const SECRET_KEY = 'sk-seller-secret-0123456789';
const PROMPT_WORD = 'zebra-prompt-codeword';
const ANSWER_WORD = 'giraffe-answer-codeword';

/** A TLS 1.2 upstream that records the request and answers an SSE stream with usage; with `stall`, it never ends the answer. */
function startUpstream({ stall = false } = {}) {
  const requests = [];
  /** Everything each connection received, complete request or not. */
  const received = [];
  const server = tls.createServer({ key: fixture('localhost.key'), cert: fixture('localhost.pem'), maxVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'] }, (socket) => {
    let raw = Buffer.alloc(0);
    const index = received.push('') - 1;
    socket.on('data', (data) => {
      raw = Buffer.concat([raw, data]);
      received[index] = raw.toString();
      const end = raw.indexOf('\r\n\r\n');
      if (end < 0) return;
      const length = Number(/content-length: (\d+)/i.exec(raw.subarray(0, end).toString())?.[1] ?? 0);
      if (raw.length < end + 4 + length) return;
      requests.push(raw.toString());
      const chunks = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: ANSWER_WORD } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })}\n\n`,
        'data: [DONE]\n\n',
      ];
      let body = '';
      for (const chunk of chunks) body += `${Buffer.byteLength(chunk).toString(16)}\r\n${chunk}\r\n`;
      // The end of the body goes out in a TLS record of its own, as upstreams send it.
      socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${body}`, () => {
        if (!stall) setTimeout(() => socket.end('0\r\n\r\n'), 20);
      });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests, received })));
}

/** Writes the buyer's request and reveals its headers and the last `tailLength` bytes; resolves with what the seller saw. */
async function sendRequest(buyer, seller, request, headerLength, tailLength) {
  const seen = seller.waitFor('request', 30_000);
  buyer.writeApp(Buffer.from(request));
  const length = Buffer.byteLength(request);
  buyer.revealRequest(length, [[0, headerLength], [length - tailLength, tailLength]]);
  return seen;
}

test('the seller adds its key to a session it cannot read, and decrypts only what the buyer reveals', { skip: !binary && 'native sidecar not built' }, async () => {
  const { server, port, requests } = await startUpstream();
  try {
    const seller = KeyedRelayProcess.spawn('seller', binary);
    const buyer = KeyedRelayProcess.spawn('buyer', binary);
    // Everything that crosses the relay, in both directions.
    const relayed = [];
    seller.peer.on('data', (d) => { relayed.push(d); buyer.peer.write(d); });
    buyer.peer.on('data', (d) => { relayed.push(d); seller.peer.write(d); });

    const head = `POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${SECRET_KEY}\r\nConnection: close\r\n`;
    seller.startSeller({ host: '127.0.0.1', port, serverName: 'localhost', head: Buffer.from(head), extraRootsPem: CA });
    buyer.startBuyer({ serverName: 'localhost', extraRootsPem: CA });

    await buyer.waitFor('ready', 60_000);
    const tail = ',"model":"test","n":1,"stream":true}';
    const body = `{"messages":[{"role":"user","content":"${PROMPT_WORD}"}]${tail}`;
    const headers = `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
    const request = await sendRequest(buyer, seller, headers + body, headers.length, tail.length);
    // The seller holds the request, and sees only the headers and the body's last fields.
    assert.equal(request.length, headers.length + body.length);
    assert.deepEqual(request.ranges.map((r) => [r.offset, Buffer.from(r.data, 'base64').toString()]), [[0, headers], [headers.length + body.length - tail.length, tail]]);
    assert.equal(requests.length, 0, 'nothing of the request went upstream before the seller admitted it');
    seller.admit();
    await buyer.waitFor('admitted', 30_000);

    let response = Buffer.alloc(0);
    buyer.on('app', (d) => { response = Buffer.concat([response, d]); });
    const end = await buyer.waitFor('responseEnd', 30_000);
    const text = response.toString();
    assert.equal(end.length, response.length);
    assert.match(text, /^HTTP\/1\.1 200 OK\r\n/);
    assert.ok(text.includes(ANSWER_WORD), 'the buyer reads the answer');
    assert.ok(!text.includes(SECRET_KEY), 'the buyer never sees the key');

    const usageLine = text.lastIndexOf('data: {"choices":[],"usage"');
    const revealedPromise = seller.waitFor('revealed', 30_000);
    buyer.reveal([[0, text.indexOf('\r\n')], [usageLine, text.length - usageLine]]);
    const revealed = await revealedPromise;
    await buyer.waitFor('done', 30_000);

    // The upstream got the seller's head, then the buyer's headers and body, as one request.
    assert.equal(requests.length, 1);
    assert.equal(requests[0], head + `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);

    // The seller decrypted exactly the revealed ranges, and nothing else crossed in plaintext.
    const shown = revealed.ranges.map((r) => [r.offset, Buffer.from(r.data, 'base64').toString()]);
    assert.deepEqual(shown, [[0, 'HTTP/1.1 200 OK'], [usageLine, text.slice(usageLine)]]);
    assert.equal(revealed.length, response.length);
    const wire = Buffer.concat(relayed).toString('latin1');
    for (const secret of [SECRET_KEY, PROMPT_WORD, ANSWER_WORD]) assert.ok(!wire.includes(secret), `${secret} crossed the relay in plaintext`);
  } finally {
    server.close();
  }
});

test('a revealed range that crosses TLS records reaches the seller as one range', { skip: !binary && 'native sidecar not built' }, async () => {
  const { server, port, requests } = await startUpstream();
  try {
    const seller = KeyedRelayProcess.spawn('seller', binary);
    const buyer = KeyedRelayProcess.spawn('buyer', binary);
    seller.peer.pipe(buyer.peer);
    buyer.peer.pipe(seller.peer);
    seller.startSeller({ host: '127.0.0.1', port, serverName: 'localhost', head: Buffer.from('POST /x HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer k\r\nConnection: close\r\n'), extraRootsPem: CA });
    buyer.startBuyer({ serverName: 'localhost', extraRootsPem: CA });
    await buyer.waitFor('ready', 60_000);
    // A TLS record holds at most 16384 bytes, so a 20000-byte tail spans at least two.
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(40_000) }] });
    const headers = `Content-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`;
    const request = await sendRequest(buyer, seller, headers + body, headers.length, 20_000);
    assert.deepEqual(request.ranges.map((r) => [r.offset, Buffer.from(r.data, 'base64').toString()]), [[0, headers], [headers.length + body.length - 20_000, body.slice(-20_000)]]);
    seller.admit();
    await buyer.waitFor('responseEnd', 30_000);
    buyer.reveal([]);
    await buyer.waitFor('done', 30_000);
    assert.equal(requests.length, 1);
    assert.ok(requests[0].endsWith(body));
  } finally {
    server.close();
  }
});

test('a buyer that reveals nothing leaves the seller with lengths only', { skip: !binary && 'native sidecar not built' }, async () => {
  const { server, port } = await startUpstream();
  try {
    const seller = KeyedRelayProcess.spawn('seller', binary);
    const buyer = KeyedRelayProcess.spawn('buyer', binary);
    seller.peer.pipe(buyer.peer);
    buyer.peer.pipe(seller.peer);
    seller.startSeller({ host: '127.0.0.1', port, serverName: 'localhost', head: Buffer.from('POST /x HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer k\r\nConnection: close\r\n'), extraRootsPem: CA });
    buyer.startBuyer({ serverName: 'localhost', extraRootsPem: CA });
    await buyer.waitFor('ready', 60_000);
    await sendRequest(buyer, seller, 'Content-Length: 2\r\n\r\n{}', 21, 2);
    seller.admit();
    const sellerEnd = seller.waitFor('responseEnd', 30_000);
    await buyer.waitFor('responseEnd', 30_000);
    const revealedPromise = seller.waitFor('revealed', 30_000);
    buyer.reveal([]);
    const revealed = await revealedPromise;
    assert.deepEqual(revealed.ranges, []);
    assert.ok((await sellerEnd).length > 0);
  } finally {
    server.close();
  }
});

test('a buyer that leaves before the answer ends is still reported to the seller with what was relayed', { skip: !binary && 'native sidecar not built' }, async () => {
  const { server, port } = await startUpstream({ stall: true });
  const seller = KeyedRelayProcess.spawn('seller', binary);
  const buyer = KeyedRelayProcess.spawn('buyer', binary);
  try {
    seller.peer.pipe(buyer.peer);
    buyer.peer.pipe(seller.peer);
    seller.startSeller({ host: '127.0.0.1', port, serverName: 'localhost', head: Buffer.from('POST /x HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer k\r\nConnection: close\r\n'), extraRootsPem: CA });
    buyer.startBuyer({ serverName: 'localhost', extraRootsPem: CA });
    await buyer.waitFor('ready', 60_000);
    await sendRequest(buyer, seller, 'Content-Length: 2\r\n\r\n{}', 21, 2);
    let answer = '';
    const answered = new Promise((resolve) => buyer.on('app', (data) => {
      answer += data.toString();
      if (answer.includes(ANSWER_WORD)) resolve();
    }));
    seller.admit();
    await answered;

    // The buyer goes away with the answer it read, and the relay drops the seller's stream.
    const exited = new Promise((resolve) => seller.once('exit', resolve));
    buyer.kill();
    seller.peer.destroy();
    const end = await seller.waitFor('responseEnd', 5_000);
    assert.ok(end.length >= answer.length, `the seller reported ${end.length} answer bytes; the buyer read ${answer.length}`);
    assert.ok(end.bytesDown > end.length);
    const exit = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(null), 5_000))]);
    assert.ok(exit, 'the seller sidecar was still running 5 s after the buyer left');
    assert.notEqual(exit.code, 0);
  } finally {
    seller.kill();
    buyer.kill();
    server.close();
    server.closeAllConnections?.();
  }
});

test('a refused request never reaches the upstream, and the buyer learns why', { skip: !binary && 'native sidecar not built' }, async () => {
  const { server, port, requests, received } = await startUpstream();
  try {
    const seller = KeyedRelayProcess.spawn('seller', binary);
    const buyer = KeyedRelayProcess.spawn('buyer', binary);
    seller.peer.pipe(buyer.peer);
    buyer.peer.pipe(seller.peer);
    seller.startSeller({ host: '127.0.0.1', port, serverName: 'localhost', head: Buffer.from('POST /x HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer k\r\nConnection: close\r\n'), extraRootsPem: CA });
    buyer.startBuyer({ serverName: 'localhost', extraRootsPem: CA });
    await buyer.waitFor('ready', 60_000);
    const body = `{"messages":"${PROMPT_WORD}","model":"other"}`;
    const headers = `Content-Length: ${body.length}\r\n\r\n`;
    await sendRequest(buyer, seller, headers + body, headers.length, 16);
    seller.refuse('the request names another model');
    await assert.rejects(buyer.waitFor('admitted', 30_000), /the seller refused the request: the request names another model/);
    await seller.waitFor('refused', 30_000);
    assert.equal(requests.length, 0);
    for (const raw of received) assert.ok(!raw.includes(PROMPT_WORD), 'the upstream got part of a refused request');
  } finally {
    server.close();
  }
});

test('the seller refuses an upstream whose certificate is not trusted', { skip: !binary && 'native sidecar not built' }, async () => {
  const { server, port } = await startUpstream();
  try {
    const seller = KeyedRelayProcess.spawn('seller', binary);
    const buyer = KeyedRelayProcess.spawn('buyer', binary);
    seller.peer.pipe(buyer.peer);
    buyer.peer.pipe(seller.peer);
    // The buyer trusts the test CA; the seller does not, so it must never write its key.
    seller.startSeller({ host: '127.0.0.1', port, serverName: 'localhost', head: Buffer.from('POST /x HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer k\r\nConnection: close\r\n') });
    buyer.startBuyer({ serverName: 'localhost', extraRootsPem: CA });
    await assert.rejects(seller.waitFor('injected', 60_000), /certificate or signature did not verify/);
    buyer.kill();
  } finally {
    server.close();
  }
});

test('a sidecar that cannot start reports its exit', async () => {
  const relay = KeyedRelayProcess.spawn('buyer', new URL('./fixtures/no-such-sidecar', import.meta.url).pathname);
  relay.startBuyer({ serverName: 'localhost' });
  const exit = await Promise.race([
    new Promise((resolve) => relay.once('exit', resolve)),
    new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
  ]);
  assert.ok(exit, 'no exit event within 2 s');
  assert.equal(exit.code, null);
  assert.match(exit.stderr, /ENOENT/);
  await assert.rejects(relay.waitFor('ready', 1000), /keyed relay ended before "ready": .*ENOENT/);
});
