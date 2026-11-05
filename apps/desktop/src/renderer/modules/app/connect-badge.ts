import type { BadgeState } from '../../core/state';
import type { RuntimeProcessState } from '../../types/bridge';

/**
 * Local gateway status badge. `processes[].running` flips true the moment
 * the child process is spawned, well before the gateway (and its buyer)
 * accepts connections — so a running process that does not answer yet is
 * reported as starting, and the UI only lights up once it is reachable.
 */
export function deriveConnectBadge(
  processes: readonly RuntimeProcessState[],
  proxyOnline: boolean,
): BadgeState {
  const connect = processes.find((process) => process.mode === 'gateway') ?? null;
  if (connect?.running) {
    return proxyOnline
      ? { tone: 'active', label: 'Running' }
      : { tone: 'warn', label: 'Starting...' };
  }
  if (connect?.lastError) return { tone: 'warn', label: 'Error' };
  return { tone: 'bad', label: 'Stopped' };
}

/** The local gateway is actually usable: process running and reachable. */
export function isBuyerReady(
  processes: readonly RuntimeProcessState[],
  proxyOnline: boolean,
): boolean {
  return proxyOnline && processes.some((process) => process.mode === 'gateway' && process.running === true);
}
