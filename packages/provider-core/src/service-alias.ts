/**
 * Parse a JSON string into a service alias map (announced service → upstream model).
 * Used by all provider plugins via the ANTSEED_SERVICE_ALIAS_MAP_JSON env var.
 */
export function parseServiceAliasMap(raw: string | undefined): Record<string, string> | undefined {
  if (!raw || !raw.trim()) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ANTSEED_SERVICE_ALIAS_MAP_JSON must be valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ANTSEED_SERVICE_ALIAS_MAP_JSON must be a JSON object');
  }

  return normalizeServiceModelMap(parsed as Record<string, unknown>, 'ANTSEED_SERVICE_ALIAS_MAP_JSON');
}

/**
 * Normalize a parsed service → model JSON object: service keys are trimmed and
 * lowercased (empty keys skipped), and every value must be a non-empty string.
 * `key` names the config entry in error messages.
 */
export function normalizeServiceModelMap(
  parsed: Record<string, unknown>,
  key: string,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [serviceRaw, modelRaw] of Object.entries(parsed)) {
    const service = serviceRaw.trim().toLowerCase();
    if (!service) continue;
    if (typeof modelRaw !== 'string' || !modelRaw.trim()) {
      throw new Error(`${key} entry "${serviceRaw}" must map to a non-empty string`);
    }
    out[service] = modelRaw.trim();
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
