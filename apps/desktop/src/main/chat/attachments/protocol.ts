/**
 * Custom Electron protocol for serving chat attachments.
 *
 * URL shape:
 *   antseed-attachment://<conversationId>/<attachmentId>
 *
 * The scheme is registered as privileged (standard + secure) so the
 * browser engine renders PDFs, HTML, SVG and images natively — no base64
 * round-tripping through IPC.
 *
 * For HTML responses we inject a Content-Security-Policy that forbids
 * script execution and external fetches. Combined with `sandbox=""` on
 * the iframe in the renderer this keeps user-authored HTML inert.
 *
 * URL parsing lives in `protocol-url.ts` so it can be unit
 * tested without the Electron runtime.
 */
import { net, protocol } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveAttachmentPath } from './store.js';
import { ATTACHMENT_SCHEME, parseAttachmentUrl } from './protocol-url.js';

export { ATTACHMENT_SCHEME, parseAttachmentUrl } from './protocol-url.js';

/**
 * Extensions whose bytes we force-serve as `text/plain; charset=utf-8`.
 *
 * Chromium refuses to render some text-ish mime types (notably
 * `text/csv`, `application/yaml`) in an iframe — the engine treats them
 * as downloadable attachments and leaves the iframe blank. Serving the
 * same bytes as `text/plain` makes Chromium display them as monospace
 * text, which is exactly what the preview modal wants.
 *
 * JSON, XML, HTML and PDF are excluded on purpose: Chromium has
 * dedicated viewers for each that are nicer than raw text.
 */
const FORCE_PLAIN_TEXT_EXTENSIONS = new Set<string>([
  '.txt', '.log', '.csv', '.tsv',
  '.md', '.markdown',
  '.yaml', '.yml', '.toml', '.ini', '.conf', '.env', '.properties',
  '.diff', '.patch',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
  '.py', '.rb', '.go', '.rs', '.java',
  '.c', '.cpp', '.h', '.hpp', '.cs',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.sql', '.css', '.scss', '.less', '.sass',
  '.vue', '.svelte', '.php', '.lua',
]);

/**
 * Must be called *before* `app.whenReady()` — Electron requires privileged
 * schemes to be registered at import time.
 */
export function registerAttachmentScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ATTACHMENT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ]);
}

/**
 * Wire the actual request handler. Must run after `app.whenReady()`.
 * `resolveRootDir` lets integration tests point at a temp attachments
 * root without touching `CHAT_DATA_DIR`; production callers leave it
 * undefined.
 */
export function installAttachmentProtocol(options: { resolveRootDir?: () => string | undefined } = {}): void {
  protocol.handle(ATTACHMENT_SCHEME, async (request) => handleAttachmentRequest(request, options.resolveRootDir?.()));
}

/**
 * Handler body, extracted for clarity and so future integration tests can
 * exercise it with a synthetic `Request` once an Electron test harness
 * exists.
 */
export async function handleAttachmentRequest(request: Request, rootDir?: string): Promise<Response> {
  const parsed = parseAttachmentUrl(request.url);
  if (!parsed) {
    return new Response('Bad request', { status: 400 });
  }
  const resolved = await resolveAttachmentPath(
    parsed.conversationId,
    parsed.attachmentId,
    rootDir ? { rootDir } : {},
  );
  if (!resolved) {
    return new Response('Not found', { status: 404 });
  }
  let response: Response;
  try {
    response = await net.fetch(pathToFileURL(resolved).toString());
  } catch {
    return new Response('Internal error', { status: 500 });
  }

  // Chromium won't render types like `text/csv` in an iframe even
  // though they're just text. Rewrite the Content-Type for known text
  // extensions so the preview modal actually shows the file contents
  // instead of a blank iframe.
  const ext = path.extname(resolved).toLowerCase();
  if (FORCE_PLAIN_TEXT_EXTENSIONS.has(ext)) {
    const body = await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.startsWith('text/html')) {
    // Re-wrap the response so we can attach a tight CSP and disable
    // sniffing. Combined with `sandbox=""` on the renderer-side iframe,
    // this keeps user-authored HTML inert.
    const body = await response.arrayBuffer();
    const headers = new Headers(response.headers);
    headers.set(
      'Content-Security-Policy',
      "default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; font-src data:",
    );
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(body, { status: response.status, headers });
  }
  // For every other response type (images, PDFs, JSON, XML, binary)
  // we forbid MIME sniffing so Chromium can't reclassify a text
  // payload as HTML and start executing scripts from it. Pass the
  // underlying ReadableStream through so the `stream: true` privilege
  // on the scheme is actually used — buffering full PDFs or video
  // files into memory just to add a header would defeat the point.
  if (!response.headers.has('X-Content-Type-Options')) {
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, { status: response.status, headers });
  }
  return response;
}
