import type {
  FirstModelShownSignal,
  TelemetryActionSurface,
  TelemetryAppName,
  TelemetryUserAction,
} from '../../../shared/telemetry.js';
import type { ViewName } from '../../ui/types.js';

const USER_ACTION_COALESCE_MS = 500;
const pendingUserActions = new Map<string, ReturnType<typeof setTimeout>>();

const VIEW_SURFACES: Record<ViewName, TelemetryActionSurface> = {
  home: 'home',
  tools: 'apps',
  rewards: 'rewards',
  preferences: 'preferences',
  deposit: 'deposit',
  chat: 'chat',
  help: 'help',
  connection: 'connection',
  desktop: 'desktop',
  config: 'config',
};

export function telemetrySurfaceForView(view: ViewName): TelemetryActionSurface {
  return VIEW_SURFACES[view];
}

export function recordUserAction(
  action: TelemetryUserAction,
  surface: TelemetryActionSurface,
  app?: TelemetryAppName,
): void {
  try {
    void window.antseedDesktop?.telemetryRecordUserAction?.({
      action,
      surface,
      ...(app !== undefined ? { app } : {}),
    }).catch(() => undefined);
  } catch {
    // Telemetry must never affect user actions.
  }
}

export function recordUserActionCoalesced(
  action: TelemetryUserAction,
  surface: TelemetryActionSurface,
): void {
  const key = `${action}:${surface}`;
  const pending = pendingUserActions.get(key);
  if (pending) clearTimeout(pending);
  pendingUserActions.set(key, setTimeout(() => {
    pendingUserActions.delete(key);
    recordUserAction(action, surface);
  }, USER_ACTION_COALESCE_MS));
}

export function recordFirstModelShown(signal: FirstModelShownSignal): void {
  try {
    void window.antseedDesktop?.telemetryRecordFirstModelShown?.(signal).catch(() => undefined);
  } catch {
    // Telemetry must never affect rendering.
  }
}
