const DISPLAY_NAME_ICON_PATTERN = /[\p{So}\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\u200d\ufe0e\ufe0f\u20e3]/gu;

/**
 * Remove decorative emoji/icon glyphs from untrusted peer display names.
 * Human-language Unicode text is preserved; whitespace left by removed icon
 * sequences is collapsed so the normalized value is safe for persistence and
 * display throughout buyer surfaces.
 */
export function sanitizePeerDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const sanitized = value
    .replace(DISPLAY_NAME_ICON_PATTERN, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return sanitized || undefined;
}
