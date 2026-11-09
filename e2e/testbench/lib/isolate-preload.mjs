// Preloaded into every cli-mode CLI process (NODE_OPTIONS=--import). Does what e2e/stress/isolate.mjs does: empties the
// official DHT bootstrap list of the node package the process runs (ANTSEED_TESTBENCH_NODE_DIST, this worktree's when
// unset), so a node can only join the testbench's private DHT even if its config were wrong.
import dgram from 'node:dgram';
import { realpathSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const nodeDist = process.env.ANTSEED_TESTBENCH_NODE_DIST ?? fileURLToPath(new URL('../../../packages/node/dist', import.meta.url));
const bootstrapModule = realpathSync(join(nodeDist, 'discovery/bootstrap.js'));
const { OFFICIAL_BOOTSTRAP_NODES } = await import(pathToFileURL(bootstrapModule).href);
OFFICIAL_BOOTSTRAP_NODES.splice(0);
if (OFFICIAL_BOOTSTRAP_NODES.length !== 0) throw new Error('could not clear official bootstrap nodes');

// A build from another tree may predate the `network` config section (bindHost, natTraversal): it would listen on every
// interface and map its ports on the real router. Force both here for any tree but this one. Fails closed: a tree
// without this module does not start.
if (realpathSync(nodeDist) !== realpathSync(fileURLToPath(new URL('../../../packages/node/dist', import.meta.url)))) {
  const { NatTraversal } = await import(pathToFileURL(realpathSync(join(nodeDist, 'p2p/nat-traversal.js'))).href);
  NatTraversal.prototype.mapPorts = async () => ({ success: false, externalIp: null, mappings: [] });
  NatTraversal.prototype.cleanup = async () => {};

  const LOOPBACK = '127.0.0.1';
  const wildcard = (host) => host === undefined || host === null || host === '' || host === '0.0.0.0' || host === '::';
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (first, ...rest) {
    if (first && typeof first === 'object') return listen.call(this, first.port !== undefined && wildcard(first.host) ? { ...first, host: LOOPBACK } : first, ...rest);
    if (typeof first !== 'number' || (typeof rest[0] === 'string' && !wildcard(rest[0]))) return listen.call(this, first, ...rest);
    return listen.call(this, first, LOOPBACK, ...(typeof rest[0] === 'string' ? rest.slice(1) : rest));
  };
  const bind = dgram.Socket.prototype.bind;
  dgram.Socket.prototype.bind = function (first, second, third) {
    if (first && typeof first === 'object') return bind.call(this, first.fd === undefined && wildcard(first.address) ? { ...first, address: LOOPBACK } : first, second);
    if (typeof first === 'function') return bind.call(this, 0, LOOPBACK, first);
    if (typeof second === 'function') return bind.call(this, first, LOOPBACK, second);
    return bind.call(this, first, wildcard(second) ? LOOPBACK : second, third);
  };
}

// An sdk-mode worker stops when the supervisor's IPC channel closes. A CLI process has no such channel: it would
// outlive a killed supervisor, so it stops itself when it is handed to a new parent.
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) process.kill(process.pid, 'SIGTERM');
}, 2000).unref();
