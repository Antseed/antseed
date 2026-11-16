/** RFC 3986 path characters, less `%` and `;`: upstream routers decode the one and strip what follows the other. */
const PATH_SEGMENT = /^[A-Za-z0-9\-._~!$&'()*+,=:@]+$/;

/**
 * Whether a request path can only mean what it says. The seller bills and routes
 * by the path as written, while fetch resolves dot segments and upstream routers
 * decode escapes and merge slashes, so a path any of them would read differently
 * is not served. The query string is not part of the path.
 */
export function isCanonicalRequestPath(path: string): boolean {
  const pathname = path.split('?', 1)[0]!;
  if (!pathname.startsWith('/')) return false;
  return pathname.slice(1).split('/').every((segment) => PATH_SEGMENT.test(segment) && segment !== '.' && segment !== '..');
}

/** Data path characters: those of `PATH_SEGMENT`, and `%` when it begins a well-formed escape. */
const DATA_PATH_SEGMENT = /^(?:[A-Za-z0-9\-._~!$&'()*+,=:@]|%[0-9A-Fa-f]{2})+$/;
/** How many rounds of decoding are checked: an escape of an escape (`%252F`) decodes again upstream. */
const DATA_PATH_DECODE_ROUNDS = 3;

function percentDecoded(segment: string): string {
  return segment.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** Whether a segment reads as one plain segment however many times a router decodes it. */
function isUnambiguousDataSegment(segment: string): boolean {
  if (!DATA_PATH_SEGMENT.test(segment)) return false;
  let value = segment;
  for (let round = 0; round <= DATA_PATH_DECODE_ROUNDS; round += 1) {
    // A dot segment resolves; a slash or backslash splits the segment; a control character
    // (a NUL among them) cuts it short in some servers.
    if (value === '.' || value === '..' || /[/\\\u0000-\u001f\u007f]/.test(value)) return false;
    const next = percentDecoded(value);
    if (next === value) return true;
    value = next;
  }
  return false;
}

/**
 * Whether a data operation's path can only mean what it says. A data operation's path is the
 * seller's own API, so encoded parameters (`/airports/New%20York`) and a trailing slash
 * (`/search/`) are passed on as sent. What could reach a different operation than the one billed
 * is refused: a dot segment, an encoded slash, backslash or dot segment (also encoded twice), a
 * control character, a malformed escape, a `;` and an empty segment anywhere but at the end.
 * The query string is not part of the path.
 */
export function isUnambiguousDataRequestPath(path: string): boolean {
  const pathname = path.split('?', 1)[0]!;
  if (!pathname.startsWith('/')) return false;
  const segments = pathname.slice(1).split('/');
  // One trailing slash leaves an empty last segment.
  if (segments.length > 1 && segments[segments.length - 1] === '') segments.pop();
  return segments.every(isUnambiguousDataSegment);
}
