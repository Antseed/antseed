import { connect } from 'node:net'

/**
 * How a host (Antseed Desktop) runs `antseed gateway` as its child. Both sides
 * read these names from here, so a rename can't drift between the processes.
 */

/** Set by a parent that stops the gateway by closing its stdin. */
export const STOP_ON_STDIN_CLOSE_ENV = 'ANTSEED_GATEWAY_STOP_ON_STDIN_CLOSE'
/** The parent's process id; the gateway stops once that process is gone. */
export const PARENT_PID_ENV = 'ANTSEED_GATEWAY_PARENT_PID'

/** Whether something accepts connections on this loopback port. */
export function portInUse(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (open: boolean) => { socket.destroy(); resolvePromise(open) }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}
