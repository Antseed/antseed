import type { LogEvent, RuntimeProcessState } from '../../types/bridge';
import type { RendererUiState } from '../../core/state';
import { appendLogEntry, replaceLogEntries } from '../../core/state';
import { notifyUiStateChanged } from '../../core/store';
import { deriveConnectBadge } from './connect-badge';

type RuntimeModuleOptions = {
  uiState: RendererUiState;
};


export function initRuntimeModule({ uiState }: RuntimeModuleOptions) {
  function appendLog(entry: LogEvent): void {
    appendLogEntry(uiState, entry);
    notifyUiStateChanged();
  }

  function renderLogs(entries: LogEvent[]): void {
    replaceLogEntries(uiState, entries);
    notifyUiStateChanged();
  }

  function processByMode(
    mode: string,
    processes: RuntimeProcessState[] = uiState.processes,
  ): RuntimeProcessState | null {
    return processes.find((proc) => proc.mode === mode) ?? null;
  }

  function isModeRunning(
    mode: string,
    processes: RuntimeProcessState[] = uiState.processes,
  ): boolean {
    const proc = processByMode(mode, processes);
    return Boolean(proc && proc.running);
  }

  function renderProcesses(processes: RuntimeProcessState[]): void {
    uiState.processes = Array.isArray(processes) ? processes : [];

    // The proxy-reachability probe (chat controller) refines this: a spawned
    // process whose proxy port is still closed shows as "Starting...".
    uiState.connectBadge = deriveConnectBadge(uiState.processes, uiState.chatProxyOnline);

    notifyUiStateChanged();
  }

  function renderDaemonState(
    snapshot: { exists: boolean; state: Record<string, unknown> | null } | null,
  ): void {
    uiState.daemonState = snapshot ?? null;
    notifyUiStateChanged();
  }

  function appendSystemLog(message: string): void {
    appendLog({
      mode: 'connect' as const,
      stream: 'system' as const,
      line: message,
      timestamp: Date.now(),
    });
  }

  return {
    appendLog,
    renderLogs,
    processByMode,
    isModeRunning,
    renderProcesses,
    renderDaemonState,
    appendSystemLog,
  };
}
