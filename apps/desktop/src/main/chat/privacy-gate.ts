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

/** Null when the request may go out; otherwise why it may not. */
export async function passPrivacyGate(gate: PrivacyGate | undefined, requirePrivate: boolean): Promise<string | null> {
  if (!gate) return null;
  await gate.whenSettled();
  return requirePrivate && gate.mode() === 'anonymous' ? PRIVATE_REQUIRED_ERROR : null;
}
