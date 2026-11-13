/**
 * Turn an advertised service/model id into a filename-safe slug.
 *
 * Service names come off the network unauthenticated, so the slug is used to
 * build filesystem paths (evidence bundles, probe rotation logs, reference
 * files) for names an adversary controls. Characters outside
 * `[a-z0-9._-]` are replaced with `_`; names that would produce a dot-only
 * slug (`.`, `..`, `...`, …) or an empty slug are rejected outright — `..`
 * would otherwise escape the target directory.
 */
export function safeServiceSlug(service: string): string {
  const slug = service.replace(/[^a-z0-9._-]/gi, '_')
  if (slug.length === 0 || /^\.+$/.test(slug)) {
    throw new Error(`unsafe service name for filesystem use: "${service}"`)
  }
  return slug
}
