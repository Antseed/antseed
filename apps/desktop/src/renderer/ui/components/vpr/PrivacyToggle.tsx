import type { ChatModel, GatewayPrivacyMode } from '../../../types/bridge';
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
    hint: 'Any seller your routing policy allows. Sellers see a pseudonymous address, never your name or email.',
  },
  {
    mode: 'private',
    label: 'Private',
    iconClass: styles.iconPrivate,
    hint: 'TEE sellers only: requests go only to sellers that advertise TEE attestation. Fewer models and sellers.',
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

export function PrivacyToggle({ control }: { control: PrivacyControl }) {
  return (
    <div className={styles.segment} role="radiogroup" aria-label="Privacy">
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

/** The mode's explanation (or a save error) as a glass note with the mode's badge. */
export function PrivacyNote({ control, className }: { control: PrivacyControl; className?: string }) {
  if (!control.hint) return null;
  const isPrivate = control.current === 'private';
  return (
    <div className={`${styles.note}${isPrivate ? ` ${styles.notePrivate}` : ''}${className ? ` ${className}` : ''}`}>
      <span className={`${styles.badge} ${isPrivate ? styles.badgePrivate : styles.badgeAnonymous}`} aria-hidden="true" />
      <p className={styles.noteText} role={control.error ? 'alert' : undefined}>
        <b>{isPrivate ? 'Private.' : 'Anonymous.'}</b> {control.hint}
      </p>
    </div>
  );
}
