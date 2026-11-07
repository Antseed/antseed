// Preloaded into every cli-mode CLI process (NODE_OPTIONS=--import). Does what e2e/stress/isolate.mjs does without
// its harness-only STRESS_NODE_DIST: empties the official DHT bootstrap list, so a node can only join the testbench's
// private DHT even if its config were wrong.
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const bootstrapModule = realpathSync(fileURLToPath(new URL('../../../packages/node/dist/discovery/bootstrap.js', import.meta.url)));
const { OFFICIAL_BOOTSTRAP_NODES } = await import(pathToFileURL(bootstrapModule).href);
OFFICIAL_BOOTSTRAP_NODES.splice(0);
if (OFFICIAL_BOOTSTRAP_NODES.length !== 0) throw new Error('could not clear official bootstrap nodes');

// An sdk-mode worker stops when the supervisor's IPC channel closes. A CLI process has no such channel: it would
// outlive a killed supervisor, so it stops itself when it is handed to a new parent.
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) process.kill(process.pid, 'SIGTERM');
}, 2000).unref();
