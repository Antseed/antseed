import { useState, type ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Alert02Icon } from '@hugeicons/core-free-icons';
import { Button, Modal } from '@antseed/ui';
import { shortAddress } from '../../../core/format';
import styles from './SignerKeyDialogs.module.scss';

function WarningAlert({ children }: { children: ReactNode }) {
  return (
    <div className={styles.warning} role="alert">
      <HugeiconsIcon icon={Alert02Icon} size={16} strokeWidth={2} />
      <span>{children}</span>
    </div>
  );
}

type ExportProps = {
  isOpen: boolean;
  onClose: () => void;
};

export function ExportSignerKeyDialog({ isOpen, onClose }: ExportProps) {
  const [busy, setBusy] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setSavedPath(null);
    setError(null);
    onClose();
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.antseedDesktop?.identityExportKey?.();
      if (!result) {
        setError('Key export is not available in this build.');
      } else if (result.ok && result.path) {
        setSavedPath(result.path);
      } else if (!result.canceled) {
        setError(result.error || 'Failed to save the key.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal bodyClassName={styles.dialogBody} isOpen={isOpen} onClose={close} size="sm" title="Back up signer key">
      {savedPath ? (
        <>
          <p className={styles.body}>
            Key saved to <code className={styles.path}>{savedPath}</code>.
          </p>
          <p className={styles.body}>
            Move it somewhere safe — a password manager or encrypted drive — and never share it.
          </p>
          <div className={styles.actions}>
            <Button onClick={close}>Done</Button>
          </div>
        </>
      ) : (
        <>
          <WarningAlert>
            Your signer&apos;s private key controls your balance and identity. Anyone who has it can
            spend your credits and impersonate your account.
          </WarningAlert>
          <p className={styles.body}>
            Keep the saved file somewhere safe and never share it or paste it into websites or chats.
          </p>
          {error ? <p className={styles.error}>{error}</p> : null}
          <div className={styles.actions}>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => { void save(); }}>
              {busy ? 'Saving...' : 'Download key'}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

type ImportProps = {
  isOpen: boolean;
  onClose: () => void;
  onImported?: () => void;
};

export function ImportSignerKeyDialog({ isOpen, onClose, onImported }: ImportProps) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importedAddress, setImportedAddress] = useState<string | null>(null);
  const [backupNote, setBackupNote] = useState<string | null>(null);

  const close = () => {
    setKey('');
    setError(null);
    setImportedAddress(null);
    setBackupNote(null);
    onClose();
  };

  const backupCurrent = async () => {
    setError(null);
    const result = await window.antseedDesktop?.identityExportKey?.();
    if (result?.ok && result.path) {
      setBackupNote(`Current key saved to ${result.path}.`);
    } else if (result && !result.canceled) {
      setError(result.error || 'Failed to save the current key.');
    }
  };

  const importKey = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.antseedDesktop?.identityImportKey?.(key);
      if (!result) {
        setError('Key import is not available in this build.');
      } else if (result.ok && result.address) {
        setImportedAddress(result.address);
        setKey('');
        onImported?.();
      } else {
        setError(result.error || 'Failed to import the key.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal bodyClassName={styles.dialogBody} isOpen={isOpen} onClose={close} size="sm" title="Import signer key">
      {importedAddress ? (
        <>
          <p className={styles.body}>
            New signer imported: <strong>{shortAddress(importedAddress)}</strong>.
          </p>
          <p className={styles.body}>
            Restart Antseed to finish switching to the new key. Your previous key was backed up on
            this machine.
          </p>
          <div className={styles.actions}>
            <Button onClick={close}>Done</Button>
          </div>
        </>
      ) : (
        <>
          <WarningAlert>
            Importing replaces your current signer key. Back up the current key first — without a
            backup, any balance it holds becomes unreachable.
          </WarningAlert>
          <button type="button" className={styles.backupLink} onClick={() => { void backupCurrent(); }}>
            Back up current key
          </button>
          {backupNote ? <p className={styles.note}>{backupNote}</p> : null}
          <input
            type="password"
            className={styles.keyInput}
            placeholder="Private key (64 hex characters)"
            value={key}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setKey(event.target.value)}
          />
          {error ? <p className={styles.error}>{error}</p> : null}
          <div className={styles.actions}>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button variant="danger" disabled={busy || key.trim().length === 0} onClick={() => { void importKey(); }}>
              {busy ? 'Importing...' : 'Import key'}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
