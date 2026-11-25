#!/usr/bin/env node
// A stand-in sidecar for the wrapper's own tests: it speaks the stdin/stdout framing only.
// On `start` it writes FLOOD_BYTES of peer output as fast as stdout takes it, then a
// `responseEnd` event, and exits once it is told its peer is gone (an empty peer frame).
const CTL = 0;
const PEER = 1;
const frame = (channel, payload) => {
  const header = Buffer.alloc(5);
  header[0] = channel;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
};
const total = Number(process.env.FLOOD_BYTES ?? 4 * 1024 * 1024);
let buffered = Buffer.alloc(0);
process.stdin.on('data', (data) => {
  buffered = Buffer.concat([buffered, data]);
  while (buffered.length >= 5) {
    const length = buffered.readUInt32BE(1);
    if (buffered.length < 5 + length) break;
    const channel = buffered[0];
    buffered = buffered.subarray(5 + length);
    if (channel === CTL) {
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      for (let sent = 0; sent < total; sent += chunk.length) process.stdout.write(frame(PEER, chunk));
      process.stdout.write(frame(CTL, Buffer.from(JSON.stringify({ type: 'responseEnd', length: total }))));
    } else if (channel === PEER && length === 0) {
      process.stdout.write(frame(CTL, Buffer.from(JSON.stringify({ type: 'done' }))), () => process.exit(0));
    }
  }
});
