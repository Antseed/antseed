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

/** noVNC's web client: an explicit dir (ANTSEED_SANDBOX_NOVNC_DIR) or a distro install location. */
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

/** Strips the tailnet mount prefix (/<sandbox-name>) if the proxy kept it, so routes work either way. */
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
    ['Sandbox', info.name], ['Branch', info.branch], ['Chain', info.target], ['Upstream', info.upstream],
    ['Desktop', info.desktop], ['Shared since', info.startedAt], ['Stops after idle', `${info.idleMinutes} min`],
  ];
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHtml(info.name)} · AntSeed sandbox</title>
<style>body{font:15px -apple-system,system-ui,sans-serif;margin:32px;max-width:760px;color:#111}a.button{display:inline-block;margin:8px 12px 8px 0;padding:10px 16px;border-radius:8px;background:#111;color:#fff;text-decoration:none}a.secondary{background:#e8e8e8;color:#111}td{padding:4px 16px 4px 0}td:first-child{color:#666}</style>
<h1>AntSeed sandbox</h1>
<p><a class="button" id="desktop" href="desktop/vnc.html">Open desktop</a><a class="button secondary" href="reports/">Reports</a><a class="button secondary" href="status.json">Status</a></p>
<table>${rows.map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`).join('')}</table>
<p style="color:#666">Runs on the server against this worktree's sandbox (test wallets, sandbox chain). Tailnet only.</p>
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
 * HTTP server for one shared sandbox: landing page, noVNC client (/desktop/), the desktop stream
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
