// ── Telegram /model picker ──
// Pure helpers behind the bot's /model keyboard: Antseed Auto first, then the
// curated list every Antseed model picker offers. A pick applies only to the
// Telegram chat; the AI VPN selection in the app is never changed from here.

import { sameCanonicalModel } from '@antseed/node/model-identity';

/** The buyer's `antseed` model: follows the model selected in the AI VPN. */
export const ANTSEED_AUTO_MODEL = 'antseed';
export const ANTSEED_AUTO_LABEL = 'Antseed Auto';

export type TelegramModelOption = {
  id: string;
  label: string;
  provider?: string;
  favorite?: boolean;
};

type PickerModel = { model: string; label: string; provider?: string; favorite?: boolean };

/** Antseed Auto, then the curated models (minus any duplicate of Auto), capped at `limit` buttons. */
export function telegramModelOptions(models: readonly PickerModel[], limit: number): TelegramModelOption[] {
  const options: TelegramModelOption[] = [{ id: ANTSEED_AUTO_MODEL, label: ANTSEED_AUTO_LABEL }];
  for (const model of models) {
    if (options.length >= limit) break;
    if (model.model.trim().toLowerCase() === ANTSEED_AUTO_MODEL) continue;
    options.push({
      id: model.model,
      label: model.label,
      ...(model.provider ? { provider: model.provider } : {}),
      ...(model.favorite ? { favorite: true } : {}),
    });
  }
  return options;
}

/** Whether `option` is the model the Telegram chat currently uses. No model yet means Auto. */
export function isCurrentTelegramModel(option: TelegramModelOption, current: string | null | undefined): boolean {
  const normalized = current?.trim().toLowerCase() ?? '';
  if (option.id === ANTSEED_AUTO_MODEL) return normalized === '' || normalized === ANTSEED_AUTO_MODEL;
  return normalized !== '' && normalized !== ANTSEED_AUTO_MODEL && sameCanonicalModel(option.id, normalized);
}

export function telegramModelButtonText(option: TelegramModelOption, current: string | null | undefined): string {
  return [
    isCurrentTelegramModel(option, current) ? '✓ ' : '',
    option.favorite ? '★ ' : '',
    option.label,
  ].join('');
}

export function telegramModelPickerText(hasModels: boolean): string {
  return [
    'Pick a model for this Telegram chat.',
    `${ANTSEED_AUTO_LABEL} uses the model selected in the AI VPN, and follows it when you change it there.`,
    hasModels ? '' : 'No other models discovered yet — try again in a moment.',
  ].filter(Boolean).join('\n');
}
