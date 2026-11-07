/**
 * Starts the gateway unless the app has begun quitting. Starting takes several
 * awaits, so quitting can begin during any of them: it is checked before the
 * spawn, and a process that came up anyway is stopped rather than left behind.
 */
export async function startUnlessClosing(
  isClosing: () => boolean,
  start: () => Promise<unknown>,
  stop: () => Promise<unknown>,
): Promise<void> {
  if (isClosing()) throw new Error('Antseed Desktop is closing');
  await start();
  if (isClosing()) {
    await stop();
    throw new Error('Antseed Desktop is closing');
  }
}
