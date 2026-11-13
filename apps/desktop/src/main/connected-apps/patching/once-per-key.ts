/** Loads once for each gateway and key, so a shared key is only asked once however many apps use it. */
export function oncePerGatewayKey<E extends { origin: string; apiKey: string }, T>(load: (endpoint: E) => Promise<T>): (endpoint: E) => Promise<T> {
  const loaded = new Map<string, Promise<T>>();
  return (endpoint) => {
    const key = `${endpoint.origin}\n${endpoint.apiKey}`;
    let result = loaded.get(key);
    if (!result) {
      result = load(endpoint);
      loaded.set(key, result);
    }
    return result;
  };
}
