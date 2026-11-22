#!/usr/bin/env node
// A stand-in sidecar for the wrapper's own tests: it speaks the stdin/stdout framing only.
// On `start` it writes BURST_BYTES of peer output. On its first peer frame it writes the
// last of its output (TAIL_FRAMES short peer frames, then the `responseEnd` and `done`
// events) and exits as soon as stdout has taken it, whether or not anyone has read it.
const CTL = 0;
const PEER = 1;
const frame = (channel, payload) => {
  const header = Buffer.alloc(5);
  header[0] = channel;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
};
const burst = Number(process.env.BURST_BYTES ?? 2 * 1024 * 1024);
const tailFrames = Number(process.env.TAIL_FRAMES ?? 16);
const tailFrame = Buffer.alloc(64, 0x62);
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
      for (let sent = 0; sent < burst; sent += chunk.length) process.stdout.write(frame(PEER, chunk));
    } else if (channel === PEER) {
      for (let sent = 0; sent < tailFrames; sent += 1) process.stdout.write(frame(PEER, tailFrame));
      const length = burst + tailFrames * tailFrame.length;
      process.stdout.write(frame(CTL, Buffer.from(JSON.stringify({ type: 'responseEnd', length }))));
      process.stdout.write(frame(CTL, Buffer.from(JSON.stringify({ type: 'done' }))), () => process.exit(0));
    }
  }
});
