import { useEffect, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { PowerOffIcon } from '@hugeicons/core-free-icons';
import { Button, Modal } from '@antseed/ui';
import styles from './DisconnectConfirmDialog.module.scss';

type DisconnectConfirmDialogProps = {
  visible: boolean;
  onConfirm: (dontShowAgain: boolean) => void;
  onCancel: () => void;
};

/**
 * Confirmation shown when the Home power button is used to disconnect.
 * Built on the shared Modal + Button (desktop modal chrome comes from
 * global.scss).
 */
export function DisconnectConfirmDialog({ visible, onConfirm, onCancel }: DisconnectConfirmDialogProps) {
  const [dontShowAgain, setDontShowAgain] = useState(false);

  useEffect(() => {
    if (visible) setDontShowAgain(false);
  }, [visible]);

  return (
    <Modal
      bodyClassName={styles.body}
      isOpen={visible}
      onClose={onCancel}
      size="sm"
      title="Disconnect Antseed?"
    >
      <div className={styles.badge} aria-hidden="true">
        <span className={styles.ring} />
        <span className={`${styles.ring} ${styles.ringDelayed}`} />
        <span className={styles.badgeIcon}>
          <HugeiconsIcon icon={PowerOffIcon} size={30} strokeWidth={2} />
        </span>
      </div>
      <p className={styles.text}>
        Routing will stop and connected apps lose their Antseed connection until you turn it
        back on. Chats in progress will be interrupted.
      </p>
      <label className={styles.dontShowRow}>
        <input
          type="checkbox"
          checked={dontShowAgain}
          onChange={(event) => setDontShowAgain(event.target.checked)}
        />
        Don&apos;t show this again
      </label>
      <div className={styles.actions}>
        <Button variant="outline" fullWidth onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="danger" fullWidth onClick={() => onConfirm(dontShowAgain)}>
          Disconnect
        </Button>
      </div>
    </Modal>
  );
}
