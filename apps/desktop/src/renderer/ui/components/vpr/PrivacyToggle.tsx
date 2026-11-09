import { useEffect, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Tick02Icon } from '@hugeicons/core-free-icons';
import type { ChatModel, GatewayPrivacyMode } from '../../../types/bridge';
import { defaultStorage } from '../../../modules/app/local-storage-flag';
import { privacyResource, requestPrivacyMode, usePrivacySwitch } from '../../../modules/app/vpr-resources';
import { useCachedResource } from '../../../modules/app/cached-resource';
import styles from './PrivacyToggle.module.scss';

/** Private mode routes to TEE sellers only, so pickers list only models with one. */
export function usePrivateMode(): boolean {
  return useCachedResource(privacyResource).data?.mode === 'private';
}

export function modelsForPrivacy(models: ChatModel[], privateMode: boolean): ChatModel[] {
  return privateMode ? models.filter((model) => model.tee) : models;
}

const OPTIONS: Array<{ mode: GatewayPrivacyMode; label: string; iconClass: string; hint: string }> = [
  {
    mode: 'anonymous',
    label: 'Anonymous',
    iconClass: styles.iconAnonymous,
    hint: 'Providers never see your name or email, only an anonymous address. Every model is open to you.',
  },
  {
    mode: 'private',
    label: 'Private',
    iconClass: styles.iconPrivate,
    hint: 'Providers can’t read your chats. Your app checks each one runs on sealed hardware (a TEE) before sending anything. Fewer models for now.',
  },
];

export type PrivacyControl = {
  current: GatewayPrivacyMode;
  disabled: boolean;
  error: string | null;
  hint: string | undefined;
  select: (mode: GatewayPrivacyMode) => void;
};

/**
 * Anonymous / Private: Private adds "TEE sellers only" to the desktop key's
 * routing policy, so the chat and every app on that key route to TEE sellers.
 */
export function usePrivacyControl(onChange?: (mode: GatewayPrivacyMode) => void): PrivacyControl {
  const privacy = useCachedResource(privacyResource);
  const { error } = usePrivacySwitch();
  const current = privacy.data?.mode ?? 'anonymous';
  const editable = privacy.data?.editable !== false;
  const locked = privacy.data?.requiredAbove === true;

  function select(mode: GatewayPrivacyMode): void {
    if (mode === current || !editable || locked) return;
    onChange?.(mode);
    void requestPrivacyMode(mode);
  }

  const hint = error
    ?? (!editable ? 'Your remote gateway sets its routing policy in its console.'
      : locked ? 'Your gateway requires TEE sellers for this key.'
        : OPTIONS.find((option) => option.mode === current)?.hint);

  return { current, disabled: !editable || locked, error, hint, select };
}

export function PrivacyToggle({ control, size = 'regular' }: { control: PrivacyControl; size?: 'regular' | 'small' }) {
  return (
    <div className={`${styles.segment}${size === 'small' ? ` ${styles.segmentSmall}` : ''}`} role="radiogroup" aria-label="Privacy">
      {OPTIONS.map((option) => {
        const active = control.current === option.mode;
        const activeClass = option.mode === 'private' ? styles.activePrivate : styles.activeAnonymous;
        return (
          <button
            key={option.mode}
            type="button"
            role="radio"
            aria-checked={active}
            className={`${styles.option}${active ? ` ${activeClass}` : ''}`}
            disabled={control.disabled}
            onClick={() => control.select(option.mode)}
            title={option.hint}
          >
            <span className={`${styles.icon} ${option.iconClass}`} aria-hidden="true" />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

const NOTE_SEEN_KEY = 'antseed:privacyNoteSeen';
const REMINDER_MS = 6_000;

type NoteSeen = Partial<Record<GatewayPrivacyMode, boolean>>;

function readNoteSeen(): NoteSeen {
  try {
    const raw = defaultStorage()?.getItem(NOTE_SEEN_KEY);
    return raw ? JSON.parse(raw) as NoteSeen : {};
  } catch {
    return {};
  }
}

function saveNoteSeen(seen: NoteSeen): void {
  try {
    defaultStorage()?.setItem(NOTE_SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Storage unavailable; the note shows again next launch.
  }
}

/**
 * The mode's explanation (or a save error) as a glass note with the mode's
 * badge. "Got it" hides it per mode; after that it comes back for a few
 * seconds whenever `switches` counts a new switch.
 */
export function PrivacyNote({ control, className, switches = 0, plain = false }: {
  control: PrivacyControl;
  className?: string;
  /** Bumped by the caller on each switch the user makes. */
  switches?: number;
  /** No badge or mode name: for a spot that already shows the toggle. */
  plain?: boolean;
}) {
  const [seen, setSeen] = useState(readNoteSeen);
  const [reminding, setReminding] = useState(false);
  useEffect(() => {
    if (switches === 0) return;
    setReminding(true);
    const timer = window.setTimeout(() => setReminding(false), REMINDER_MS);
    return () => window.clearTimeout(timer);
  }, [switches]);

  if (!control.hint) return null;
  const isPrivate = control.current === 'private';
  const dismissed = seen[control.current] === true;
  if (dismissed && !reminding && !control.error) return null;

  function dismiss(): void {
    const next = { ...seen, [control.current]: true };
    setSeen(next);
    setReminding(false);
    saveNoteSeen(next);
  }

  return (
    <div
      className={`${styles.note}${isPrivate ? ` ${styles.notePrivate}` : ''}${plain ? ` ${styles.notePlain}` : ''}${dismissed && !control.error ? ` ${styles.noteReminder}` : ''}${className ? ` ${className}` : ''}`}
    >
      {plain ? null : <span className={`${styles.badge} ${isPrivate ? styles.badgePrivate : styles.badgeAnonymous}`} aria-hidden="true" />}
      <p className={styles.noteText} role={control.error ? 'alert' : undefined}>
        {plain ? null : <><b>{isPrivate ? 'Private.' : 'Anonymous.'}</b>{' '}</>}
        {control.hint}
      </p>
      {!control.error && !dismissed ? (
        <button
          type="button"
          className={styles.noteDismiss}
          onClick={dismiss}
          title="Hide this note. It comes back for a moment when you switch."
        >
          <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2.2} />
          Got it
        </button>
      ) : null}
    </div>
  );
}
