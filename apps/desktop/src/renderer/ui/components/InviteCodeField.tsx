import { useEffect, useState } from 'react';
import { Button, TextField } from '@antseed/ui';
import { shortAddress } from '../../core/format';
import type { InviteCheckResult } from '../../types/bridge';
import styles from './InviteCodeField.module.scss';

export const INVITE_PROMPT = 'Have an invite? Get 12 weeks of bonus $ANTS';

/* The invite from the last antseed://invite link, waiting for a field to show it. */
let incomingInvite: string | null = null;
const listeners = new Set<(invite: string) => void>();

/** Hand an antseed://invite link's invite to the invite fields (prefill). */
export function receiveInviteLink(invite: string): void {
  incomingInvite = invite;
  for (const listener of listeners) listener(invite);
}

function useIncomingInvite(onInvite: (invite: string) => void): void {
  useEffect(() => {
    if (incomingInvite) onInvite(incomingInvite);
    listeners.add(onInvite);
    return () => { listeners.delete(onInvite); };
  }, [onInvite]);
}

type Props = {
  /** Called after an invite was saved as pending. */
  onRedeemed?: (result: Extract<InviteCheckResult, { ok: true }>) => void;
};

/**
 * Paste field for an invite code or link. Checks it with `previewInvite`
 * (through IPC) as it is entered, then saves it as pending: the buyer daemon
 * carries it until the first settlement binds it.
 */
export function InviteCodeField({ onRedeemed }: Props) {
  // Start from a link that arrived before this field mounted (navigating to it).
  const [value, setValue] = useState(() => incomingInvite ?? '');
  const [check, setCheck] = useState<InviteCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  useIncomingInvite(setValue);

  useEffect(() => {
    const trimmed = value.trim();
    setCheck(null);
    if (!trimmed) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setChecking(true);
      void window.antseedDesktop?.referralCheckInvite?.(trimmed)
        .then((result) => { if (!cancelled) setCheck(result); })
        .catch((error: unknown) => { if (!cancelled) setCheck({ ok: false, reason: error instanceof Error ? error.message : String(error) }); })
        .finally(() => { if (!cancelled) setChecking(false); });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [value]);

  const redeem = async () => {
    const redeemInvite = window.antseedDesktop?.referralRedeemInvite;
    if (!redeemInvite || !check?.ok) return;
    setSaving(true);
    try {
      const result = await redeemInvite(value.trim());
      if (result.ok) {
        incomingInvite = null;
        setSaved(result.referrer);
        onRedeemed?.(result);
      } else {
        setCheck(result);
      }
    } finally {
      setSaving(false);
    }
  };

  // Once saved, the field gives way to a confirmation: the invite is pending
  // and nothing else can be entered until it binds.
  if (saved) {
    return (
      <p className={styles.saved} role="status">
        Invite from {shortAddress(saved)} saved. Binds with your first paid or free request.
      </p>
    );
  }

  let hint = INVITE_PROMPT;
  if (checking) hint = 'Checking…';
  else if (check?.ok) hint = `Invite from ${shortAddress(check.referrer)}.`;

  return (
    <div className={styles.row}>
      <TextField
        className={styles.field}
        name="invite-code"
        label="Invite code"
        placeholder="Paste an invite or link"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        error={check && !check.ok ? check.reason : undefined}
        hint={hint}
      />
      <Button size="sm" onClick={() => void redeem()} disabled={!check?.ok || saving} aria-busy={saving}>
        {saving ? 'Saving…' : 'Use invite'}
      </Button>
    </div>
  );
}
