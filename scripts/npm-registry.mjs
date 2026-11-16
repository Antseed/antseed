/**
 * Whether a package version is on the npm registry, read from the registry
 * itself. A just-published version can take a long time to be served (often
 * minutes, sometimes far longer), so callers that run right after a publish
 * wait for it rather than read it once.
 */

export async function onNpm(name, version, { fetch: fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`https://registry.npmjs.org/${name.replace('/', '%2f')}/${version}`);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`npm registry answered ${res.status} for ${name}@${version}`);
  return true;
}

/**
 * Polls until the version is on npm or `deadline` (ms since the epoch) passes.
 * Resolves true once it is served, false if it still isn't at the deadline. A
 * registry error ends the wait at once: it is not the propagation delay.
 */
export async function waitForNpm(name, version, {
  deadline = 0,
  intervalMs = 30_000,
  fetch: fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  onWait = () => {},
} = {}) {
  for (;;) {
    if (await onNpm(name, version, { fetch: fetchImpl })) return true;
    const left = deadline - now();
    if (left <= 0) return false;
    onWait(left);
    await sleep(Math.min(intervalMs, left));
  }
}
