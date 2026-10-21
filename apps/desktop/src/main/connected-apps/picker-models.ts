import { curatedPickerModels, type CuratedPickerModel } from '@antseed/node/model-lineup';
import { DEFAULT_MODEL_ROUTING_PREFERENCES, type ModelRoutingPreferences } from '@antseed/node/model-routing';
import { ACTIVE_CONFIG_PATH } from '../runtime/active-config.js';
import { readConfig } from '../runtime/config-io.js';

const MODELS_TIMEOUT_MS = 5_000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

/**
 * The model list connected apps and the Telegram bot offer, the same one
 * `antseed apps connect` and the buyer's Claude Desktop route build: the AI
 * VPN selection, the starred models (`buyer.favoriteModels`), then the
 * Recommended lineup, over the buyer's text models. Empty when the buyer does
 * not answer.
 */
export async function connectedAppPickerModels(
  buyerPort: number,
  selectedModel: string | null = null,
  configPath: string = ACTIVE_CONFIG_PATH,
): Promise<CuratedPickerModel[]> {
  try {
    const response = await fetch(`http://127.0.0.1:${buyerPort}/v1/models?type=text`, {
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const body = asRecord(await response.json());
    if (!Array.isArray(body['data'])) return [];
    const buyer = asRecord((await readConfig(configPath))['buyer']);
    const stored = asRecord(buyer['routingPreferences']);
    const preferences: ModelRoutingPreferences = {
      ...DEFAULT_MODEL_ROUTING_PREFERENCES,
      ...stored,
      allowedPeerIds: stringList(stored['allowedPeerIds']),
      blockedPeerIds: stringList(stored['blockedPeerIds']),
    };
    return curatedPickerModels(body['data'], {
      preferences,
      favoriteModels: stringList(buyer['favoriteModels']),
      defaultRoutedModel: selectedModel,
    });
  } catch {
    return [];
  }
}

/**
 * Waits (bounded) until the buyer lists text models, so connected apps
 * restored at launch get the curated list instead of only Antseed Auto while
 * the buyer is still discovering sellers. Resolves false on timeout.
 */
export async function waitForBuyerTextModels(buyerPort: () => Promise<number>, timeoutMs: number, pollMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${await buyerPort()}/v1/models?type=text`, {
        signal: AbortSignal.timeout(Math.min(MODELS_TIMEOUT_MS, Math.max(1, deadline - Date.now()))),
      });
      const body = response.ok ? asRecord(await response.json()) : {};
      if (Array.isArray(body['data']) && body['data'].length > 0) return true;
    } catch {
      // Buyer not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}
