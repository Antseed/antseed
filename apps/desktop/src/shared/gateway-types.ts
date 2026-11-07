/** Plain data the gateway IPC carries between the main process, preload and renderer. Types only. */
export type GatewayMode = 'local' | 'remote';

/** `shared`: one key for the chat and every app. `per-app`: a key per app, so the gateway shows usage per app. */
export type GatewayKeyMode = 'shared' | 'per-app';

/**
 * `anonymous`: any seller the routing policy allows (sellers see a
 * pseudonymous address). `private`: TEE sellers only, through the desktop
 * key's owner routing policy.
 */
export type GatewayPrivacyMode = 'anonymous' | 'private';

export type GatewayStatus = {
  mode: GatewayMode;
  origin: string | null;
  keyMode: GatewayKeyMode;
  /** Local: the gateway process runs. Remote: always true (nothing to run). */
  running: boolean;
  /** The gateway answered the last health probe. */
  reachable: boolean;
  /** A key is configured for the chat / shared scope. */
  hasKey: boolean;
  lastError: string | null;
};

export type GatewaySettings = {
  mode: GatewayMode;
  remoteUrl: string | null;
  keyMode: GatewayKeyMode;
  privacy: GatewayPrivacyMode;
};

/** The settings as the renderer gets them: the remote key itself never leaves the main process. */
export type GatewaySettingsView = GatewaySettings & { hasRemoteKey: boolean };

export type GatewayPrivacy = {
  mode: GatewayPrivacyMode;
  /** False with a remote gateway: its routing policy is set in its console. */
  editable: boolean;
  /** TEE-only routing is required above the key (gateway, workspace or the key's admin layer). */
  requiredAbove: boolean;
};

export type GatewayRewardsSummary = {
  /** Rewards contracts are configured on this chain. */
  available: boolean;
  address: string;
  pendingAnts: string;
  currentEpoch: number | null;
  transfersEnabled: boolean;
};

export type AgentSkillStatus = {
  id: string;
  label: string;
  detected: boolean;
  installed: boolean;
  skillsDir: string;
};

export type GatewayKeyInfo = {
  label: string | null;
  buyerAddress: string | null;
  requests: number;
  spentUsd: string | null;
  /** Today's and this month's spend against the key's caps, as the gateway enforces them. */
  limits: Record<string, { limitUsd: string | null; spentUsd: string | null }>;
};

export type GatewayEndpointInfo = {
  ok: boolean;
  baseUrl?: string;
  origin?: string;
  apiKey?: string;
  mode?: GatewayMode;
  error?: string;
};
