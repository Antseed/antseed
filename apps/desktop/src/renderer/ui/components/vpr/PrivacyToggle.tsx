import { useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { IncognitoIcon, LockIcon } from '@hugeicons/core-free-icons';
import type { ChatModel, GatewayPrivacyMode } from '../../../types/bridge';
import { privacyResource } from '../../../modules/app/vpr-resources';
import { useCachedResource } from '../../../modules/app/cached-resource';
import styles from './PrivacyToggle.module.scss';

/** Private mode routes to TEE sellers only, so pickers list only models with one. */
export function usePrivateMode(): boolean {
  return useCachedResource(privacyResource).data?.mode === 'private';
}

export function modelsForPrivacy(models: ChatModel[], privateMode: boolean): ChatModel[] {
  return privateMode ? models.filter((model) => model.tee) : models;
}

const OPTIONS: Array<{ mode: GatewayPrivacyMode; label: string; icon: typeof LockIcon; hint: string }> = [
  {
    mode: 'anonymous',
    label: 'Anonymous',
    icon: IncognitoIcon,
    hint: 'Any seller your routing policy allows. Sellers see a pseudonymous address, never your name or email.',
  },
  {
    mode: 'private',
    label: 'Private',
    icon: LockIcon,
    hint: 'TEE sellers only: requests go only to sellers that advertise TEE attestation. Fewer models and sellers.',
  },
];

/**
 * Anonymous / Private: Private adds "TEE sellers only" to the desktop key's
 * routing policy, so the chat and every app on that key route to TEE sellers.
 */
export function PrivacyToggle({ onChange }: { onChange?: (mode: GatewayPrivacyMode) => void }) {
  const privacy = useCachedResource(privacyResource);
  const [saving, setSaving] = useState<GatewayPrivacyMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = saving ?? privacy.data?.mode ?? 'anonymous';
  const editable = privacy.data?.editable !== false;
  const locked = privacy.data?.requiredAbove === true;

  async function select(mode: GatewayPrivacyMode): Promise<void> {
    if (mode === current || saving || !editable || locked) return;
    setSaving(mode);
    setError(null);
    try {
      const result = await window.antseedDesktop?.gatewaySetPrivacy?.(mode);
      if (result?.ok && result.privacy) {
        privacyResource.setData(result.privacy);
        onChange?.(result.privacy.mode);
      } else {
        setError(result?.error ?? 'Could not change the privacy mode');
      }
    } finally {
      setSaving(null);
    }
  }

  const hint = error
    ?? (!editable ? 'Your remote gateway sets its routing policy in its console.'
      : locked ? 'Your gateway requires TEE sellers for this key.'
        : OPTIONS.find((option) => option.mode === current)?.hint);

  return (
    <div className={styles.wrap}>
      <div className={styles.segment} role="radiogroup" aria-label="Privacy">
        {OPTIONS.map((option) => (
          <button
            key={option.mode}
            type="button"
            role="radio"
            aria-checked={current === option.mode}
            className={`${styles.option}${current === option.mode ? ` ${styles.active}` : ''}`}
            disabled={!editable || locked || saving !== null}
            onClick={() => { void select(option.mode); }}
            title={option.hint}
          >
            <HugeiconsIcon icon={option.icon} size={14} strokeWidth={1.8} />
            {option.label}
          </button>
        ))}
      </div>
      {hint ? <p className={error ? `${styles.hint} ${styles.hintError}` : styles.hint} role={error ? 'alert' : undefined}>{hint}</p> : null}
    </div>
  );
}
