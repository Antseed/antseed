/**
 * Parse model pins, `service=repo@revision,…`: each for one of `services`, at
 * most once. `setting` and `servicesSetting` name the option and the list of
 * services it is checked against, for the errors.
 */
export function parseModelPins(
  raw: string | undefined,
  services: readonly string[],
  setting: string,
  servicesSetting: string,
): Map<string, string> {
  const models = new Map<string, string>();
  for (const entry of (raw ?? '').split(',').map((part) => part.trim()).filter(Boolean)) {
    const at = entry.indexOf('=');
    const service = at > 0 ? entry.slice(0, at).trim() : '';
    const model = at > 0 ? entry.slice(at + 1).trim() : '';
    if (!service || !/^[^@\s]+@[^@\s]+$/.test(model)) throw new Error(`${setting}: "${entry}" is not service=repo@revision`);
    if (!services.includes(service)) throw new Error(`${setting}: ${service} is not one of ${servicesSetting}`);
    if (models.has(service)) throw new Error(`${setting}: ${service} is listed twice`);
    models.set(service, model);
  }
  return models;
}
