import { createServer } from 'node:net';

const STRIPPED = /^(ANTSEED_|OPENAI_|ANTHROPIC_|VENICE_|FLOW_|FORK_|SANDBOX_KEY_|BASE_MAINNET_RPC_URL$|LOCAL_LLM_|TYPESAFE_)/;
export const FORBIDDEN_PORTS = new Set([6881, 6882, 8377, 3117]);

/** Environment for sandbox processes: inherited env minus AntSeed/provider secrets, with a private HOME. */
export function isolatedEnv(env, home, extra = {}) {
  const clean = Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && !STRIPPED.test(key)));
  return { ...clean, HOME: home, ANTSEED_SKIP_PLUGIN_UPDATE_CHECK: '1', ...extra };
}

export function isLoopbackHost(host) {
  return host === '127.0.0.1';
}

export function assertLocalUrl(url, label = 'URL') {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'http:' || !isLoopbackHost(endpoint.hostname) || !endpoint.port || endpoint.username || endpoint.password) {
    throw new Error(`${label} must be an owned http://127.0.0.1:<port> endpoint (got ${url})`);
  }
  return endpoint;
}

/**
 * Network options every sandbox node must use. Fails fast on anything that could
 * collide with a developer's real node (default ports, public bootstrap, all-interface binds).
 */
export function assertNetworkOptions(options) {
  for (const key of ['dhtPort', 'signalingPort']) {
    if (options.role === 'buyer' && key === 'signalingPort') continue;
    const value = options[key];
    if (value === undefined || value === null) throw new Error(`${key} must be set explicitly (use 0)`);
    if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`${key} must be a port number`);
    if (value !== 0 && (value < 1024 || FORBIDDEN_PORTS.has(value))) throw new Error(`${key}=${value} collides with a default AntSeed port`);
  }
  if (options.bindHost !== '127.0.0.1') throw new Error('bindHost must be 127.0.0.1');
  if (options.noOfficialBootstrap !== true) throw new Error('noOfficialBootstrap must be true');
  if (options.natTraversal !== false) throw new Error('natTraversal must be false');
  if (options.allowPrivateIPs !== true) throw new Error('allowPrivateIPs must be true');
  if (!Array.isArray(options.bootstrapNodes) || options.bootstrapNodes.length === 0) throw new Error('A private bootstrap node is required');
  for (const node of options.bootstrapNodes) {
    if (!isLoopbackHost(node.host) || !Number.isInteger(node.port) || node.port <= 0 || FORBIDDEN_PORTS.has(node.port)) {
      throw new Error(`Bootstrap node ${node.host}:${node.port} is not a private loopback node`);
    }
  }
  return options;
}

export async function freePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** For listeners that need a known port up front: pick a free one and retry if another process wins the race. */
export async function listenWithRetry(start, { attempts = 5, pickPort = freePort } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = await pickPort();
    if (FORBIDDEN_PORTS.has(port)) continue;
    try {
      return { port, value: await start(port) };
    } catch (error) {
      if (error?.code !== 'EADDRINUSE' && !/EADDRINUSE/.test(String(error?.message))) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error('No free port found');
}
