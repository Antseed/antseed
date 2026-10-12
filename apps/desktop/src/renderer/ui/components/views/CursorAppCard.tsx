import { useCallback, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowUpRight01Icon,
  Copy01Icon,
  Settings02Icon,
  Tick02Icon,
  ViewIcon,
  ViewOffSlashIcon,
} from '@hugeicons/core-free-icons';
import { Modal } from '@antseed/ui';
import { usePublicEndpointModal } from '../tunnels/PublicEndpointModal';
import { BrandIcon } from '../brand/BrandIcon';
import styles from './VprToolsView.module.scss';
import { recordUserAction } from '../../../modules/telemetry/actions';

const CURSOR_WEBSITE = 'https://cursor.com/';
const CURSOR_GUIDE = 'https://antseed.com/docs/guides/public-tunnels#use-it-with-cursor';
const MASKED_API_KEY = '••••••••••••••••••••••••••••••••';
type CopyKind = 'url' | 'key' | 'model';

export function CursorAppCard() {
  const { status, openPublicEndpointModal } = usePublicEndpointModal();
  const [modalOpen, setModalOpen] = useState(false);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [copied, setCopied] = useState<CopyKind | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const endpointReady = status?.running === true && Boolean(status.baseUrl);

  const loadApiKey = useCallback(async (): Promise<string | null> => {
    if (apiKey) return apiKey;
    const result = await window.antseedDesktop?.publicTunnelGetApiKey?.();
    const key = result?.apiKey ?? null;
    setApiKey(key);
    return key;
  }, [apiKey]);

  const openSetup = useCallback(() => {
    if (!endpointReady) return;
    setError(null);
    setModalOpen(true);
    void loadApiKey();
  }, [endpointReady, loadApiKey]);

  const copy = useCallback((value: string, kind: CopyKind) => {
    recordUserAction('api_config_copy', 'apps');
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1500);
    });
  }, []);

  const copyApiKey = useCallback(async () => {
    const key = await loadApiKey();
    if (key) copy(key, 'key');
  }, [copy, loadApiKey]);

  const openCursor = useCallback(async () => {
    setOpening(true);
    setError(null);
    try {
      const result = await window.antseedDesktop?.openTool?.('cursor');
      if (!result?.ok) setError(result?.error ?? 'Could not open Cursor');
    } finally {
      setOpening(false);
    }
  }, []);

  return (
    <>
      <div className={`${styles.appPill}${endpointReady ? ` ${styles.appPillConnected}` : ''}`}>
        <div className={styles.appHead}>
          <span className={styles.appIdentity}>
            <BrandIcon brand="cursor" size={24} />
            <span className={styles.appText}>
              <span className={styles.appNameRow}>
                <button
                  type="button"
                  className={styles.appNameLink}
                  disabled={opening}
                  onClick={() => void openCursor()}
                  title="Open Cursor"
                >
                  {opening ? 'Opening…' : 'Cursor'}
                </button>
              </span>
              {endpointReady ? (
                <span className={styles.appMeta}>
                  <span className={styles.connectedDot} aria-hidden="true" />
                  Ready
                </span>
              ) : null}
            </span>
          </span>
          <button
            type="button"
            className={styles.configAction}
            onClick={openPublicEndpointModal}
            aria-haspopup="dialog"
            aria-label="Public endpoint settings"
            title="Public endpoint settings"
          >
            <HugeiconsIcon icon={Settings02Icon} size={15} strokeWidth={2} />
          </button>
          <button type="button" className={styles.connectAction} disabled={!endpointReady} onClick={openSetup}>
            Connect
          </button>
        </div>
      </div>

      <Modal
        isOpen={modalOpen}
        onClose={() => { setModalOpen(false); setApiKeyVisible(false); setError(null); }}
        size="sm"
        title="Cursor"
        subtitle={(
          <span className={styles.modalAppSubtitle}>
            Connect Cursor through your authenticated Antseed public endpoint.
            <button type="button" className={styles.settingWebsiteLink} onClick={() => void window.antseedDesktop?.openExternalUrl?.(CURSOR_WEBSITE)}>
              Website / download <HugeiconsIcon icon={ArrowUpRight01Icon} size={12} strokeWidth={2} />
            </button>
          </span>
        )}
        bodyClassName={styles.settingsBody}
      >
        <section className={styles.settingSection}>
          <div className={styles.settingHead}><span className={styles.settingTitle}>1. OpenAI base URL</span></div>
          <p className={styles.settingHint}>In Cursor Settings → Models, enable <strong>Override OpenAI Base URL</strong> and paste this complete URL.</p>
          <div className={styles.settingInputRow}>
            <input readOnly className={styles.settingInput} value={status?.baseUrl ?? ''} />
            <button type="button" className={styles.configAction} onClick={() => copy(status?.baseUrl ?? '', 'url')} aria-label="Copy Cursor base URL">
              <HugeiconsIcon icon={copied === 'url' ? Tick02Icon : Copy01Icon} size={15} strokeWidth={2} />
            </button>
          </div>
        </section>

        <section className={styles.settingSection}>
          <div className={styles.settingHead}><span className={styles.settingTitle}>2. OpenAI API key</span></div>
          <p className={styles.settingHint}>Enable Cursor’s OpenAI API key option and paste the Antseed key. Cursor stores API keys in its own encrypted storage.</p>
          <div className={styles.settingInputRow}>
            <input readOnly type={apiKeyVisible ? 'text' : 'password'} className={styles.settingInput} value={apiKeyVisible && apiKey ? apiKey : MASKED_API_KEY} />
            <button type="button" className={styles.configAction} onClick={() => { if (!apiKey) void loadApiKey(); setApiKeyVisible((visible) => !visible); }} aria-label={apiKeyVisible ? 'Hide Cursor API key' : 'Reveal Cursor API key'}>
              <HugeiconsIcon icon={apiKeyVisible ? ViewOffSlashIcon : ViewIcon} size={15} strokeWidth={1.8} />
            </button>
            <button type="button" className={styles.configAction} onClick={() => void copyApiKey()} aria-label="Copy Cursor API key">
              <HugeiconsIcon icon={copied === 'key' ? Tick02Icon : Copy01Icon} size={15} strokeWidth={2} />
            </button>
          </div>
        </section>

        <section className={styles.settingSection}>
          <div className={styles.settingHead}><span className={styles.settingTitle}>3. Add the model (optional)</span></div>
          <p className={styles.settingHint}>Optionally add <code>antseed</code> as a custom model to follow the model currently selected in the AI VPN.</p>
          <div className={styles.settingInputRow}>
            <input readOnly className={styles.settingInput} value="antseed" />
            <button type="button" className={styles.configAction} onClick={() => copy('antseed', 'model')} aria-label="Copy Cursor model name">
              <HugeiconsIcon icon={copied === 'model' ? Tick02Icon : Copy01Icon} size={15} strokeWidth={2} />
            </button>
          </div>
        </section>

        {error ? <p className={styles.note} role="alert">{error}</p> : null}

        <div className={styles.settingActions}>
          <button type="button" className={styles.settingWebsiteLink} onClick={() => void window.antseedDesktop?.openExternalUrl?.(CURSOR_GUIDE)}>
            Cursor tunnel guide <HugeiconsIcon icon={ArrowUpRight01Icon} size={12} strokeWidth={2} />
          </button>
          <button type="button" className={styles.configAction} onClick={openPublicEndpointModal} aria-label="Manage public endpoint" title="Manage public endpoint">
            <HugeiconsIcon icon={Settings02Icon} size={15} strokeWidth={2} />
          </button>
          <button type="button" className={styles.connectAction} disabled={opening} onClick={() => void openCursor()}>
            {opening ? 'Opening…' : 'Open Cursor'}
          </button>
        </div>
      </Modal>
    </>
  );
}
