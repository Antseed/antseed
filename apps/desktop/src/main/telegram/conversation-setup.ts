/**
 * The conversation a Telegram turn runs in: the saved one while it still
 * exists, or a new one on the bot's model, saved as the active conversation.
 * Every step can wait, and the turn may be cancelled meanwhile (/new, /stop)
 * while a newer turn sets up its own conversation. So after each wait the
 * turn must still own the slot, and only then is anything saved: a cancelled
 * turn never replaces the conversation a newer turn chose. Null when it was
 * cancelled.
 */
export async function setUpTurnConversation(steps: {
  /** The saved active conversation, read when the turn starts. */
  active: () => string | null | undefined;
  exists: (conversationId: string) => Promise<boolean>;
  /** Run for a saved conversation that still exists (moves it off a model no longer listed). */
  prepareExisting: (conversationId: string) => Promise<void>;
  resolveModel: () => Promise<string | null>;
  create: (model: string) => Promise<{ id: string }>;
  /** Saves the new conversation as the active one. */
  saveActive: (conversationId: string) => Promise<void>;
  /** Whether the turn still holds the slot and wasn't cancelled. */
  owns: () => boolean;
  /** Notes a conversation as one of the bot's. */
  remember: (conversationId: string) => void;
}): Promise<string | null> {
  const active = steps.active();
  // The chat may have been deleted in the app since the last message.
  if (active && await steps.exists(active)) {
    if (!steps.owns()) return null;
    await steps.prepareExisting(active);
    if (!steps.owns()) return null;
    steps.remember(active);
    return active;
  }
  if (!steps.owns()) return null;
  const model = await steps.resolveModel();
  if (!steps.owns()) return null;
  if (!model) throw new Error('no models are available yet. Try again in a moment.');
  const conversation = await steps.create(model);
  // Still the bot's, so the app lists it as such, even when this turn was cancelled.
  steps.remember(conversation.id);
  if (!steps.owns()) return null;
  await steps.saveActive(conversation.id);
  return steps.owns() ? conversation.id : null;
}
