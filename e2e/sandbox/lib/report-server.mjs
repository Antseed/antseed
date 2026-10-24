import { createReadStream, existsSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.jsonl': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.webm': 'video/webm', '.zip': 'application/zip',
};

/** Resolves a URL path inside `root`, or null if it escapes it or is not a known report file type. */
export function reportFilePath(root, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath.split('?')[0]); } catch { return null; }
  const target = resolve(root, `.${decoded}`);
  if (target !== resolve(root) && !target.startsWith(resolve(root) + sep)) return null;
  return target;
}

/**
 * Request handler for a sandbox's reports/ (index of runs, HTML reports, screenshots, video with range
 * requests). `urlPath` is the path relative to the reports root; links and redirects are relative so the
 * handler also works mounted under a prefix (sandbox share).
 */
export function createReportsHandler(dir) {
  const root = resolve(dir);
  return async (request, response, urlPath = request.url ?? '/') => {
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
    const target = reportFilePath(root, urlPath);
    if (!target || !existsSync(target)) { response.writeHead(404).end('not found'); return; }
    const stat = statSync(target);
    if (stat.isDirectory()) {
      const pathname = urlPath.split('?')[0];
      if (!pathname.endsWith('/')) { response.writeHead(302, { location: `${pathname.split('/').pop()}/` }).end(); return; }
      if (existsSync(join(target, 'index.html')) && target !== root) { response.writeHead(302, { location: 'index.html' }).end(); return; }
      const runs = (await readdir(target)).filter((name) => !name.startsWith('.')).sort().reverse();
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><meta charset="utf-8"><title>Sandbox reports</title><style>body{font:14px -apple-system,system-ui,sans-serif;margin:24px}</style><h1>Sandbox reports</h1><ul>${runs.map((name) => `<li><a href="${encodeURI(name)}/">${name.replace(/[<>&]/g, '')}</a></li>`).join('')}</ul>`);
      return;
    }
    const type = TYPES[extname(target)];
    if (!type) { response.writeHead(403).end('forbidden'); return; }
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      if (start > end || start >= stat.size) { response.writeHead(416, { 'content-range': `bytes */${stat.size}` }).end(); return; }
      response.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'accept-ranges': 'bytes' });
      if (request.method === 'HEAD') { response.end(); return; }
      createReadStream(target, { start, end }).pipe(response);
      return;
    }
    response.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'accept-ranges': 'bytes' });
    if (request.method === 'HEAD') { response.end(); return; }
    createReadStream(target).pipe(response);
  };
}

/** Read-only static server for a sandbox's reports/. */
export async function serveReports({ dir, host = '127.0.0.1', port = 0 }) {
  const handle = createReportsHandler(dir);
  const server = createServer((request, response) => void handle(request, response));
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolveListen);
  });
  const address = server.address();
  return {
    host,
    port: address.port,
    url: `http://${host.includes(':') ? `[${host}]` : host}:${address.port}/`,
    async stop() {
      server.closeAllConnections();
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}
