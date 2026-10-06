import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getDomainSiteMetadata } from './domain-site-metadata.js';

/**
 * User-added "custom apps" for the System Proxy (AI VPN Connected apps screen).
 *
 * A custom app is a mitm proxy profile derived from an API base URL: requests
 * to that host under the URL's path are intercepted and forwarded verbatim to
 * the buyer proxy, which already serves the standard API endpoints. Records
 * persist in `<data-dir>/custom-apps.json` and are merged with the packaged
 * profiles both for the desktop UI and for the CLI system-proxy child process.
 */

const CUSTOM_APP_NAME_PREFIX = 'custom-';
const CUSTOM_APPS_FILE = 'custom-apps.json';
const MAX_FAVICON_BYTES = 256 * 1024;
const FAVICON_TIMEOUT_MS = 4_000;

/** Intercepted when the user enters a bare domain with no path. */
export const CUSTOM_APP_DEFAULT_PATH_PREFIXES: readonly string[] = [
  '/v1/responses',
  '/v1/chat/completions',
  '/v1/messages',
];

export type CustomAppRecord = {
  name: string;
  displayName: string;
  apiUrl: string;
  host: string;
  pathPrefixes: string[];
  iconDataUri?: string;
  createdAt: number;
};

export function customAppsFilePath(dataDir: string): string {
  return path.join(dataDir, CUSTOM_APPS_FILE);
}

export function loadCustomApps(dataDir: string): CustomAppRecord[] {
  const filePath = customAppsFilePath(dataDir);
  if (!existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCustomAppRecord);
  } catch {
    return [];
  }
}

export function saveCustomApps(dataDir: string, apps: readonly CustomAppRecord[]): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(customAppsFilePath(dataDir), `${JSON.stringify(apps, null, 2)}\n`, 'utf8');
}

function isCustomAppRecord(value: unknown): value is CustomAppRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw['name'] === 'string' && raw['name'].length > 0
    && typeof raw['displayName'] === 'string'
    && typeof raw['apiUrl'] === 'string'
    && typeof raw['host'] === 'string' && raw['host'].length > 0
    && Array.isArray(raw['pathPrefixes'])
    && raw['pathPrefixes'].length > 0
    && raw['pathPrefixes'].every((prefix) => typeof prefix === 'string' && prefix.startsWith('/'))
    && (raw['iconDataUri'] === undefined || typeof raw['iconDataUri'] === 'string');
}

/**
 * Parse the user-entered API base URL into interception coordinates. Throws
 * with a user-facing message when the URL is unusable.
 */
export function deriveCustomAppTarget(apiUrl: string): {
  host: string;
  pathPrefixes: string[];
} {
  const url = parseCustomAppUrl(apiUrl);
  const enteredPath = url.pathname.replace(/\/+$/, '');
  return {
    host: url.hostname.toLowerCase(),
    pathPrefixes: enteredPath ? [enteredPath] : [...CUSTOM_APP_DEFAULT_PATH_PREFIXES],
  };
}

function parseCustomAppUrl(apiUrl: string): URL {
  const trimmed = apiUrl.trim();
  if (!trimmed) throw new Error('Enter the API URL the app calls.');
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error('That does not look like a valid URL.');
  }
  if (url.protocol !== 'https:') {
    throw new Error('Only https:// API endpoints can be intercepted.');
  }
  if (!url.hostname) throw new Error('The API URL needs a hostname.');
  return url;
}

const MODELS_PROBE_TIMEOUT_MS = 8_000;

/**
 * Endpoint suffixes stripped from the entered path when deriving the models
 * URL, so a pasted full request URL still probes the API base. Longer
 * suffixes first: `/chat/completions` must win over `/completions`.
 */
const API_ENDPOINT_SUFFIXES: readonly string[] = [
  '/chat/completions',
  '/completions',
  '/messages',
  '/responses',
  '/models',
];

export type CustomAppEndpointProbeResult =
  | { ok: true; url: string; authRequired: boolean }
  | { ok: false; url: string; detail: string };

/**
 * The models-listing URL used to verify an entered API URL. The entered path
 * is the API base (OpenRouter lives under `/api/v1`, not `/v1`); a bare
 * domain assumes the standard `/v1` base.
 */
export function customAppModelsProbeUrl(apiUrl: string): string {
  const url = parseCustomAppUrl(apiUrl);
  let base = url.pathname.replace(/\/+$/, '');
  const suffix = API_ENDPOINT_SUFFIXES.find((candidate) => base.endsWith(candidate));
  if (suffix) base = base.slice(0, base.length - suffix.length);
  return `${url.origin}${base || '/v1'}/models`;
}

/**
 * Verify the entered API URL points at an AI API by requesting its models
 * listing without credentials. Two shapes count as verified: a 2xx JSON body
 * with a `data` array (the OpenAI-style listing that Anthropic, OpenAI, and
 * OpenRouter all return), or a 401/403 JSON body with an `error` field (an
 * auth-gated AI API rejecting the key-less probe). Anything else — HTML,
 * other statuses, unreachable host — is unverified, not a hard failure:
 * callers surface it as a warning the user can override.
 */
export async function probeCustomAppModelsEndpoint(
  apiUrl: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<CustomAppEndpointProbeResult> {
  const probeUrl = customAppModelsProbeUrl(apiUrl);
  const fetchImpl = options.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('request timed out')), options.timeoutMs ?? MODELS_PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(probeUrl, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (response.ok && body !== null && Array.isArray(body['data'])) {
      return { ok: true, url: probeUrl, authRequired: false };
    }
    if ((response.status === 401 || response.status === 403) && body !== null && body['error'] !== undefined && body['error'] !== null) {
      return { ok: true, url: probeUrl, authRequired: true };
    }
    return { ok: false, url: probeUrl, detail: `did not return a model list (HTTP ${response.status})` };
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, url: probeUrl, detail: `could not be reached (${message})` };
  } finally {
    clearTimeout(timer);
  }
}

/** Stable unique profile name for a host, avoiding collisions with existing names. */
export function customAppName(host: string, takenNames: Iterable<string>): string {
  const taken = new Set(takenNames);
  const slug = host.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'app';
  const base = `${CUSTOM_APP_NAME_PREFIX}${slug}`;
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * CLI system-proxy profile JSON for a custom app (the shape parsed by
 * apps/cli/src/system-proxy/profiles.ts). Requests are forwarded verbatim —
 * the buyer proxy already speaks the standard API protocols.
 */
export function customAppToCliProfile(record: CustomAppRecord): Record<string, unknown> {
  return {
    name: record.name,
    displayName: record.displayName,
    kind: 'proxy',
    method: 'HTTPS proxy',
    domains: [record.host],
    pathPrefixes: record.pathPrefixes,
  };
}

export type CustomAppSiteMetadata = {
  title?: string;
  iconDataUri?: string;
};

/**
 * Fetch display metadata for a custom app from the domain root: the page
 * <title> and the favicon downloaded into a data URI. Best-effort — returns
 * whatever could be resolved within the timeout.
 */
export async function fetchCustomAppSiteMetadata(
  host: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<CustomAppSiteMetadata> {
  const metadata = await getDomainSiteMetadata(host, options).catch(() => null);
  const iconDataUri = metadata?.faviconUrl
    ? await downloadFaviconDataUri(metadata.faviconUrl, options)
    : undefined;
  return {
    ...(metadata?.title ? { title: metadata.title } : {}),
    ...(iconDataUri ? { iconDataUri } : {}),
  };
}

async function downloadFaviconDataUri(
  faviconUrl: string,
  options: { fetch?: typeof fetch; timeoutMs?: number },
): Promise<string | undefined> {
  const fetchImpl = options.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('favicon request timed out')), options.timeoutMs ?? FAVICON_TIMEOUT_MS);
  try {
    const response = await fetchImpl(faviconUrl, { signal: controller.signal });
    if (!response.ok) return undefined;
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (contentType && !contentType.startsWith('image/')) return undefined;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_FAVICON_BYTES) return undefined;
    return `data:${contentType || 'image/x-icon'};base64,${bytes.toString('base64')}`;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
