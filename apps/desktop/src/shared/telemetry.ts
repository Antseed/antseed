export const TELEMETRY_USER_ACTIONS = [
  'view_opened',
  'runtime_start',
  'runtime_stop',
  'discovery_refresh',
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
  'plugin_install',
  'api_config_copy',
  'floating_window_open',
  'floating_window_close',
] as const;

export type TelemetryUserAction = (typeof TELEMETRY_USER_ACTIONS)[number];

/**
 * Which app an app_connect / app_disconnect action refers to. A fixed local
 * taxonomy: the packaged profile names plus the Telegram bot; anything else
 * (user-added apps) reports as 'custom' so raw names never leave the device.
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
  'explore',
  'model',
  'apps',
  'tunnels',
  'chats',
  'preferences',
  'credits',
  'deposit',
  'activity',
  'rewards',
  'chat',
  'help',
  'peers',
  'connection',
  'desktop',
  'config',
  'setup',
  'floating_window',
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

/**
 * Deposit funnel steps the renderer may report. `credited` is recorded by
 * the main process when the deposit sweep lands, so the renderer cannot
 * send it; `checkout_reopened` is derived in main from a repeat
 * `checkout_opened`.
 */
export const TELEMETRY_RENDERER_DEPOSIT_STEPS = [
  'method_shown',
  'method_chosen',
  'checkout_opened',
  'checkout_abandoned',
] as const;

export type TelemetryRendererDepositStep = (typeof TELEMETRY_RENDERER_DEPOSIT_STEPS)[number];

/** Funding method family; `payment_app` is Peer Pay (Venmo, PayPal and similar). */
export const TELEMETRY_DEPOSIT_METHODS = [
  'card',
  'crypto_wallet',
  'payment_app',
  'exchange',
  'unknown',
] as const;

export type TelemetryDepositMethod = (typeof TELEMETRY_DEPOSIT_METHODS)[number];

export type DepositStepSignal = {
  step: TelemetryRendererDepositStep;
  method?: TelemetryDepositMethod;
  /** Entered amount in USDC; main reduces it to a coarse bucket. */
  amountUsdc?: number;
};
