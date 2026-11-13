import type { ChatModel } from '../../types/bridge';
import { useCachedResource } from '../../modules/app/cached-resource';
import { privacyResource } from '../../modules/app/vpr-resources';

/** Private mode routes to TEE sellers only, so pickers list only models with one. */
export function usePrivateMode(): boolean {
  return useCachedResource(privacyResource).data?.mode === 'private';
}

/**
 * Private mode routes to TEE sellers only, so pickers list only models with
 * one. Routers stay: the gateway lists only those the key's policy allows,
 * TEE requirement included.
 */
export function modelsForPrivacy(models: ChatModel[], privateMode: boolean): ChatModel[] {
  return privateMode ? models.filter((model) => model.tee || model.router) : models;
}
