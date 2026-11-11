/**
 * The models a connected app's config lists, and the one it starts on, from
 * its key's `/v1/models`.
 */
import { APP_MODEL_MIN_TRUST, fetchGatewayModelEntries, toGatewayModel, type GatewayModel, type GatewayModelEntry } from '../../gateway/models.js';
import { recommendAppModels, toTrustedChatModels, type ChatModel } from '../../gateway/catalog.js';
import { listedModels } from '../../../shared/chat-model-ranking.js';
import type { GatewayEndpoint } from '../../gateway/service.js';
import { oncePerGatewayKey } from './once-per-key.js';

/** Text models for the apps, plus the ones worth defaulting to. */
export type AppModels = {
  models: GatewayModel[];
  /** Best first: works without funds (`compareDefaultModels`), and always one of `models`. */
  recommended: ChatModel[];
};

/**
 * The apps' text models: those a trusted seller serves, and while no trusted
 * seller serves a free one, the free ones low-trust sellers serve, so an app
 * without funds still starts on a model that answers (`listedModels`, as the
 * chat picker lists them).
 */
export function appModelsFromEntries(entries: GatewayModelEntry[]): AppModels & { left: number } {
  const chat = toTrustedChatModels(entries);
  const listed = new Set(listedModels(chat).map((model) => model.id));
  const models = entries
    .filter((entry) => listed.has(entry.id))
    .map(toGatewayModel)
    .filter((model) => model.type === null || model.type === 'text');
  const ids = new Set(models.map((model) => model.id));
  return {
    models,
    recommended: recommendAppModels(chat).filter((model) => ids.has(model.id)),
    left: entries.filter((entry) => !listed.has(entry.id)).length,
  };
}

export type AppModelDeps = {
  fetchEntries: typeof fetchGatewayModelEntries;
  log: (line: string) => void;
};

/**
 * Loads each gateway key's models once for one round of patches. `freshModels`
 * reads past the minute-long cache, which a read under an old routing policy
 * may have filled.
 */
export function appModelsReader(options: { freshModels?: boolean }, deps: AppModelDeps): (endpoint: GatewayEndpoint) => Promise<AppModels> {
  return oncePerGatewayKey(async (endpoint: GatewayEndpoint): Promise<AppModels> => {
    try {
      const entries = await deps.fetchEntries(endpoint, { force: options.freshModels === true });
      const { models, recommended, left } = appModelsFromEntries(entries);
      if (left > 0) deps.log(`Apps leave out ${left} of ${entries.length} models: no seller at trust ${APP_MODEL_MIN_TRUST} or more serves them`);
      return { models, recommended };
    } catch (err) {
      deps.log(`Could not load the gateway's models; apps get the address and key only: ${err instanceof Error ? err.message : String(err)}`);
      return { models: [], recommended: [] };
    }
  });
}
