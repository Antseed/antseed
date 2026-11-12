/**
 * Pure helpers behind the chat's model picker and gateway error notices.
 */
import type { ChatModel } from '../../types/bridge';
import { compareDefaultModels, listedModels } from '../../../shared/chat-model-ranking.js';
import { findListedModel, normalizeSellerId, splitPinnedModel } from '../../../shared/pinned-model.js';
import { isFreeOffer, type OfferPrices } from '../../../shared/offer-prices.js';

export { isFreeOffer };

const LAST_MODEL_STORAGE_KEY = 'antseed:chat:lastModel';

export function loadLastChatModel(): string | null {
  try {
    const value = window.localStorage.getItem(LAST_MODEL_STORAGE_KEY);
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export function saveLastChatModel(modelId: string): void {
  try {
    window.localStorage.setItem(LAST_MODEL_STORAGE_KEY, modelId);
  } catch {
    // Storage unavailable — the default falls back to the first text model.
  }
}

/**
 * The listed model for an id; a pinned `peer@model` finds its model. An id the
 * listing now names differently (the same model by the canonical rule) still finds it.
 */
export function findChatModel(models: ChatModel[], modelId: string | null | undefined): ChatModel | null {
  // A router's id is its `<peerId>@<serviceId>` as a whole, not a pinned model.
  return models.find((model) => model.router && model.id === modelId) ?? findListedModel(models, modelId);
}

/**
 * The picker's rows: the models the connected apps list (`listedModels`: a
 * trusted seller serves them, or one is free while no trusted seller serves a
 * free text model), plus any of `inUse` (the chat's text and image models), so
 * a chat or saved default on another model still shows it.
 */
export function pickerChatModels(models: ChatModel[], inUse: Array<string | null | undefined>): ChatModel[] {
  const kept = new Set(inUse.flatMap((id) => findChatModel(models, id) ?? []));
  const listed = new Set(listedModels(models));
  return models.filter((model) => listed.has(model) || kept.has(model));
}

/**
 * The new-chat default: the last model used while the gateway still lists it as
 * text, else one that works without funds, served by a trusted seller when
 * one is (the catalog's order isn't stable, so a first chat could otherwise
 * land on a paid model and fail).
 */
export function chooseDefaultChatModel(models: ChatModel[], lastModelId: string | null): string | null {
  const last = findChatModel(models, lastModelId);
  if (last?.type === 'text') return last.id;
  // A router picks models whose prices it doesn't list, so it is never the default.
  const text = models.filter((model) => model.type === 'text' && !model.router);
  const best = [...text].sort(compareDefaultModels)[0];
  return best?.id ?? null;
}

/**
 * Whether a first message should wait for a free model before it goes out.
 * Just after launch the gateway lists only the sellers found so far, often
 * paid ones first, so the default nobody chose can be paid and the chat would
 * keep it. Only for a device not known to hold funds, while nothing listed is free.
 */
export function shouldWaitForFreeModel(
  models: ChatModel[],
  selectedId: string | null,
  options: { chosen: boolean; funded: boolean },
): boolean {
  if (options.chosen || options.funded) return false;
  if (selectedId && findChatModel(models, selectedId)?.free) return false;
  // A default moves to any free text model, low-trust or not, so there is nothing to wait for.
  return !models.some((model) => model.type === 'text' && model.free);
}

/**
 * Whether the selection's next turn is free. A model's Free badge means some
 * seller serves it free; a pin to one seller is free only when that seller is
 * the free one we know of (any other pin's price isn't known here, so no badge).
 */
export function selectionIsFree(model: Pick<ChatModel, 'free' | 'freeSellerId'> | null | undefined, selectedId: string | null | undefined): boolean {
  if (!model?.free) return false;
  const { peerId } = splitPinnedModel(selectedId);
  if (!peerId) return true;
  return model.freeSellerId !== null && normalizeSellerId(model.freeSellerId) === normalizeSellerId(peerId);
}

/**
 * Where a funds note can send the user. A remote gateway pays from its own
 * wallet, so funding this device's signer wouldn't help it.
 */
export function fundsNoticeAction(canAddFunds: boolean, gatewayMode: 'local' | 'remote' | undefined): 'deposit' | 'console' | null {
  if (!canAddFunds) return null;
  return gatewayMode === 'remote' ? 'console' : 'deposit';
}

/**
 * The model to use once Private has narrowed the list, or null to stay. A
 * model's Free badge can come from a seller Private leaves out, so without
 * funds only a model still free here will answer. With funds the user's model
 * stays while it is listed, and a replacement isn't a free tier with a daily limit.
 * A pin goes too: the seller it names may not be one Private allows.
 */
export function chooseModelForPrivate(privateModels: ChatModel[], selectedId: string, hasFunds: boolean): string | null {
  // A router the gateway still lists under Private stays: the user chose it, and its pick is priced alone.
  if (privateModels.some((model) => model.router && model.id === selectedId)) return null;
  const { modelId: listedId, peerId } = splitPinnedModel(selectedId);
  const text = privateModels.filter((model) => model.type === 'text' && !model.router);
  const selected = findChatModel(text, listedId) ?? undefined;
  if (selected && (hasFunds || selected.free)) return peerId ? selected.id : null;
  // A stand-in shouldn't cost much: the user didn't choose it.
  const price = (model: ChatModel) => (model.inputUsdPerMillion ?? Infinity) + (model.outputUsdPerMillion ?? Infinity);
  // Priced $0 for stakers only, a model looks cheapest and then refuses anyone else.
  const payable = hasFunds ? text.filter((model) => !model.freeForStakers && price(model) > 0) : text;
  // Free (without funds) or paid (with them) first; then, as defaults do, a trusted seller's.
  const ranked = [...(payable.length > 0 ? payable : text)].sort((left, right) => (hasFunds
    ? Number(left.free) - Number(right.free)
    : Number(right.free) - Number(left.free))
    || Number(left.lowTrust === true) - Number(right.lowTrust === true)
    || Number(right.toolUse) - Number(left.toolUse)
    || (hasFunds ? price(left) - price(right) : 0)
    || right.sellers - left.sellers);
  const best = ranked[0];
  // Nothing free to move to: the note about funds says more than a silent switch.
  if (!best || (selected && !best.free)) return peerId && selected ? selected.id : null;
  return best.id === selectedId ? null : best.id;
}

/** Text and image models for the dropdown, free first, filtered by a search query on id and label. */
export function filterChatModels(
  models: ChatModel[],
  query: string,
  filter: 'free' | 'routers' | null = null,
): { routers: ChatModel[]; text: ChatModel[]; image: ChatModel[] } {
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? models.filter((model) => model.id.toLowerCase().includes(needle)
      || model.label.toLowerCase().includes(needle)
      || (model.router?.sellerName?.toLowerCase().includes(needle) ?? false))
    : models;
  const routers = filter === 'free' ? [] : matches.filter((model) => model.router);
  if (filter === 'routers') return { routers, text: [], image: [] };
  const shown = matches.filter((model) => !model.router && (filter !== 'free' || model.free));
  const freeFirst = (left: ChatModel, right: ChatModel) => Number(right.free) - Number(left.free);
  return {
    routers,
    text: shown.filter((model) => model.type === 'text').sort(freeFirst),
    image: shown.filter((model) => model.type === 'image').sort(freeFirst),
  };
}

/**
 * The calm "Add funds" notice for a stop the gateway could not pay for, or
 * null for any other stop. A key spend limit keeps its own message and drops
 * the "Add funds" action — more funds don't lift it.
 */
export function fundsNoticeFromStopReason(
  stopReason: { kind: string; message: string; errorCode?: string } | null | undefined,
): { message: string; canAddFunds: boolean } | null {
  if (stopReason?.kind !== 'payment_required') return null;
  return {
    message: stopReason.message || 'Your balance is too low for this request. Add funds and try again.',
    canAddFunds: stopReason.errorCode !== 'spend_limit_reached',
  };
}

const CUMULATIVE_IMAGE_PROMPT_HEADER = 'Generate a new image using the full conversation history below as cumulative instructions.';
const CUMULATIVE_IMAGE_PROMPT_FOOTER = 'Return only the newly generated image.';

/** A follow-up image prompt for a model that cannot edit: every earlier prompt plus the new one. */
export function buildCumulativeImagePrompt(priorPrompts: string[], currentPrompt: string): string {
  const previousPrompt = priorPrompts.at(-1) ?? '';
  if (previousPrompt.startsWith(CUMULATIVE_IMAGE_PROMPT_HEADER) && previousPrompt.endsWith(CUMULATIVE_IMAGE_PROMPT_FOOTER)) {
    const history = previousPrompt
      .slice(CUMULATIVE_IMAGE_PROMPT_HEADER.length, -CUMULATIVE_IMAGE_PROMPT_FOOTER.length)
      .trim();
    const followUpNumbers = [...history.matchAll(/^Follow-up (\d+):/gm)].map((match) => Number.parseInt(match[1] ?? '0', 10));
    const nextFollowUp = Math.max(0, ...followUpNumbers) + 1;
    return [CUMULATIVE_IMAGE_PROMPT_HEADER, '', history, `Follow-up ${String(nextFollowUp)}: ${currentPrompt}`, '', CUMULATIVE_IMAGE_PROMPT_FOOTER].join('\n');
  }
  return [
    CUMULATIVE_IMAGE_PROMPT_HEADER,
    '',
    ...[...priorPrompts, currentPrompt].map((entry, index) => `${index === 0 ? 'Initial request' : `Follow-up ${String(index)}`}: ${entry}`),
    '',
    CUMULATIVE_IMAGE_PROMPT_FOOTER,
  ].join('\n');
}

/** A per-million price: "$0.14", "$0.0050", or "?" when the seller did not advertise one. */
export function formatUsdPerMillion(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '?';
  if (value === 0) return '$0';
  return value < 0.1 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}


/**
 * "$0.14 / $0.28 per M" (input / output, per million tokens), or "Free". An
 * offer whose only charge is cache reads names that price, since "$0 / $0"
 * alone would read as free.
 */
export function formatPriceRange(offer: OfferPrices): string {
  if (isFreeOffer(offer)) return 'Free';
  const range = `${formatUsdPerMillion(offer.inputUsdPerMillion)} / ${formatUsdPerMillion(offer.outputUsdPerMillion)} per M`;
  const cachedOnly = offer.inputUsdPerMillion === 0 && offer.outputUsdPerMillion === 0;
  return cachedOnly ? `${range} · cache reads ${formatUsdPerMillion(offer.cachedInputUsdPerMillion)}` : range;
}

/** "Free", "Free for stakers" for a $0 offer only a seller's stakers get, or the price range. */
export function offerPriceLabel(
  offer: OfferPrices,
  stakersOnly: boolean,
): string {
  if (isFreeOffer(offer) && stakersOnly) return 'Free for stakers';
  return formatPriceRange(offer);
}

