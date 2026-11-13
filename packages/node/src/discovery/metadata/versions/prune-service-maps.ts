import type { ProviderAnnouncement } from "../../peer-metadata.js";

/**
 * Copies `source`'s per-service maps under `keys` onto `target` without the
 * `omitted` services, deleting a map from `target` once nothing is left in it.
 */
export function pruneServiceMaps(
  target: ProviderAnnouncement,
  source: ProviderAnnouncement,
  omitted: ReadonlySet<string>,
  keys: ReadonlyArray<keyof ProviderAnnouncement>,
): void {
  for (const key of keys) {
    const map = source[key] as Record<string, unknown> | undefined;
    if (!map) continue;
    const kept = Object.fromEntries(Object.entries(map).filter(([service]) => !omitted.has(service)));
    if (Object.keys(kept).length > 0) (target as unknown as Record<string, unknown>)[key] = kept;
    else delete target[key];
  }
}
