// Preloaded into every CLI process (NODE_OPTIONS=--import): empties the
// official DHT bootstrap list so the node only joins the harness's local DHT.
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const dist = process.env.STRESS_NODE_DIST;
if (!dist) throw new Error('STRESS_NODE_DIST not set');
const mod = await import(pathToFileURL(realpathSync(join(dist, 'discovery', 'bootstrap.js'))).href);
mod.OFFICIAL_BOOTSTRAP_NODES.splice(0);
if (mod.OFFICIAL_BOOTSTRAP_NODES.length !== 0) throw new Error('could not clear official bootstrap nodes');
