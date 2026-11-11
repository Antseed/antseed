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
  const segments = pathname.slice(1).split('/');
  // A trailing slash reads the same to all of them.
  if (segments.at(-1) === '') segments.pop();
  return segments.every((segment) => PATH_SEGMENT.test(segment) && segment !== '.' && segment !== '..');
}
