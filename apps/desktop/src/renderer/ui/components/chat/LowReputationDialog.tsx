import { Button, Modal } from '@antseed/ui';
import styles from './SwitchServiceDialog.module.scss';

type LowReputationDialogProps = {
  visible: boolean;
  peerLabel: string;
  scoreLabel: string;
  onContinue: () => void;
  onCancel: () => void;
};

export function LowReputationDialog({
  visible,
  peerLabel,
  scoreLabel,
  onContinue,
  onCancel,
}: LowReputationDialogProps) {
  return (
    <Modal
      bodyClassName={styles.dialogBody}
      isOpen={visible}
      onClose={onCancel}
      size="sm"
      title="Low reputation peer"
    >
      <p className={styles.body}>
        <strong>{peerLabel || 'This peer'}</strong> has a lower on-chain activity score
        {scoreLabel ? <> of <strong>{scoreLabel}</strong></> : null}. Newer or lower-volume
        peers can still be useful, but they have less settled-volume history on Antseed.
      </p>
      <p className={styles.body}>
        Continue only if you&apos;re comfortable trying this peer.
      </p>
      <div className={styles.actions}>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onContinue}>
          Continue anyway
        </Button>
      </div>
    </Modal>
  );
}
