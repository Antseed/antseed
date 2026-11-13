import type { BadgeState } from '../../core/state';
import type { GatewayStatus, RuntimeProcessState } from '../../types/bridge';

/**
 * Gateway status badge. `processes[].running` flips true the moment the local
 * child process is spawned, well before the gateway (and its buyer) accepts
 * connections, so a running process that does not answer yet is reported as
 * starting. A remote gateway has no local process: only its health counts.
 */
export function deriveConnectBadge(
  processes: readonly RuntimeProcessState[],
  gateway: Pick<GatewayStatus, 'mode' | 'reachable'> | null,
): BadgeState {
  if (gateway?.mode === 'remote') {
    return gateway.reachable
      ? { tone: 'active', label: 'Running' }
      : { tone: 'warn', label: 'Unreachable' };
  }
  const local = processes.find((process) => process.mode === 'gateway') ?? null;
  if (local?.running) {
    return gateway?.reachable
      ? { tone: 'active', label: 'Running' }
      : { tone: 'warn', label: 'Starting...' };
  }
  if (local?.lastError) return { tone: 'warn', label: 'Error' };
  return { tone: 'bad', label: 'Stopped' };
}
