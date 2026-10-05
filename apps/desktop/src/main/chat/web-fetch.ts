import { app, BrowserWindow } from 'electron';
import { type Static, Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';

const WEB_FETCH_MAX_CHARS_DEFAULT = 20_000;
const WEB_FETCH_MAX_CHARS_LIMIT = 50_000;
const WebFetchParams = Type.Object({
  url: Type.String({
    description: 'The HTTP or HTTPS URL to fetch.',
  }),
  maxChars: Type.Optional(Type.Number({
    description: `Maximum number of response characters to return (default ${WEB_FETCH_MAX_CHARS_DEFAULT}, max ${WEB_FETCH_MAX_CHARS_LIMIT}).`,
    minimum: 100,
    maximum: WEB_FETCH_MAX_CHARS_LIMIT,
  })),
});

function stripHtmlToText(input: string): string {
  return input
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/?(?:p|div|section|article|main|header|footer|aside|nav|li|ul|ol|h[1-6]|br|tr|td|th|table)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, '\'')
    .replace(/\r/g, '')
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Heuristic: HTML that looks like a JS-rendered SPA (very little visible text, React/Next.js markers).
// Accepts pre-stripped text to avoid running stripHtmlToText twice.
function looksLikeJsRequired(rawHtml: string, strippedText: string): boolean {
  // Fewer than 200 chars of visible text → likely needs JS to render
  if (strippedText.length < 200) return true;
  // Common SPA root patterns (empty root/app div)
  if (/<div[^>]+id=["'](?:root|__next|app|app-root|react-root|app-container|main-app)["'][^>]*>\s*<\/div>/i.test(rawHtml)) return true;
  return false;
}

// Persistent hidden BrowserWindow reused across web_fetch calls to avoid per-call renderer startup cost.
let _headlessBrowser: BrowserWindow | null = null;

function getHeadlessBrowser(): BrowserWindow {
  if (_headlessBrowser && !_headlessBrowser.isDestroyed()) return _headlessBrowser;
  _headlessBrowser = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      javascript: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  _headlessBrowser.on('closed', () => { _headlessBrowser = null; });
  return _headlessBrowser;
}

// Serializes headless requests so concurrent calls don't clobber each other
// (loading a new URL aborts the previous one, which would fire did-fail-load).
let _headlessQueue: Promise<void> = Promise.resolve();

// Extract readable text from a fully rendered page using Electron's built-in Chromium
function fetchWithHeadlessBrowser(url: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const result = _headlessQueue.then(() => _fetchHeadlessSerial(url, timeoutMs, signal));
  _headlessQueue = result.then(() => {}, () => {});
  return result;
}

function _fetchHeadlessSerial(url: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }

    const win = getHeadlessBrowser();
    let settled = false;

    const onFailLoad = (_event: Electron.Event, errorCode: number, errorDescription: string) => {
      settle(new Error(`Page load failed: ${errorDescription} (${String(errorCode)})`));
    };
    const onFinishLoad = () => {
      setTimeout(() => {
        win.webContents
          .executeJavaScript(`
            (function() {
              ['script','style','noscript','nav','footer','aside','iframe'].forEach(function(tag) {
                document.querySelectorAll(tag).forEach(function(el) { el.remove(); });
              });
              var title = document.title ? document.title + '\\n\\n' : '';
              var text = (document.body && document.body.innerText) ? document.body.innerText : document.documentElement.innerText || '';
              return title + text;
            })()
          `)
          .then((text: unknown) => {
            const result = typeof text === 'string' ? text.replace(/\n{2,}/g, '\n').trim() : '';
            settle(result);
          })
          .catch((err: unknown) => {
            settle(err instanceof Error ? err : new Error(String(err)));
          });
      }, 1500);
    };

    const settle = (result: string | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      win.webContents.removeListener('did-fail-load', onFailLoad);
      win.webContents.removeListener('did-finish-load', onFinishLoad);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    const timer = setTimeout(() => settle(new Error('Headless browser timed out')), timeoutMs);
    const onAbort = () => settle(new Error('web_fetch aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });

    win.webContents.once('did-fail-load', onFailLoad);
    win.webContents.once('did-finish-load', onFinishLoad);

    win.loadURL(url).catch((err: unknown) => {
      settle(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  label: 'Web Fetch',
  description:
    'Fetch a public HTTP/HTTPS URL and return the page content as readable text. Handles both static pages and JavaScript-rendered sites (news, SPAs, etc.). Always use this tool instead of curl or bash for web content.',
  parameters: WebFetchParams,
  async execute(_toolCallId, params, signal) {
    const typedParams = params as Static<typeof WebFetchParams>;
    const parsedUrl = new URL(typedParams.url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error('web_fetch only supports http:// and https:// URLs');
    }

    const requestedMaxChars =
      typeof typedParams.maxChars === 'number' ? typedParams.maxChars : WEB_FETCH_MAX_CHARS_DEFAULT;
    const maxChars = Math.max(
      100,
      Math.min(
        WEB_FETCH_MAX_CHARS_LIMIT,
        Math.floor(requestedMaxChars),
      ),
    );

    // Fast path: plain fetch first
    const timeoutSignal = AbortSignal.timeout(15_000);
    const fetchSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await fetch(parsedUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: fetchSignal,
      headers: {
        'user-agent': app.userAgentFallback ?? 'Mozilla/5.0 AI VPN/web_fetch',
        accept: 'text/html,application/json,text/plain,application/xml,text/xml,*/*;q=0.8',
      },
    });

    const contentType = response.headers.get('content-type') ?? 'unknown';
    const isHtml = /\btext\/html\b/i.test(contentType);

    let normalizedText: string;
    let usedHeadless = false;

    if (isHtml) {
      const rawText = await response.text();
      const stripped = stripHtmlToText(rawText);
      if (looksLikeJsRequired(rawText, stripped)) {
        // Fall back to headless Chromium for JS-rendered pages
        usedHeadless = true;
        try {
          normalizedText = await fetchWithHeadlessBrowser(parsedUrl.toString(), 30_000, signal ?? undefined);
          if (!normalizedText) normalizedText = stripped; // headless returned empty, use raw
        } catch {
          normalizedText = stripped; // headless failed, use raw strip
        }
      } else {
        normalizedText = stripped;
      }
    } else {
      const rawText = await response.text();
      // Clip before trim to avoid buffering megabytes unnecessarily
      normalizedText = rawText.slice(0, maxChars * 4).trim();
    }

    const truncated = normalizedText.length > maxChars;
    const body = truncated ? `${normalizedText.slice(0, maxChars)}\n\n[truncated]` : normalizedText;
    const renderedNote = usedHeadless ? ' (JS-rendered via headless browser)' : '';

    return {
      content: [
        {
          type: 'text',
          text: `URL: ${response.url}\nStatus: ${response.status} ${response.statusText}\nContent-Type: ${contentType}${renderedNote}\n\n${body}`,
        },
      ],
      details: {
        url: response.url,
        status: response.status,
        statusText: response.statusText,
        contentType,
        truncated,
        usedHeadless,
      },
    };
  },
};
