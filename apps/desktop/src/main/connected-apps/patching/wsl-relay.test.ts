import assert from 'node:assert/strict';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import test from 'node:test';
import { stopWslRelays, syncWslRelays } from './wsl-relay.js';

const lanAddress = Object.values(networkInterfaces()).flat().find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address;

function listen(host: string, port: number, reply: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.end(reply));
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

function read(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    const socket = net.connect(port, host);
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { text += chunk; });
    socket.on('close', () => resolve(text));
    socket.on('error', reject);
  });
}

test('a relay follows the gateway when only its upstream host changes', { skip: lanAddress ? false : 'no LAN address to listen on' }, async () => {
  const first = await listen('127.0.0.1', 0, 'ipv4');
  const port = (first.address() as net.AddressInfo).port;
  const second = await listen('::1', port, 'ipv6').catch(() => null);
  if (!second) {
    first.close();
    return;
  }
  try {
    await syncWslRelays([lanAddress!], port, undefined, '127.0.0.1');
    assert.equal(await read(lanAddress!, port), 'ipv4');
    await syncWslRelays([lanAddress!], port, undefined, '::1');
    assert.equal(await read(lanAddress!, port), 'ipv6');
  } finally {
    await stopWslRelays();
    first.close();
    second.close();
  }
});

test('stopping the relays drops open connections instead of waiting on them', async () => {
  // An upstream that never hangs up, like a gateway holding a keep-alive or a stream.
  const upstream = net.createServer(() => undefined);
  await new Promise<void>((resolve) => upstream.listen(0, '::1', resolve));
  const port = (upstream.address() as net.AddressInfo).port;
  try {
    await syncWslRelays(['127.0.0.1'], port, undefined, '::1');
    const client = net.connect(port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    await Promise.race([
      stopWslRelays(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('relay shutdown waited on an open connection')), 2_000)),
    ]);
    await closed;
  } finally {
    upstream.close();
  }
});
