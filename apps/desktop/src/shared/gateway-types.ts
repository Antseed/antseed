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
  /**
   * Local: not answering yet because it is still starting (waiting for the
   * router plugin, its buyer, or the first start of this launch). False once a
   * start has failed: that is `lastError`.
   */
  starting: boolean;
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

/** What the renderer may change. */
export type GatewaySettingsPatch = Partial<Pick<GatewaySettings, 'mode' | 'remoteUrl' | 'keyMode'>> & {
  remoteApiKey?: string | null;
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
  /**
   * A remote gateway's wallet, whose chain this app can't confirm: no amount
   * is read (it could come from the wrong chain), so `available` is false and
   * the gateway's own Rewards page has the figures.
   */
  remoteChainUnverified?: true;
};

/** Retail vs paid over the models with a retail price to compare against. */
export type GatewaySavings = {
  /** The same tokens at retail reference prices. */
  retailUsd: number;
  paidUsd: number;
  /** retailUsd − paidUsd, never below zero. */
  savedUsd: number;
  /** Requests on models with a retail match. */
  matchedRequests: number;
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

export type GatewayEndpointInfo =
  | { ok: true; baseUrl: string; origin: string; apiKey: string; mode: GatewayMode; error?: never }
  | { ok: false; error: string };

export type GatewayActionResult = { ok: boolean; error?: string };
export type GatewaySettingsResult = GatewayActionResult & { settings?: GatewaySettingsView };
export type GatewayPrivacyResult = GatewayActionResult & { privacy?: GatewayPrivacy };
export type GatewayRewardsResult = GatewayActionResult & { rewards?: GatewayRewardsSummary };
export type AgentSkillsResult = GatewayActionResult & { targets?: AgentSkillStatus[] };
/** Opening an agent: its desktop app, or a terminal running its CLI. */
export type OpenAgentResult = GatewayActionResult & { via?: 'app' | 'terminal' };
