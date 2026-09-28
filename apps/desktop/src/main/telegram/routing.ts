export function telegramRouteModel(selection: unknown): string {
  if (!selection || typeof selection !== 'object') return '';
  const route = selection as { kind?: unknown; model?: unknown };
  if (route.kind === 'router') return 'antseed';
  return route.kind === 'model' && typeof route.model === 'string' ? route.model.trim() : '';
}

export function telegramModelPickerText(current: string, hasModels: boolean): string {
  const explanation = current === 'antseed' || current === 'levanto-auto'
    ? 'Levanto router is active for new chats; there is no fixed default model. Picking a model leaves router mode.\n\n'
    : '';
  return explanation + (hasModels
    ? 'Pick a model — it applies to this chat and becomes the default in the app:'
    : 'No models discovered yet — try again in a moment.');
}
