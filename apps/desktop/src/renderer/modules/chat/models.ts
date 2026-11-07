/**
 * Pure helpers behind the chat's model picker and gateway error notices.
 */
import type { ChatModel } from '../../types/bridge';
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
  const best = [...text].sort((left, right) => Number(right.free) - Number(left.free)
    || Number(right.toolUse) - Number(left.toolUse)
    || right.sellers - left.sellers)[0];
  return best?.id ?? null;
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

export function isFreeOffer(offer: { inputUsdPerMillion: number | null; outputUsdPerMillion: number | null }): boolean {
  return offer.inputUsdPerMillion === 0 && offer.outputUsdPerMillion === 0;
}
