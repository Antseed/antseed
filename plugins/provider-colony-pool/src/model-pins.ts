/**
 * Parse model pins, `service=repo@revision,…`: each for one of `services`, at
 * most once. With `allowDigest`, a pin may add `#<sha256>`, the digest of the
 * checkpoint's files (`modelFilesDigest`) that workers must attest. `setting`
 * and `servicesSetting` name the option and the list of services it is
 * checked against, for the errors.
 */
export function parseModelPins(
  raw: string | undefined,
  services: readonly string[],
  setting: string,
  servicesSetting: string,
  allowDigest = false,
): Map<string, string> {
  const models = new Map<string, string>();
  const shape = allowDigest ? /^[^@#\s]+@[^@#\s]+(#[0-9a-f]{64})?$/ : /^[^@#\s]+@[^@#\s]+$/;
  const expected = allowDigest ? 'service=repo@revision or service=repo@revision#sha256' : 'service=repo@revision';
  for (const entry of (raw ?? '').split(',').map((part) => part.trim()).filter(Boolean)) {
    const at = entry.indexOf('=');
    const service = at > 0 ? entry.slice(0, at).trim() : '';
    const model = at > 0 ? entry.slice(at + 1).trim() : '';
    if (!service || !shape.test(model)) throw new Error(`${setting}: "${entry}" is not ${expected}`);
    if (!services.includes(service)) throw new Error(`${setting}: ${service} is not one of ${servicesSetting}`);
    if (models.has(service)) throw new Error(`${setting}: ${service} is listed twice`);
    models.set(service, model);
  }
  return models;
}

/** A pin's `repo@revision` and, when it has one, the digest of the checkpoint's files. */
export function splitModelPin(pin: string): { model: string; sha256?: string } {
  const hash = pin.indexOf('#');
  return hash < 0 ? { model: pin } : { model: pin.slice(0, hash), sha256: pin.slice(hash + 1) };
}
