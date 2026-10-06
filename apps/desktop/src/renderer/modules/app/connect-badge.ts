import type { BadgeState } from '../../core/state';
import type { RuntimeProcessState } from '../../types/bridge';

/**
 * Buyer runtime status badge. `processes[].running` flips true the moment
 * the child process is spawned, well before the buyer proxy accepts
 * connections — so a "running" process with the proxy port still closed is
 * reported as starting, and the UI only lights up once the proxy is reachable.
 */
export function deriveConnectBadge(
  processes: readonly RuntimeProcessState[],
  proxyOnline: boolean,
): BadgeState {
  const connect = processes.find((process) => process.mode === 'connect') ?? null;
  if (connect?.running) {
    return proxyOnline
      ? { tone: 'active', label: 'Running' }
      : { tone: 'warn', label: 'Starting...' };
  }
  if (connect?.lastError) return { tone: 'warn', label: 'Error' };
  return { tone: 'bad', label: 'Stopped' };
}

/** The buyer is actually usable: process running and proxy port reachable. */
export function isBuyerReady(
  processes: readonly RuntimeProcessState[],
  proxyOnline: boolean,
): boolean {
  return proxyOnline && processes.some((process) => process.mode === 'connect' && process.running === true);
}
