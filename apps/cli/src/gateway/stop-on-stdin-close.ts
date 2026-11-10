/** Set by a parent (Antseed Desktop) that stops the gateway by closing its stdin. */
export const STOP_ON_STDIN_CLOSE_ENV = 'ANTSEED_GATEWAY_STOP_ON_STDIN_CLOSE'
/** The parent's process id; the gateway stops once that process is gone. */
export const PARENT_PID_ENV = 'ANTSEED_GATEWAY_PARENT_PID'

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
  outputs: Array<Pick<NodeJS.WritableStream, 'on'>> = [process.stdout, process.stderr],
): void {
  if (env[STOP_ON_STDIN_CLOSE_ENV] !== '1') return
  // A parent that goes away closes these pipes too. The next log line (the
  // buyer's output is relayed through them) then fails with EPIPE, and an
  // unhandled stream error would end the gateway before it stops its buyer,
  // which runs in its own process group and would be left behind.
  for (const output of outputs) output.on('error', () => {})
  stdin.once('end', stop)
  stdin.resume()
}

/** Whether a process with this id exists (EPERM: it does, owned by someone else). */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * A parent killed outright doesn't always close the stdin pipe: on Windows
 * another process can hold its write end, so the gateway never sees it end and
 * keeps its buyer running. Checking the parent's id catches that.
 */
export function stopWhenParentExits(
  stop: () => void,
  env: NodeJS.ProcessEnv = process.env,
  { exists = processExists, intervalMs = 2_000 }: { exists?: (pid: number) => boolean; intervalMs?: number } = {},
): (() => void) | null {
  const pid = Number(env[PARENT_PID_ENV])
  if (!Number.isInteger(pid) || pid <= 0) return null
  const timer = setInterval(() => {
    if (exists(pid)) return
    clearInterval(timer)
    stop()
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
