export function telegramModelPickerText(current: string, hasModels: boolean): string {
  const explanation = current === 'antseed'
    ? 'A router is active for new chats; there is no fixed default model. Picking a model leaves router mode.\n\n'
    : '';
  return explanation + (hasModels
    ? 'Pick a model — it applies to this chat and becomes the default in the app:'
    : 'No models discovered yet — try again in a moment.');
}
