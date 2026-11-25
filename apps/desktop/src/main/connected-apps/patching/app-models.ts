/**
 * The models a connected app's config lists, and the one it starts on, from
 * its key's `/v1/models`.
 */
import { APP_MODEL_MIN_TRUST, fetchGatewayModelEntries, toGatewayModel, type GatewayModel, type GatewayModelEntry } from '../../gateway/models.js';
import { recommendAppModels, toTrustedChatModels, type ChatModel } from '../../gateway/catalog.js';
import { listedModels } from '../../../shared/chat-model-ranking.js';
import type { ConfigPatchModel, ConfigPatchTarget } from '@antseed/connected-apps/config-patch';
import type { GatewayEndpoint } from '../../gateway/service.js';
import { oncePerGatewayKey } from './once-per-key.js';

/** Text models for the apps, plus the ones worth defaulting to. */
export type AppModels = {
  models: GatewayModel[];
  /**
   * Text models the gateway serves that `models` leaves out: an app already
   * on one keeps it (`unlistedModels` in the patch target).
   */
  unlisted: GatewayModel[];
  /** Best first: works without funds (`compareDefaultModels`), and always one of `models`. */
  recommended: ChatModel[];
  /** False when the list could not be read: apps keep the one written last. True for an empty list the gateway did return. */
  modelsLoaded: boolean;
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
  const isText = (model: GatewayModel): boolean => model.type === null || model.type === 'text';
  const models = entries
    .filter((entry) => listed.has(entry.id))
    .map(toGatewayModel)
    .filter(isText);
  const ids = new Set(models.map((model) => model.id));
  return {
    models,
    unlisted: entries.filter((entry) => !listed.has(entry.id)).map(toGatewayModel).filter(isText),
    recommended: recommendAppModels(chat).filter((model) => ids.has(model.id)),
    modelsLoaded: true,
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
      const { left, ...models } = appModelsFromEntries(entries);
      if (left > 0) deps.log(`Apps leave out ${left} of ${entries.length} models: no seller at trust ${APP_MODEL_MIN_TRUST} or more serves them`);
      return models;
    } catch (err) {
      deps.log(`Could not load the gateway's models; apps get the address and key only: ${err instanceof Error ? err.message : String(err)}`);
      return { models: [], unlisted: [], recommended: [], modelsLoaded: false };
    }
  });
}

function toPatchModel(model: GatewayModel): ConfigPatchModel {
  return {
    id: model.id,
    label: model.label,
    ...(model.reasoning ? { reasoning: true } : {}),
  };
}

/** What an app's config is written for: the gateway, its key, and these models. */
export function patchTarget(endpoint: GatewayEndpoint, { models, unlisted, recommended, modelsLoaded }: AppModels): ConfigPatchTarget {
  return {
    origin: endpoint.origin,
    apiKey: endpoint.apiKey,
    models: models.map(toPatchModel),
    // A model the user picked inside the app is kept while the gateway
    // serves it, even one the list leaves out.
    unlistedModels: unlisted.map(toPatchModel),
    // An empty list the gateway returned empties the apps' lists; one it
    // couldn't return leaves them as they were.
    modelsLoaded,
    // An app without a model of its own starts on one that works without funds.
    ...(recommended[0] ? { defaultModel: recommended[0].id } : {}),
  };
}
