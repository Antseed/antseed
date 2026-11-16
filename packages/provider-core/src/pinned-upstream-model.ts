import type { SerializedHttpRequest } from '@antseed/node';

// Keyed by request object rather than a header, so a buyer cannot set it.
const pinnedModels = new WeakMap<SerializedHttpRequest, string>();

/**
 * Copy of `request` whose upstream model is fixed to `model`. The relay still
 * selects upstreams (fallbacks, cooldowns) by the requested service, but sends
 * `model` upstream verbatim instead of the service's alias for that upstream.
 */
export function withPinnedUpstreamModel(
  request: SerializedHttpRequest,
  model: string,
): SerializedHttpRequest {
  const pinned = { ...request };
  pinnedModels.set(pinned, model);
  return pinned;
}

/** The upstream model pinned by {@link withPinnedUpstreamModel}, if any. */
export function pinnedUpstreamModel(request: SerializedHttpRequest): string | undefined {
  return pinnedModels.get(request);
}
