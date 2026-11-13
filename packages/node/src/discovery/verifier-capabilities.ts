const VERIFIER_ID_RE = /^[a-z0-9][a-z0-9.-]*$/;

export function normalizeAdvertisedVerifierIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((entry) => {
    if (typeof entry !== 'string') return [];
    const id = entry.trim().toLowerCase();
    return VERIFIER_ID_RE.test(id) ? [id] : [];
  }))];
}

export function parseVerifierCapabilities(caps: unknown): { supported: string[]; default?: string } {
  const supported: string[] = [];
  let defaultId: string | undefined;
  for (const cap of Array.isArray(caps) ? caps : []) {
    if (typeof cap !== 'string') continue;
    const isDefault = cap.startsWith('verifier-default.');
    const raw = isDefault
      ? cap.slice('verifier-default.'.length)
      : cap.startsWith('verifier.') ? cap.slice('verifier.'.length) : '';
    const [id] = normalizeAdvertisedVerifierIds([raw]);
    if (!id) continue;
    if (!supported.includes(id)) supported.push(id);
    if (isDefault) defaultId = id;
  }
  return defaultId ? { supported, default: defaultId } : { supported };
}

export function advertisesTeeSupport(offer: { advertisedVerifierIds?: string[] }): boolean {
  return normalizeAdvertisedVerifierIds(offer.advertisedVerifierIds).includes('antseed-verifier');
}
