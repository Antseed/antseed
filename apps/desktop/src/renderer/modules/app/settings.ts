import type { RendererUiState, ConfigFormData } from '../../core/state';
import { notifyUiStateChanged } from '../../core/store';
import { safeNumber, safeString } from '../../core/safe';

type SettingsModuleOptions = {
  uiState: RendererUiState;
  getDashboardData: (
    endpoint: 'config',
  ) => Promise<{ ok: boolean; data: unknown; error?: string | null }>;
  updateDashboardConfig: (
    config: Record<string, unknown>,
  ) => Promise<{ ok: boolean; data: unknown; error?: string | null; status?: number | null }>;
  setDebugLogs: (enabled: boolean) => Promise<unknown>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function safeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

const DESKTOP_DEV_MODE_KEY = 'antseed.desktop.devMode';
const DESKTOP_DEFAULT_MAX_INPUT_USD_PER_MILLION = 5;
const DESKTOP_DEFAULT_MAX_OUTPUT_USD_PER_MILLION = 30;
const DESKTOP_DEFAULT_PEER_REFRESH_INTERVAL_MS = 5 * 60_000;

function loadDesktopDevMode(): boolean {
  try {
    return window.localStorage.getItem(DESKTOP_DEV_MODE_KEY) === 'true';
  } catch {
    return false;
  }
}

function persistDesktopDevMode(value: boolean): void {
  try {
    window.localStorage.setItem(DESKTOP_DEV_MODE_KEY, value ? 'true' : 'false');
  } catch {
    // Ignore storage errors and continue with in-memory state.
  }
}

export function initSettingsModule({
  uiState,
  getDashboardData,
  updateDashboardConfig,
  setDebugLogs,
}: SettingsModuleOptions) {
  let configFormPopulated = false;
  uiState.devMode = loadDesktopDevMode();
  void setDebugLogs(uiState.devMode);

  function applyConfigFormData(formData: ConfigFormData): void {
    uiState.devMode = formData.devMode;
    uiState.configFormData = { ...formData };
  }

  function populateSettingsForm(config: unknown): void {
    if (!config || configFormPopulated) return;
    configFormPopulated = true;

    const configObj = asRecord(config);
    const buyer = asRecord(configObj.buyer);
    const buyerMaxPricing = asRecord(buyer.maxPricing);
    const buyerMaxPricingDefaults = asRecord(buyerMaxPricing.defaults);
    const payments = asRecord(configObj.payments);

    const crypto = asRecord(payments.crypto);

    applyConfigFormData({
      proxyPort: safeNumber(buyer.proxyPort, 8377),
      peerRefreshIntervalMs: safeNumber(buyer.peerRefreshIntervalMs, DESKTOP_DEFAULT_PEER_REFRESH_INTERVAL_MS),
      maxInputUsdPerMillion: safeNumber(
        buyerMaxPricingDefaults.inputUsdPerMillion,
        DESKTOP_DEFAULT_MAX_INPUT_USD_PER_MILLION,
      ),
      maxOutputUsdPerMillion: safeNumber(
        buyerMaxPricingDefaults.outputUsdPerMillion,
        DESKTOP_DEFAULT_MAX_OUTPUT_USD_PER_MILLION,
      ),
      minRep: safeNumber(buyer.minPeerReputation, 0),
      disableMetadataV2Services: safeBoolean(buyer.disableMetadataV2Services, false),
      paymentMethod: safeString(payments.preferredMethod, 'crypto'),
      devMode: uiState.devMode,
      cryptoChainId: safeString(crypto.chainId, 'base-mainnet'),
    });
    notifyUiStateChanged();
  }

  async function saveConfig(formData: ConfigFormData): Promise<void> {
    uiState.configSaving = true;
    persistDesktopDevMode(formData.devMode);
    void setDebugLogs(formData.devMode);
    applyConfigFormData(formData);
    notifyUiStateChanged();

    try {
      const result = await getDashboardData('config');
      if (!result.ok) {
        uiState.configMessage = { text: 'Failed to read current config', type: 'error' };
        notifyUiStateChanged();
        return;
      }

      const resultData = (result.data ?? {}) as Record<string, unknown>;
      const currentConfig = (resultData.config as Record<string, unknown> | undefined) ?? resultData;
      const merged = {
        ...currentConfig,
        buyer: {
          ...asRecord(currentConfig.buyer),
          proxyPort: formData.proxyPort,
          peerRefreshIntervalMs: formData.peerRefreshIntervalMs,
          maxPricing: {
            defaults: {
              inputUsdPerMillion: formData.maxInputUsdPerMillion,
              outputUsdPerMillion: formData.maxOutputUsdPerMillion,
            },
          },
          minPeerReputation: formData.minRep,
          disableMetadataV2Services: formData.disableMetadataV2Services,
        },
        payments: {
          ...asRecord(currentConfig.payments),
          preferredMethod: formData.paymentMethod || 'crypto',
          crypto: {
            chainId: formData.cryptoChainId || 'base-mainnet',
          },
        },
      };

      const response = await updateDashboardConfig(merged);
      if (response.ok) {
        applyConfigFormData(formData);
        uiState.configMessage = { text: 'Configuration saved successfully', type: 'success' };
        configFormPopulated = false;
      } else {
        uiState.configMessage = {
          text: response.error ?? `Failed to save configuration${response.status ? ` (${String(response.status)})` : ''}`,
          type: 'error',
        };
      }
    } catch (err) {
      uiState.configMessage = {
        text: `Error saving: ${err instanceof Error ? err.message : String(err)}`,
        type: 'error',
      };
    } finally {
      uiState.configSaving = false;
      notifyUiStateChanged();
    }
  }

  return {
    populateSettingsForm,
    saveConfig,
  };
}
