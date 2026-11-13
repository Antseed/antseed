import { spawn } from 'node:child_process';

type StoppableProcess = {
  pid?: number | undefined;
  stdin?: { end: () => void } | null;
  kill: (signal: NodeJS.Signals) => unknown;
};

/**
 * Asks the gateway to finish its requests and stop its buyer. On Windows a
 * signal would end it on the spot and leave the buyer running, so it is asked
 * by closing its stdin, which it watches.
 */
export function askProcessToStop(child: StoppableProcess, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32' && child.stdin) child.stdin.end();
  else child.kill('SIGTERM');
}

/** It didn't stop in time. On Windows the whole tree goes, or the buyer would outlive it. */
export function forceProcessToStop(
  child: StoppableProcess,
  platform: NodeJS.Platform = process.platform,
  killTree: (pid: number) => void = (pid) => {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).unref();
  },
): void {
  if (platform === 'win32' && child.pid) killTree(child.pid);
  else child.kill('SIGKILL');
}
