import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AntseedNode, toPeerId } from '@antseed/node';
import { DHTNode } from '@antseed/node/discovery';
import { resolveInstancePorts } from '../../apps/desktop/scripts/dev-instance-config.mjs';
import { GesundaiDevRouter, findGesundaiOffer } from './gesundai-router.mjs';

const args = process.argv.slice(2).filter((argument) => argument !== '--');
if (args.includes('--help')) {
  console.log('pnpm dev:levanto [desktop-instance-name] [buyer-catalog-port]\nDefaults: levanto-vpr-release 8377\nFree recommendation service; GesundAI inference is billed normally.');
  process.exit(0);
}
const instance = args[0] ?? 'levanto-vpr-release';
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(instance)) throw new Error('Use a simple instance name (letters, numbers, hyphens, underscores)');
const buyerPort = Number(args[1] ?? '8377');
if (!Number.isInteger(buyerPort) || buyerPort < 1 || buyerPort > 65535 || args.length > 2) throw new Error('Expected an instance name and optional buyer port');
const ports = resolveInstancePorts(instance);
const directory = path.join(tmpdir(), 'antseed-desktop', instance, 'fake-levanto');
await mkdir(directory, { recursive: true });
const bootstrap = new DHTNode({ peerId: toPeerId(randomBytes(20).toString('hex')), port: ports.levantoDht,
  bootstrapNodes: [], reannounceIntervalMs: 60_000, operationTimeoutMs: 5_000, allowPrivateIPs: true });
const seller = new AntseedNode({ role: 'seller', dataDir: directory, dhtPort: 0,
  relayer: { enabled: false },
  signalingPort: ports.levantoSignaling, publicAddress: `127.0.0.1:${ports.levantoSignaling}`,
  displayName: 'Levanto',
  bootstrapNodes: [{ host: '127.0.0.1', port: ports.levantoDht }], noOfficialBootstrap: true, allowPrivateIPs: true });
const router = new GesundaiDevRouter(async () => {
  const response = await fetch(`http://127.0.0.1:${buyerPort}/v1/models`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Buyer catalog unavailable (${response.status})`);
  return findGesundaiOffer(await response.json());
});
seller.registerProvider(router);
let stopping;
const stop = () => stopping ??= (async () => { await seller.stop(); await bootstrap.stop(); })();
try {
  await bootstrap.start();
  await seller.start();
  console.log(`Fake Levanto ready for desktop instance: ${instance}`);
  console.log(`Router peer: ${seller.peerId}\nLocal discovery: 127.0.0.1:${ports.levantoDht}\nP2P service: 127.0.0.1:${seller.signalingPort}`);
  console.log('Recommendation fee: $0. GesundAI inference is NOT free and uses your existing buyer payment settings.');
  console.log(`Run "pnpm dev:desktop:instance ${instance}" in another terminal. If an older buyer is running, stop it in its owning app/terminal first; a dev instance's Home button only detaches/reattaches to shared buyers.`);
  console.log('Choose "Levanto", marked Router, in the picker. Open its Models page for settings. No route or wallet configuration was changed. Ctrl+C stops this fake router.');
  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
} finally {
  await stop();
}
