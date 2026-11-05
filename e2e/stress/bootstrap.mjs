// Isolated local DHT bootstrap node (no upstream bootstrap list).
// usage: node bootstrap.mjs <nodeDistDir> <port>
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [nodeDist, portArg] = process.argv.slice(2);
const { DHTNode } = await import(pathToFileURL(join(nodeDist, 'discovery', 'index.js')).href);
const { toPeerId } = await import(pathToFileURL(join(nodeDist, 'index.js')).href);
const dht = new DHTNode({
  peerId: toPeerId('0'.repeat(40)),
  port: Number(portArg),
  bootstrapNodes: [],
  reannounceIntervalMs: 60_000,
  operationTimeoutMs: 5_000,
});
await dht.start();
console.log(`BOOTSTRAP_READY ${dht.getPort()}`);
const stop = async () => { try { await dht.stop(); } catch {} process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
setInterval(() => {}, 1 << 30);
