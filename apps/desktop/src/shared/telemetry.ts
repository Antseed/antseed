export const TELEMETRY_USER_ACTIONS = [
  'view_opened',
  'runtime_start',
  'runtime_stop',
  'chat_new',
  'chat_open',
  'chat_send',
  'chat_stop',
  'chat_retry',
  'conversation_delete',
  'conversation_rename',
  'image_generate',
  'attachment_add',
  'model_picker_open',
  'route_mode_change',
  'routing_preferences_change',
  'peer_access_change',
  'app_connect',
  'app_disconnect',
  'deposit_start',
  'withdraw_start',
  'workspace_change',
  'chat_permission_change',
  'tool_approval_decision',
  'settings_save',
  'api_config_copy',
  'gateway_console_open',
  'gateway_settings_change',
] as const;

export type TelemetryUserAction = (typeof TELEMETRY_USER_ACTIONS)[number];

/**
 * Which app an app_connect / app_disconnect action refers to. A fixed local
 * taxonomy: the packaged profile names plus the Telegram bot; anything else
 * reports as 'custom' so raw names never leave the device.
 */
export const TELEMETRY_APP_NAMES = [
  'opencode',
  'codex',
  'claude-desktop',
  'hermes',
  'droid',
  't3code',
  'pi',
  'gooeypi',
  'crush',
  'goose',
  'zed',
  'claude-code',
  'telegram',
  'custom',
] as const;

export type TelemetryAppName = (typeof TELEMETRY_APP_NAMES)[number];

export function normalizeTelemetryAppName(name: string): TelemetryAppName {
  return (TELEMETRY_APP_NAMES as readonly string[]).includes(name)
    ? (name as TelemetryAppName)
    : 'custom';
}

export const TELEMETRY_ACTION_SURFACES = [
  'home',
  'apps',
  'chats',
  'rewards',
  'preferences',
  'deposit',
  'chat',
  'help',
  'connection',
  'desktop',
  'config',
  'unknown',
] as const;

export type TelemetryActionSurface = (typeof TELEMETRY_ACTION_SURFACES)[number];

export type FirstModelShownSignal = {
  service: string;
  peerId?: string | null;
};

export type UserActionSignal = {
  action: TelemetryUserAction;
  surface: TelemetryActionSurface;
  /** Set on app_connect / app_disconnect: which app it was. */
  app?: TelemetryAppName;
};

export type TelemetryStatus = {
  available: boolean;
  enabled: boolean;
  userDisabled: boolean;
};

export type TelemetryStatusUpdateResult = (TelemetryStatus & { ok: true })
  | { ok: false; error: string };
