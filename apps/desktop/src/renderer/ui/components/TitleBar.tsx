import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { VprLogo } from './VprLogo';
import type { UpdateStatus } from '../../types/bridge';
import styles from './TitleBar.module.scss';

const DEFAULT_UPDATE_INSTALL_HINT = 'Quit Antseed, reopen, and try again.';

export function TitleBar() {
  const [updateState, setUpdateState] = useState<
    UpdateStatus | null
  >(null);
  const [errorDetailsOpen, setErrorDetailsOpen] = useState(false);
  const [detailsCopied, setDetailsCopied] = useState(false);
  const updateErrorFromEventRef = useRef(false);
  const updateErrorWrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const bridge = window.antseedDesktop;
    if (!bridge?.onUpdateStatus) return;
    return bridge.onUpdateStatus((data) => {
      if (data.status === 'error') {
        updateErrorFromEventRef.current = true;
        setErrorDetailsOpen(true);
        setUpdateState(data);
        return;
      }
      updateErrorFromEventRef.current = false;
      setErrorDetailsOpen(false);
      setDetailsCopied(false);
      if (data.status === 'downloading') {
        setUpdateState((prev) => {
          if (prev?.status === 'ready') return prev;
          return data;
        });
        return;
      }
      setUpdateState(data);
    });
  }, []);

  const showUpdateError = useCallback((message: string, details: string, hint?: string) => {
    setUpdateState((prev) => ({
      status: 'error',
      version: prev?.version ?? null,
      message,
      details,
      hint: hint ?? DEFAULT_UPDATE_INSTALL_HINT,
    }));
    setErrorDetailsOpen(true);
  }, []);

  const handleUpdate = useCallback(async () => {
    const bridge = window.antseedDesktop;
    if (!bridge?.installUpdate) {
      showUpdateError('Desktop updater is unavailable.', 'window.antseedDesktop.installUpdate is not available.');
      return;
    }

    setUpdateState((prev) => {
      if (prev?.status !== 'ready') return prev;
      return { status: 'installing', version: prev.version };
    });

    try {
      const result = await bridge.installUpdate();
      if (!result.ok) {
        if (updateErrorFromEventRef.current) {
          updateErrorFromEventRef.current = false;
          return;
        }
        showUpdateError(result.error, result.details, result.hint);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Update failed to install.';
      const details = err instanceof Error ? (err.stack || err.message) : String(err);
      showUpdateError(message, details);
    }
  }, [showUpdateError]);

  const handleCopyUpdateDetails = useCallback(() => {
    if (updateState?.status !== 'error') return;
    const detailText = [
      `Message: ${updateState.message}`,
      updateState.hint ? `Hint: ${updateState.hint}` : null,
      `Details: ${updateState.details}`,
    ].filter(Boolean).join('\n');
    void navigator.clipboard.writeText(detailText).then(() => {
      setDetailsCopied(true);
      window.setTimeout(() => setDetailsCopied(false), 1500);
    }).catch(() => {
      setDetailsCopied(false);
    });
  }, [updateState]);

  useEffect(() => {
    if (!errorDetailsOpen || updateState?.status !== 'error') return;
    const handler = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (!updateErrorWrapRef.current?.contains(target)) {
        setErrorDetailsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [errorDetailsOpen, updateState?.status]);

  let updateControl: ReactNode = null;
  if (updateState?.status === 'ready') {
    updateControl = (
      <button
        className={`${styles.titleBarUpdateBadge} ${styles.titleBarUpdateBadgeReady}`}
        onClick={handleUpdate}
        aria-label={`Install v${updateState.version} and restart`}
        title={`Click to install v${updateState.version} and restart`}
      >
        <span className={styles.titleBarUpdateDot} />
        Update to v{updateState.version}
      </button>
    );
  } else if (updateState?.status === 'downloading') {
    updateControl = (
      <button
        className={`${styles.titleBarUpdateBadge} ${styles.titleBarUpdateBadgeDownloading}`}
        disabled
        aria-label={`Downloading v${updateState.version} ${updateState.percent}%`}
        title={`Downloading v${updateState.version} - ${updateState.percent}%`}
      >
        <span className={styles.titleBarUpdateFill} style={{ width: `${updateState.percent}%` }} aria-hidden="true" />
        <span className={styles.titleBarUpdateLabel}>
          <span className={styles.titleBarUpdateDot} />
          Downloading v{updateState.version} · {updateState.percent}%
        </span>
      </button>
    );
  } else if (updateState?.status === 'installing') {
    updateControl = (
      <button
        className={`${styles.titleBarUpdateBadge} ${styles.titleBarUpdateBadgeDownloading}`}
        disabled
        aria-label="Installing update and restarting"
        title="Installing update and restarting"
      >
        <span className={styles.titleBarUpdateLabel}>
          <span className={styles.titleBarUpdateDot} />
          Installing update
        </span>
      </button>
    );
  } else if (updateState?.status === 'error') {
    updateControl = (
      <div className={styles.titleBarUpdateErrorWrap} ref={updateErrorWrapRef}>
        <button
          className={`${styles.titleBarUpdateBadge} ${styles.titleBarUpdateBadgeError}`}
          onClick={() => setErrorDetailsOpen((prev) => !prev)}
          aria-expanded={errorDetailsOpen}
          aria-label="Update failed. Show details"
          title={updateState.message}
        >
          <span className={styles.titleBarUpdateDot} />
          Update failed
        </button>
        {errorDetailsOpen && (
          <div className={styles.titleBarUpdateErrorPanel} role="alert">
            <div className={styles.titleBarUpdateErrorTitle}>Update failed to install</div>
            <p>{updateState.hint ?? DEFAULT_UPDATE_INSTALL_HINT}</p>
            <div className={styles.titleBarUpdateErrorMessage}>{updateState.message}</div>
            <pre>{updateState.details}</pre>
            <div className={styles.titleBarUpdateErrorActions}>
              <button type="button" onClick={handleCopyUpdateDetails}>
                {detailsCopied ? 'Copied' : 'Copy details'}
              </button>
              <button type="button" onClick={() => setErrorDetailsOpen(false)}>
                Dismiss
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <header className={styles.titleBar}>
      <div className={styles.titleBarLeft}>
        <VprLogo height={20} className={styles.titleBarLogo} />
      </div>
      {updateControl && (
        <div className={styles.titleBarCenter}>
          {updateControl}
        </div>
      )}
    </header>
  );
}
