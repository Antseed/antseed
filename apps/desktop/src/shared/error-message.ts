/** The text to show for something thrown or returned as an error. */
export function asErrorMessage(error: unknown, fallback = 'Unexpected error'): string {
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' && message.trim().length > 0 ? message : fallback;
  }
  const text = String(error ?? '').trim();
  return text.length > 0 ? text : fallback;
}
