/** A chat sent in Private: remembered as one, or holding a reply that went out under Private. */
export function hasPrivateHistory(
  conversationId: string,
  privateConversationIds: readonly string[],
  messages: ReadonlyArray<{ meta?: { privacy?: unknown } | Record<string, unknown> }>,
): boolean {
  return privateConversationIds.includes(conversationId)
    || messages.some((message) => (message.meta as { privacy?: unknown } | undefined)?.privacy === 'private');
}
