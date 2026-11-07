/** Set by a parent (Antseed Desktop) that stops the gateway by closing its stdin. */
export const STOP_ON_STDIN_CLOSE_ENV = 'ANTSEED_GATEWAY_STOP_ON_STDIN_CLOSE'

/**
 * A way to ask for a clean stop that works on every OS. On Windows a signal
 * ends a process outright, so the gateway couldn't finish its requests or stop
 * its buyer, which would carry on with the old wallet. It also means a parent
 * that crashes takes the gateway with it.
 */
export function stopWhenStdinCloses(
  stdin: Pick<NodeJS.ReadableStream, 'once' | 'resume'>,
  stop: () => void,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env[STOP_ON_STDIN_CLOSE_ENV] !== '1') return
  stdin.once('end', stop)
  stdin.resume()
}
