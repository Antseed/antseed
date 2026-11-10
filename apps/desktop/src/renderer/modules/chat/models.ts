/**
 * Pure helpers behind the chat's model picker and gateway error notices.
 */
import type { ChatModel } from '../../types/bridge';
import { compareDefaultModels } from '../../../shared/chat-model-ranking.js';
import { splitPinnedModel } from '../../../shared/pinned-model.js';

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

/** The listed model for an id; a pinned `peer@model` finds its model. */
export function findChatModel(models: ChatModel[], modelId: string | null | undefined): ChatModel | null {
  if (!modelId) return null;
  const { modelId: listedId } = splitPinnedModel(modelId);
  return models.find((model) => model.id === listedId) ?? null;
}

/**
 * The new-chat default: the last model used while the gateway still lists it as
 * text, else one that works without funds (the catalog's order isn't stable, so
 * a first chat could otherwise land on a paid model and fail).
 */
export function chooseDefaultChatModel(models: ChatModel[], lastModelId: string | null): string | null {
  const last = findChatModel(models, lastModelId);
  if (last?.type === 'text') return last.id;
  const text = models.filter((model) => model.type === 'text');
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
  return !models.some((model) => model.type === 'text' && model.free);
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
  const { modelId: listedId, peerId } = splitPinnedModel(selectedId);
  const text = privateModels.filter((model) => model.type === 'text');
  const selected = text.find((model) => model.id === listedId);
  if (selected && (hasFunds || selected.free)) return peerId ? selected.id : null;
  // A stand-in shouldn't cost much: the user didn't choose it.
  const price = (model: ChatModel) => (model.inputUsdPerMillion ?? Infinity) + (model.outputUsdPerMillion ?? Infinity);
  // Priced $0 for stakers only, a model looks cheapest and then refuses anyone else.
  const payable = hasFunds ? text.filter((model) => !model.freeForStakers && price(model) > 0) : text;
  const ranked = [...(payable.length > 0 ? payable : text)].sort((left, right) => (hasFunds
    ? Number(left.free) - Number(right.free)
    : Number(right.free) - Number(left.free))
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
  freeOnly = false,
): { text: ChatModel[]; image: ChatModel[] } {
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? models.filter((model) => model.id.toLowerCase().includes(needle) || model.label.toLowerCase().includes(needle))
    : models;
  const shown = freeOnly ? matches.filter((model) => model.free) : matches;
  const freeFirst = (left: ChatModel, right: ChatModel) => Number(right.free) - Number(left.free);
  return {
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

/** "$0.14 / $0.28 per M" (input / output, per million tokens), or "Free". */
export function formatPriceRange(offer: { inputUsdPerMillion: number | null; outputUsdPerMillion: number | null }): string {
  if (isFreeOffer(offer)) return 'Free';
  return `${formatUsdPerMillion(offer.inputUsdPerMillion)} / ${formatUsdPerMillion(offer.outputUsdPerMillion)} per M`;
}

/** "Free", "Free for stakers" for a $0 offer only a seller's stakers get, or the price range. */
export function offerPriceLabel(
  offer: { inputUsdPerMillion: number | null; outputUsdPerMillion: number | null },
  stakersOnly: boolean,
): string {
  if (isFreeOffer(offer) && stakersOnly) return 'Free for stakers';
  return formatPriceRange(offer);
}

export function isFreeOffer(offer: { inputUsdPerMillion: number | null; outputUsdPerMillion: number | null }): boolean {
  return offer.inputUsdPerMillion === 0 && offer.outputUsdPerMillion === 0;
}
