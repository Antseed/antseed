/** Whether a process with this id exists (a signal-0 probe; EPERM: it does, owned by someone else). */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
