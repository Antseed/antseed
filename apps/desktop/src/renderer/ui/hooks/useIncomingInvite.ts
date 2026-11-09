import { useEffect } from 'react';

/* The invite from the last antseed://invite link, waiting for a field to take it. */
let incomingInvite: string | null = null;
const listeners = new Set<(invite: string) => void>();

/** Hand an antseed://invite link's invite to the invite fields (prefill). */
export function receiveInviteLink(invite: string): void {
  incomingInvite = invite;
  for (const listener of listeners) listener(invite);
}

/**
 * The waiting link's invite, cleared so it fills only one field: one the user
 * then edits, cancels or leaves never comes back in a later invite field.
 */
export function takeIncomingInvite(): string | null {
  const invite = incomingInvite;
  incomingInvite = null;
  return invite;
}

/** The waiting link's invite, without taking it (an invite field's starting value). */
export function peekIncomingInvite(): string | null {
  return incomingInvite;
}

/** Calls `onInvite` with a link's invite (without taking it): the one already waiting, then each new one. */
export function useIncomingInvite(onInvite: (invite: string) => void): void {
  useEffect(() => {
    if (incomingInvite) onInvite(incomingInvite);
    listeners.add(onInvite);
    return () => { listeners.delete(onInvite); };
  }, [onInvite]);
}
