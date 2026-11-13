// Browser-safe env access: `process` only exists under Node/bundler shims.
function readEnv(name: string): string | undefined {
  return typeof process !== 'undefined' ? process.env?.[name] : undefined;
}

function normalizeDebugValue(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

let cachedDebugFilters: string[] | null = null;

export function getDebugFilters(): readonly string[] {
  if (cachedDebugFilters) {
    return cachedDebugFilters;
  }

  const raw = readEnv('ANTSEED_LOG_FILTER') ?? readEnv('ANTSEED_DEBUG_FILTER') ?? '';
  cachedDebugFilters = raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  return cachedDebugFilters;
}

function getDebugSource(line: string): string | null {
  const match = /^\s*\[([^\]]{1,48})\]/.exec(line);
  return match?.[1]?.trim().toLowerCase() ?? null;
}

export function shouldEmitDebugLine(line: string): boolean {
  const filters = getDebugFilters();
  if (filters.length === 0) {
    return true;
  }

  const normalizedLine = line.toLowerCase();
  const source = getDebugSource(line);
  return filters.some((filter) => source === filter || normalizedLine.includes(filter));
}

function shouldEmitDebug(args: unknown[]): boolean {
  return shouldEmitDebugLine(args.map((arg) => typeof arg === 'string' ? arg : String(arg)).join(' '));
}

export function isDebugEnabled(): boolean {
  // Debug lines print upstream bodies and exception text, which content-free mode keeps out.
  if (isContentFreeLogging()) return false;
  const fromAntseed = normalizeDebugValue(readEnv('ANTSEED_DEBUG'));
  if (
    fromAntseed === '1' ||
    fromAntseed === 'true' ||
    fromAntseed === 'yes' ||
    fromAntseed === 'on'
  ) {
    return true;
  }

  const fromDebug = normalizeDebugValue(readEnv('DEBUG'));
  return fromDebug === '*' || fromDebug.includes('antseed');
}

/**
 * Content-free mode (ANTSEED_CONTENT_FREE_LOGS=1): what a seller logs and stores keeps no text an
 * upstream sent about a request, which can quote it, only status codes and error codes, and debug
 * logging stays off. The TEE seller image always turns it on, so its operator can read its logs
 * and databases without seeing what buyers sent or got back.
 */
export function isContentFreeLogging(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(normalizeDebugValue(readEnv('ANTSEED_CONTENT_FREE_LOGS')));
}

/** The error code or type of an upstream JSON error (`error.code`, `error.type`, `code` or `type`), when it reads as an identifier. */
export function upstreamErrorCode(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { error, code, type } = parsed as { error?: unknown; code?: unknown; type?: unknown };
  const inner = error && typeof error === 'object' ? error as { code?: unknown; type?: unknown } : {};
  const found = [inner.code, inner.type, code, type].find((value) => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value));
  return (found as string | undefined) ?? null;
}

export function debugLog(...args: unknown[]): void {
  if (isDebugEnabled() && shouldEmitDebug(args)) {
    console.log(...args);
  }
}

export function debugWarn(...args: unknown[]): void {
  if (isDebugEnabled() && shouldEmitDebug(args)) {
    console.warn(...args);
  }
}
