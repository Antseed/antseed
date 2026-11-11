/**
 * The last check before a chat or image request leaves the desktop. The
 * renderer decides whether a request needs Private when it dispatches it, but
 * a privacy switch can still be reaching the gateway, or land after that
 * decision. The request waits for the switch, then goes out only if Private
 * still holds when it needs it.
 */
export type PrivacyGate = {
  /** Settles once no privacy switch is being applied. */
  whenSettled: () => Promise<void>;
  /** The mode routing follows now; null when the app doesn't own the policy (a remote gateway). */
  mode: () => 'anonymous' | 'private' | null;
};

export const PRIVATE_REQUIRED_ERROR = 'Private turned off before this was sent, and this chat went out in Private. Switch back to Private, or start a new chat.';
export const REMOTE_PRIVATE_ERROR = 'This chat went out in Private, and a remote gateway can\'t be confirmed to keep it on TEE sellers. Start a new chat.';

/**
 * Null when the request may go out; otherwise why it may not. A request that
 * needs Private fails closed on a remote gateway (mode null): the app can't
 * confirm that gateway honors the request's TEE requirement, and an older one
 * ignores it.
 */
export async function passPrivacyGate(gate: PrivacyGate | undefined, requirePrivate: boolean): Promise<string | null> {
  if (!gate) return null;
  await gate.whenSettled();
  if (!requirePrivate) return null;
  const mode = gate.mode();
  if (mode === 'anonymous') return PRIVATE_REQUIRED_ERROR;
  return mode === null ? REMOTE_PRIVATE_ERROR : null;
}

/**
 * Whether a request on this chat must go out in Private: the caller says so,
 * or the chat holds replies sent in Private and the user hasn't chosen to
 * carry them into Anonymous. Read from the saved chat, so a caller that knows
 * nothing of its history (the Telegram bridge) can't send it under Anonymous.
 */
export function requiresPrivate(
  options: { requirePrivate?: boolean; allowPrivateHistory?: boolean },
  messages: ReadonlyArray<{ meta?: { privacy?: unknown } | null }>,
): boolean {
  if (options.requirePrivate === true) return true;
  if (options.allowPrivateHistory === true) return false;
  return messages.some((message) => message.meta?.privacy === 'private');
}
