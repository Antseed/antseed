import type { FavoriteOwner } from '../../store.js'
import type { ConsoleDeps } from '../deps.js'
import { ConsoleError, respond, type ConsoleRequest, type ConsoleRouter } from '../router.js'
import type { FavoriteModels } from '../types.js'

/** Most models one owner can star. */
const MAX_FAVORITES = 500
const MAX_MODEL_ID = 300

/** Favorites belong to the signed-in member, or to the API key of a key session; admin tokens have none. */
function favoriteOwner(request: ConsoleRequest): FavoriteOwner {
  const { principal } = request
  if (principal?.kind === 'member') return { kind: 'member', id: principal.memberId }
  if (principal?.kind === 'key') return { kind: 'key', id: principal.keyId }
  throw new ConsoleError(403, 'forbidden', 'Sign in to the console to star models')
}

function modelParam(request: ConsoleRequest): string {
  const model = (request.params['model'] ?? '').trim()
  if (!model || model.length > MAX_MODEL_ID) throw new ConsoleError(400, 'invalid_model', `Name a model id of at most ${MAX_MODEL_ID} characters`)
  return model
}

/**
 * Starred models and routers (`/favorites`), per member (or API-key
 * session), so they follow the person across browsers. Ids are the Models
 * page's: a model id, or a router's `<peerId>@<serviceId>`.
 */
export function registerFavoriteRoutes(router: ConsoleRouter, deps: ConsoleDeps): void {
  const allow = { allow: ['member', 'key'] as const }

  router.add('GET', '/favorites', async (request): Promise<FavoriteModels> => ({
    models: deps.store.listFavoriteModels(favoriteOwner(request)),
  }), allow)

  router.add('PUT', '/favorites/:model', async (request) => {
    const owner = favoriteOwner(request)
    const model = modelParam(request)
    if (deps.store.countFavoriteModels(owner) >= MAX_FAVORITES && !deps.store.listFavoriteModels(owner).includes(model)) {
      throw new ConsoleError(409, 'too_many_favorites', `You can star at most ${MAX_FAVORITES} models`)
    }
    deps.store.setFavoriteModel(owner, model, true)
    return respond(204)
  }, allow)

  router.add('DELETE', '/favorites/:model', async (request) => {
    deps.store.setFavoriteModel(favoriteOwner(request), modelParam(request), false)
    return respond(204)
  }, allow)
}
