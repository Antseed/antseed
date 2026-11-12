import { useEffect, useState, useSyncExternalStore } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Tick02Icon } from '@hugeicons/core-free-icons';
import { Button, Modal, Segmented } from '@antseed/ui';
import type { ChatModel, GatewayPrivacyMode } from '../../../types/bridge';
import type { PrivacySwitchChoice } from '../../../modules/chat/controller';
import { defaultStorage } from '../../../modules/app/local-storage-flag';
import { appsResource, privacyResource, requestPrivacyMode, usePrivacySwitch } from '../../../modules/app/vpr-resources';
import { useCachedResource } from '../../../modules/app/cached-resource';
import { useUiSelector } from '../../hooks/useUiSelector';
import { hasPrivateHistory } from '../../../modules/chat/private-history';
import styles from './PrivacyToggle.module.scss';


const PRIVACY_SCOPE_HINT = 'This applies to the chat and every app connected through Antseed.';

type PrivacyOption = { mode: GatewayPrivacyMode; label: string; iconClass: string; description: string };

const OPTIONS: PrivacyOption[] = [
  {
    mode: 'anonymous',
    label: 'Anonymous',
    iconClass: styles.iconAnonymous,
    description: 'Providers never see your name or email, only an anonymous address. Every model is open to you.',
  },
  {
    mode: 'private',
    label: 'Private',
    iconClass: styles.iconPrivate,
    description: 'Providers can’t read your chats. Your app checks each one runs on sealed hardware (a TEE) before sending anything. Fewer models for now. Some pass requests on to a model provider outside a TEE; models marked “TEE end to end” are sealed all the way.',
  },
];

function optionHint(option: PrivacyOption): string {
  return `${option.description} ${PRIVACY_SCOPE_HINT}`;
}

/** While a switch reaches the chat's key and each connected app's, it isn't in effect yet. */
export function pendingHint(mode: GatewayPrivacyMode): string {
  return mode === 'private'
    ? 'Turning on Private for the chat and every connected app… Until it’s on, apps may still reach any seller.'
    : 'Switching to Anonymous for the chat and every connected app…';
}

export type PrivacyControl = {
  current: GatewayPrivacyMode;
  /**
   * The mode being applied to the chat's key and every connected app's, not
   * yet in effect everywhere; null once the gateway has confirmed it.
   */
  pending: GatewayPrivacyMode | null;
  disabled: boolean;
  error: string | null;
  hint: string | undefined;
  select: (mode: GatewayPrivacyMode) => void;
};

// ---------------------------------------------------------------------------
// A switch that needs the user's say first: the one-time explainer, or a chat
// whose private history would go to non-TEE sellers. One dialog, shown by
// <PrivacySwitchDialog /> in the shell, whichever toggle asked.

type PendingSwitch = {
  mode: GatewayPrivacyMode;
  explain: boolean;
  privateHistory: boolean;
  /** The chat open when the warning was raised. */
  conversationId: string | null;
  apply: (choice: PrivacySwitchChoice) => void;
};

let pendingSwitch: PendingSwitch | null = null;
const pendingListeners = new Set<() => void>();

function setPendingSwitch(next: PendingSwitch | null): void {
  pendingSwitch = next;
  for (const listener of pendingListeners) listener();
}

function usePendingSwitch(): PendingSwitch | null {
  return useSyncExternalStore(
    (listener) => { pendingListeners.add(listener); return () => { pendingListeners.delete(listener); }; },
    () => pendingSwitch,
    () => pendingSwitch,
  );
}

const SWITCH_EXPLAINED_KEY = 'antseed:privacySwitchExplained';

function switchExplained(): boolean {
  try {
    return defaultStorage()?.getItem(SWITCH_EXPLAINED_KEY) === '1';
  } catch {
    return false;
  }
}

function markSwitchExplained(): void {
  try {
    defaultStorage()?.setItem(SWITCH_EXPLAINED_KEY, '1');
  } catch {
    // Storage unavailable; the explainer shows again next time.
  }
}

/** A prompt in the open chat went out under Private (whether or not it got an answer). */
function useOpenChatHasPrivateHistory(): boolean {
  return useUiSelector((state) => state.chatActiveConversation !== null
    && hasPrivateHistory(state.chatActiveConversation, state.chatPrivateConversationIds, state.chatMessages as Array<{ meta?: { privacy?: unknown } }>));
}

/**
 * Anonymous / Private: Private adds "TEE sellers only" to the desktop key's
 * routing policy, so the chat and every app on that key route to TEE sellers.
 * The open chat stays open. The first switch explains this, and moving a chat
 * with private history into Anonymous asks first.
 */
export function usePrivacyControl(onChange?: (mode: GatewayPrivacyMode, choice: PrivacySwitchChoice) => void): PrivacyControl {
  const privacy = useCachedResource(privacyResource);
  const { error, switching, target } = usePrivacySwitch();
  const privateHistory = useOpenChatHasPrivateHistory();
  const openChat = useUiSelector((state) => state.chatActiveConversation);
  const current = privacy.data?.mode ?? 'anonymous';
  const editable = privacy.data?.editable !== false;
  const locked = privacy.data?.requiredAbove === true;

  function select(mode: GatewayPrivacyMode): void {
    if (mode === current || !editable || locked) return;
    const apply = (choice: PrivacySwitchChoice): void => {
      onChange?.(mode, choice);
      void requestPrivacyMode(mode);
    };
    const explain = !switchExplained();
    const leaving = mode === 'anonymous' && privateHistory;
    if (!explain && !leaving) {
      apply({});
      return;
    }
    setPendingSwitch({ mode, explain, privateHistory: leaving, conversationId: openChat, apply });
  }

  // Pending until the gateway confirms, error or not: a failed write whose
  // readback also failed leaves the mode unknown, never in effect.
  const pending = switching && target ? target : null;
  const currentOption = OPTIONS.find((option) => option.mode === current);
  const hint = error
    ?? (pending ? pendingHint(pending)
      : !editable ? 'Your remote gateway sets its routing policy in its console.'
      : locked ? 'Your gateway requires TEE sellers for this key.'
        : currentOption && optionHint(currentOption));

  // Until the gateway has said which mode it is in, there is nothing to switch.
  return { current, pending, disabled: !privacy.data || !editable || locked, error, hint, select };
}

export function PrivacyToggle({ control, size = 'regular' }: { control: PrivacyControl; size?: 'regular' | 'small' }) {
  return (
    <Segmented<GatewayPrivacyMode>
      bare
      label="Privacy"
      value={control.current}
      onChange={control.select}
      className={`${styles.segment}${size === 'small' ? ` ${styles.segmentSmall}` : ''}`}
      // A mode still being applied shows as pending, not in effect.
      itemClassName={(mode, selected) => `${styles.option}${selected
        ? control.pending === mode ? ` ${styles.pending}` : ` ${mode === 'private' ? styles.activePrivate : styles.activeAnonymous}`
        : ''}`}
      options={OPTIONS.map((option) => ({
        value: option.mode,
        disabled: control.disabled,
        title: optionHint(option),
        label: (
          <>
            <span className={`${styles.icon} ${option.iconClass}`} aria-hidden="true" />
            {option.label}
          </>
        ),
      }))}
    />
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
  // A mode still being applied isn't in effect: no Private styling until it is,
  // and the note stays up so the user knows apps aren't covered yet.
  const pending = control.pending !== null;
  const isPrivate = control.current === 'private' && !pending;
  const dismissed = seen[control.current] === true;
  if (dismissed && !reminding && !control.error && !pending) return null;

  function dismiss(): void {
    const next = { ...seen, [control.current]: true };
    setSeen(next);
    setReminding(false);
    saveNoteSeen(next);
  }

  return (
    <div
      aria-busy={pending || undefined}
      className={`${styles.note}${isPrivate ? ` ${styles.notePrivate}` : ''}${plain ? ` ${styles.notePlain}` : ''}${dismissed && !control.error && !pending ? ` ${styles.noteReminder}` : ''}${className ? ` ${className}` : ''}`}
    >
      {plain ? null : <span className={`${styles.badge} ${isPrivate ? styles.badgePrivate : styles.badgeAnonymous}`} aria-hidden="true" />}
      <p className={styles.noteText} role={control.error ? 'alert' : undefined}>
        {plain || pending ? null : <><b>{isPrivate ? 'Private.' : 'Anonymous.'}</b>{' '}</>}
        {control.hint}
      </p>
      {!control.error && !dismissed && !pending ? (
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

/** Names of the apps connected through the gateway, for saying what a switch reaches. */
function useConnectedAppNames(): string[] {
  const apps = useCachedResource(appsResource).data ?? [];
  return apps.filter((app) => app.connected).map((app) => app.displayName);
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The dialog a switch waits on; rendered once, in the shell. */
export function PrivacySwitchDialog() {
  const pending = usePendingSwitch();
  const apps = useConnectedAppNames();
  const openChat = useUiSelector((state) => state.chatActiveConversation);
  if (!pending) return null;
  // The warning was about one chat: once another is open, it no longer applies.
  const chatChanged = pending.privateHistory && pending.conversationId !== openChat;
  const toPrivate = pending.mode === 'private';
  const label = toPrivate ? 'Private' : 'Anonymous';

  function finish(choice: PrivacySwitchChoice | null): void {
    const current = pending;
    setPendingSwitch(null);
    if (!current || !choice) return;
    if (current.explain) markSwitchExplained();
    if (current.privateHistory && current.conversationId !== openChat) return;
    current.apply(current.privateHistory ? { ...choice, conversationId: current.conversationId } : choice);
  }

  const reach = apps.length > 0
    ? `the chat and ${listNames(apps)}`
    : 'the chat and every app you connect through Antseed';

  const footer = pending.privateHistory ? (
    <>
      <Button variant="ghost" onClick={() => finish(null)}>Cancel</Button>
      <Button variant="outline" disabled={chatChanged} onClick={() => finish({ keepPrivateHistory: true })}>Keep this chat</Button>
      <Button variant="primary" disabled={chatChanged} onClick={() => finish({ newChat: true })}>Start a new chat</Button>
    </>
  ) : (
    <>
      <Button variant="ghost" onClick={() => finish(null)}>Cancel</Button>
      <Button variant="primary" onClick={() => finish({})}>Switch to {label}</Button>
    </>
  );

  return (
    <Modal isOpen onClose={() => finish(null)} title={`Switch to ${label}?`} size="sm" footer={footer}>
      <div className={styles.switchDialog}>
        {pending.explain ? (
          <>
            <p>{OPTIONS.find((option) => option.mode === pending.mode)?.description}</p>
            <p>
              This is a setting for your whole gateway, not just this chat: it changes where requests from {reach} are sent.
              {toPrivate ? ' If your model has no seller on sealed hardware, the chat moves to one that does.' : ''}
            </p>
          </>
        ) : null}
        {pending.privateHistory ? (
          <p>
            <b>This chat was sent in Private.</b> Carrying on here in Anonymous sends its history to providers that don’t run in a TEE.
            Start a new chat to keep it private.
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * A line in the conversation where its replies changed between Anonymous and
 * Private, or where the next one will, after a switch.
 */
export function PrivacyDivider({ mode, model, pending = false }: { mode: GatewayPrivacyMode; model?: string | null; pending?: boolean }) {
  const isPrivate = mode === 'private';
  const what = isPrivate
    ? 'only sellers on sealed hardware (TEE) answer'
    : 'any seller can answer; they see an anonymous address';
  return (
    <div className={`${styles.divider}${isPrivate ? ` ${styles.dividerPrivate}` : ''}`} role="note">
      <span className={styles.dividerRule} aria-hidden="true" />
      <span className={styles.dividerText}>
        <span className={`${styles.badge} ${isPrivate ? styles.badgePrivate : styles.badgeAnonymous}`} aria-hidden="true" />
        {pending ? `Switched to ${isPrivate ? 'Private' : 'Anonymous'}` : `${isPrivate ? 'Private' : 'Anonymous'} from here`}
        {` · ${what}`}
        {pending && model ? ` · now ${model}` : ''}
        {pending ? ' · your connected apps too' : ''}
      </span>
      <span className={styles.dividerRule} aria-hidden="true" />
    </div>
  );
}
