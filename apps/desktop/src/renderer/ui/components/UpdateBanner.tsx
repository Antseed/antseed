import { useCallback, useEffect, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Alert02Icon, Download01Icon } from '@hugeicons/core-free-icons';
import { useUiSelector } from '../hooks/useUiSelector';
import type { UpdateStatus } from '../../types/bridge';
import { BottomNotice } from './BottomNotice';
import styles from './UpdateBanner.module.scss';

const DEFAULT_INSTALL_HINT = 'Quit the app, reopen, and try again.';

/** Auto-update banner — same bottom-bar presentation as NetworkAlertBanner. */
export function UpdateBanner() {
  const networkAlert = useUiSelector((state) => state.networkAlert);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [detailsCopied, setDetailsCopied] = useState(false);
  const errorFromEventRef = useRef(false);

  useEffect(() => {
    const bridge = window.antseedDesktop;
    if (!bridge?.onUpdateStatus) return;

    const apply = (data: UpdateStatus) => {
      if (data.status === 'error') {
        errorFromEventRef.current = true;
        setUpdate(data);
        return;
      }
      errorFromEventRef.current = false;
      if (data.status === 'downloading') {
        // A completed download outranks stray progress events.
        setUpdate((prev) => (prev?.status === 'ready' ? prev : data));
        return;
      }
      setUpdate(data);
    };

    const unsubscribe = bridge.onUpdateStatus(apply);
    // Replay a status that fired before this component mounted.
    void bridge.getUpdateStatus?.()?.then((status) => {
      if (status) setUpdate((prev) => prev ?? status);
    }).catch(() => {});
    return unsubscribe;
  }, []);

  const handleInstall = useCallback(async () => {
    const bridge = window.antseedDesktop;
    if (!bridge?.installUpdate) return;
    setUpdate((prev) => (prev?.status === 'ready' ? { status: 'installing', version: prev.version } : prev));
    try {
      const result = await bridge.installUpdate();
      if (!result.ok && !errorFromEventRef.current) {
        setUpdate((prev) => ({
          status: 'error',
          version: prev?.version ?? null,
          message: result.error,
          details: result.details,
          hint: result.hint ?? DEFAULT_INSTALL_HINT,
        }));
      }
    } catch (err) {
      setUpdate((prev) => ({
        status: 'error',
        version: prev?.version ?? null,
        message: err instanceof Error ? err.message : 'Update failed to install.',
        details: err instanceof Error ? (err.stack || err.message) : String(err),
        hint: DEFAULT_INSTALL_HINT,
      }));
    }
  }, []);

  const handleCopyDetails = useCallback(() => {
    if (update?.status !== 'error') return;
    const text = [
      `Message: ${update.message}`,
      update.hint ? `Hint: ${update.hint}` : null,
      `Details: ${update.details}`,
    ].filter(Boolean).join('\n');
    void navigator.clipboard.writeText(text).then(() => {
      setDetailsCopied(true);
      window.setTimeout(() => setDetailsCopied(false), 1500);
    }).catch(() => setDetailsCopied(false));
  }, [update]);

  // The network alert owns the slot — an update can't install offline anyway.
  if (networkAlert !== 'none' || !update) return null;
  // Dismissal is deliberately session-only (component state): the banner
  // returns on the next app launch until the update is taken.
  if (
    (update.status === 'available' || update.status === 'downloading' || update.status === 'ready')
    && update.version === dismissedVersion
  ) {
    return null;
  }

  if (update.status === 'error') {
    return (
      <BottomNotice
        actions={[{ label: detailsCopied ? 'Copied' : 'Copy details', onClick: handleCopyDetails }]}
        body={`${update.message} ${update.hint ?? DEFAULT_INSTALL_HINT}`}
        dismissLabel="Dismiss update error"
        icon={<HugeiconsIcon icon={Alert02Icon} size={18} strokeWidth={1.8} />}
        onDismiss={() => setUpdate(null)}
        role="alert"
        title="Update failed"
        tone="danger"
      />
    );
  }

  const installing = update.status === 'installing';
  const downloading = update.status === 'downloading';
  const available = update.status === 'available';
  const percent = update.status === 'downloading' ? update.percent : 0;
  return (
    <BottomNotice
      actions={installing ? [] : available
        ? [{ label: 'Download', onClick: () => { void window.antseedDesktop?.downloadUpdate?.(); } }]
        : update.status === 'ready'
          ? [{ label: 'Restart & update', onClick: handleInstall }]
          : []}
      body={installing
        ? 'The app will restart on the new version in a moment.'
        : downloading
          ? `Version ${update.version} · ${percent}%`
          : available
            ? `Version ${update.version} is available.`
            : `Version ${update.version} is downloaded and ready to install.`}
      detail={downloading ? (
          <span className={styles.progressTrack} aria-hidden="true">
            <span className={styles.progressFill} style={{ width: `${percent}%` }} />
          </span>
        ) : undefined}
      dismissLabel="Dismiss update notice"
      icon={<HugeiconsIcon icon={Download01Icon} size={18} strokeWidth={1.8} />}
      onDismiss={installing ? undefined : () => setDismissedVersion(update.version)}
      title={installing ? 'Installing update…' : downloading ? 'Downloading update…' : 'Update available'}
    />
  );
}
