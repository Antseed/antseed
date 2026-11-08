import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import { createReportsHandler } from './report-server.mjs';

export const NOVNC_DIRS = ['/usr/share/novnc', '/usr/local/share/novnc', '/opt/novnc'];
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.oga': 'audio/ogg',
};

/** X family that matches any host; an entry without a display number matches every display (libXau). */
const FAMILY_WILD = 0xffff;
export const XAUTH_PROTOCOL = 'MIT-MAGIC-COOKIE-1';

/**
 * One Xauthority entry for `cookie` (16 random bytes): wildcard host and no display number, so it is valid for the
 * display Xvfb picks itself (-displayfd) and the X server, x11vnc, the window manager and Electron all read the same
 * file. Format per field: 16-bit big-endian length, then the bytes; the family is a bare 16-bit value.
 */
export function xauthorityEntry(cookie) {
  if (!Buffer.isBuffer(cookie) || cookie.length !== 16) throw new Error('An MIT-MAGIC-COOKIE-1 is 16 bytes');
  const field = (bytes) => { const length = Buffer.alloc(2); length.writeUInt16BE(bytes.length); return Buffer.concat([length, bytes]); };
  const family = Buffer.alloc(2);
  family.writeUInt16BE(FAMILY_WILD);
  return Buffer.concat([family, field(Buffer.alloc(0)), field(Buffer.alloc(0)), field(Buffer.from(XAUTH_PROTOCOL)), field(cookie)]);
}

/** Xvfb on a display it picks, no TCP, and only clients holding the cookie in `authFile` (never -ac). */
export function xvfbArgs({ width, height, authFile }) {
  if (!authFile) throw new Error('Xvfb needs an -auth file');
  return ['-displayfd', '3', '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp', '-auth', authFile];
}

/**
 * Share state that is saved in call order. `write(patch)` applies the patch at once and queues a save of that snapshot
 * behind every earlier save, so an older snapshot can never land after a newer one. Its promise rejects on a failed
 * save; `flush()` waits for every queued save and throws the first error since the last flush, so fire-and-forget
 * writes (a child being recorded) still surface at the next checkpoint.
 */
export function createStateWriter(save, initial = null) {
  let state = initial;
  let queue = Promise.resolve();
  let failure = null;
  return {
    get state() { return state; },
    write(patch) {
      state = { ...state, ...patch, updatedAt: new Date().toISOString() };
      const snapshot = state;
      const saved = queue.then(() => save(snapshot));
      queue = saved.catch((error) => { failure ??= error; });
      return saved;
    },
    async flush() {
      await queue;
      if (failure) {
        const error = failure;
        failure = null;
        throw error;
      }
    },
  };
}

/**
 * Starts Xvfb and waits for the display it picked (-displayfd 3). The child is handed to `track` right after spawn,
 * before the wait, so cleanup knows it even if the host dies here. A display that never reports, a spawn error or an
 * early exit stops the child before this rejects.
 */
export async function startXvfb({ spawnXvfb, track, timeoutMs = 15_000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const child = spawnXvfb();
  track(child);
  try {
    return await new Promise((resolveDisplay, reject) => {
      let text = '';
      const timer = setTimer(() => reject(new Error(`Xvfb did not report a display within ${timeoutMs / 1000}s`)), timeoutMs);
      child.stdio[3].on('data', (chunk) => {
        text += chunk.toString();
        if (text.includes('\n')) { clearTimer(timer); resolveDisplay(`:${text.trim()}`); }
      });
      child.once('error', (error) => { clearTimer(timer); reject(error); });
      child.once('exit', (code) => { clearTimer(timer); reject(new Error(`Xvfb exited with ${code}`)); });
    });
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    throw error;
  }
}

/**
 * The host's last resort once it has stopped: exit after `delayMs` even if something keeps the event loop alive, with
 * the exit code a failure already recorded (a share.json that could not be saved), never a forced 0 over it.
 */
export function scheduleForcedExit({ proc = process, delayMs = 100, setTimer = setTimeout } = {}) {
  const timer = setTimer(() => proc.exit(proc.exitCode ?? 0), delayMs);
  timer?.unref?.();
  return timer;
}

/** Environment for an X client on the share display: the display and the cookie file. */
export function displayEnv(baseEnv, { display, authFile }) {
  return { ...baseEnv, DISPLAY: display, XAUTHORITY: authFile };
}

/**
 * Stops whatever a recorded share left: the host if it is still alive, then every recorded child and the tailscale
 * route, each only if it is still the process (or route) the share recorded. Runs when the host died too, since its
 * children outlive it. Returns false only when there is no share state, or it was already cleaned up.
 */
export async function cleanupShare(state, { isOwnedProcessAlive, killOwned, tailscaleOff, save, say = () => {} }) {
  if (!state || state.cleanedAt) return false;
  const hostAlive = Boolean(state.host && isOwnedProcessAlive(state.host));
  // A host that stopped itself has cleaned up already; the checks below then find nothing, so it needs no message.
  if (hostAlive) say('Stopping share (desktop, display, VNC, tailscale serve)');
  else if (!state.stoppedAt) say('Cleaning up after a share whose host is gone (desktop, display, VNC, tailscale serve)');
  if (hostAlive) await killOwned(state.host, { graceMs: 20_000 });
  for (const entry of state.processes ?? []) await killOwned(entry, { graceMs: 5_000 });
  if (state.tailscale?.path) tailscaleOff(state.tailscale.path);
  await save({ ...state, running: false, starting: false, cleanedAt: new Date().toISOString() });
  return true;
}

/** noVNC's web client: an explicit dir (ANTSEED_TESTBENCH_NOVNC_DIR) or a distro install location. */
export function findNoVncDir(explicit, candidates = NOVNC_DIRS) {
  for (const dir of explicit ? [explicit] : candidates) {
    if (existsSync(join(dir, 'vnc.html'))) return resolve(dir);
  }
  return null;
}

/** Tailscale state from `tailscale status --json`: whether it is up and this node's MagicDNS name. */
export function parseTailscaleStatus(status) {
  return {
    running: status?.BackendState === 'Running',
    dnsName: typeof status?.Self?.DNSName === 'string' ? status.Self.DNSName.replace(/\.$/, '') : null,
  };
}

/** True when `tailscale serve status --json` shows Funnel (public internet) on this node's HTTPS port. */
export function funnelEnabled(serveStatus, dnsName, port = 443) {
  const allow = serveStatus?.AllowFunnel ?? {};
  return Object.entries(allow).some(([hostPort, on]) => on && (hostPort === `${dnsName}:${port}` || hostPort.endsWith(`:${port}`)));
}

/** Strips the tailnet mount prefix (/<testbench-name>) if the proxy kept it, so routes work either way. */
export function stripPrefix(url, prefix) {
  if (!prefix) return url;
  if (url === prefix) return '/';
  return url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`) ? url.slice(prefix.length) || '/' : url;
}

/** WebSocket origins allowed to open the desktop stream: only pages served by this share (no cross-site hijack). */
export function originAllowed(origin, { host, forwardedHost, dnsName, port }) {
  if (!origin) return true;
  let originHost;
  try { originHost = new URL(origin).host; } catch { return false; }
  const allowed = new Set([host, forwardedHost, dnsName, `127.0.0.1:${port}`, `localhost:${port}`].filter(Boolean));
  return allowed.has(originHost);
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** Landing page: links are relative and the noVNC WebSocket path is computed from location, so any mount prefix works. */
export function landingPage(info) {
  const rows = [
    ['Testbench', info.name], ['Branch', info.branch], ['Chain', info.target], ['Upstream', info.upstream],
    ['Desktop', info.desktop], ['Shared since', info.startedAt], ['Stops after idle', `${info.idleMinutes} min`],
  ];
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHtml(info.name)} · AntSeed testbench</title>
<style>body{font:15px -apple-system,system-ui,sans-serif;margin:32px;max-width:760px;color:#111}a.button{display:inline-block;margin:8px 12px 8px 0;padding:10px 16px;border-radius:8px;background:#111;color:#fff;text-decoration:none}a.secondary{background:#e8e8e8;color:#111}td{padding:4px 16px 4px 0}td:first-child{color:#666}</style>
<h1>AntSeed testbench</h1>
<p><a class="button" id="desktop" href="desktop/vnc.html">Open desktop</a><a class="button secondary" href="reports/">Reports</a><a class="button secondary" href="status.json">Status</a></p>
<table>${rows.map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`).join('')}</table>
<p style="color:#666">Runs on the server against this worktree's testbench (test wallets, testbench chain). Tailnet only.</p>
<script>
if (!location.pathname.endsWith('/')) location.replace(location.pathname + '/' + location.search);
const base = location.pathname.replace(/[^/]*$/, '').replace(/^\\//, '');
document.getElementById('desktop').href = 'desktop/vnc.html?autoconnect=1&reconnect=1&resize=scale&path=' + encodeURIComponent(base + 'websockify');
</script>`;
}

function serveStatic(root, urlPath, request, response) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath.split('?')[0]); } catch { response.writeHead(400).end(); return; }
  let target = resolve(root, `.${decoded}`);
  if (target !== root && !target.startsWith(root + sep)) { response.writeHead(404).end('not found'); return; }
  if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'vnc.html');
  const type = STATIC_TYPES[extname(target)];
  if (!type || !existsSync(target)) { response.writeHead(404).end('not found'); return; }
  response.writeHead(200, { 'content-type': type, 'content-length': statSync(target).size, 'cache-control': 'no-cache' });
  if (request.method === 'HEAD') { response.end(); return; }
  createReadStream(target).pipe(response);
}

/**
 * HTTP server for one shared testbench: landing page, noVNC client (/desktop/), the desktop stream
 * (/websockify, a WebSocket-to-VNC bridge to the VNC unix socket), reports (/reports/) and status.
 * Binds loopback; Tailscale Serve is the only way in from the tailnet.
 */
export async function startShareServer({ prefix, noVncDir, vncSocket, vncPort, reportsDir, info, dnsName, port = 0, onActivity = () => {} }) {
  const reports = createReportsHandler(reportsDir);
  const viewers = new Set();
  let boundPort = port;
  const server = createServer((request, response) => {
    onActivity();
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
    const path = stripPrefix(request.url ?? '/', prefix);
    const pathname = path.split('?')[0];
    if (pathname === '/' || pathname === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(landingPage(info()));
      return;
    }
    if (pathname === '/status.json') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ...info(), viewers: viewers.size }, null, 2));
      return;
    }
    if (pathname === '/desktop' || pathname === '/reports') { response.writeHead(302, { location: `${pathname.slice(1)}/` }).end(); return; }
    if (pathname.startsWith('/desktop/')) { serveStatic(noVncDir, path.slice('/desktop'.length), request, response); return; }
    if (pathname.startsWith('/reports/')) { void reports(request, response, path.slice('/reports'.length)); return; }
    response.writeHead(404).end('not found');
  });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false) });
  server.on('upgrade', (request, socket, head) => {
    onActivity();
    const pathname = stripPrefix(request.url ?? '/', prefix).split('?')[0];
    const allowed = originAllowed(request.headers.origin, { host: request.headers.host, forwardedHost: request.headers['x-forwarded-host'], dnsName, port: boundPort });
    if (pathname !== '/websockify' || !allowed) {
      socket.end(`HTTP/1.1 ${allowed ? 404 : 403} ${allowed ? 'Not Found' : 'Forbidden'}\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      viewers.add(ws);
      const vnc = vncSocket ? connect({ path: vncSocket }) : connect(vncPort, '127.0.0.1');
      const closeBoth = () => { viewers.delete(ws); vnc.destroy(); if (ws.readyState <= 1) ws.close(); onActivity(); };
      ws.on('message', (data) => { onActivity(); vnc.write(data); });
      vnc.on('data', (chunk) => ws.send(chunk));
      ws.on('close', closeBoth);
      ws.on('error', closeBoth);
      vnc.on('close', closeBoth);
      vnc.on('error', closeBoth);
    });
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveListen);
  });
  boundPort = server.address().port;
  return {
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}/`,
    viewerCount: () => viewers.size,
    async stop() {
      for (const ws of viewers) ws.terminate();
      server.closeAllConnections();
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}
