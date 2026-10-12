import { useCallback, useEffect, useState } from 'react';
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
import type { PublicTunnelStatus, TunnelProvider } from '../../../types/bridge';
import { BrandIcon } from '../brand/BrandIcon';
import formStyles from '../views/VprToolsView.module.scss';
import styles from './PublicEndpointModal.module.scss';

const TUNNEL_DOCS_URL = 'https://antseed.com/docs/guides/public-tunnels';
const MASKED_API_KEY = '••••••••••••••••••••••••••••••••';
type CopyKind = 'url' | 'key';

const PROVIDERS: ReadonlyArray<{
  id: TunnelProvider;
  name: string;
  tokenLabel: string;
  tokenPlaceholder: string;
  urlPlaceholder: string;
  description: string;
  setupHint: string;
  dashboardLabel: string;
  dashboardUrl: string;
}> = [
  {
    id: 'ngrok',
    name: 'ngrok',
    tokenLabel: 'ngrok authtoken',
    tokenPlaceholder: 'ngrok authtoken',
    urlPlaceholder: 'https://example.ngrok-free.dev',
    description: 'Generate a public HTTPS endpoint, with an optional static ngrok domain.',
    setupHint: 'Paste the authtoken. Leave the hostname blank for a generated URL, or enter a static ngrok domain.',
    dashboardLabel: 'Open ngrok Dashboard',
    dashboardUrl: 'https://dashboard.ngrok.com/',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare Tunnel',
    tokenLabel: 'Cloudflare tunnel token',
    tokenPlaceholder: 'Named tunnel run token',
    urlPlaceholder: 'https://cursor-api.example.com',
    description: 'Use a named Cloudflare Tunnel and your own hostname.',
    setupHint: 'Route the public hostname to http://localhost:8379, then paste its run token.',
    dashboardLabel: 'Open Cloudflare Zero Trust',
    dashboardUrl: 'https://one.dash.cloudflare.com/',
  },
];

export function PublicEndpointModal({
  isOpen,
  status,
  onClose,
  onStatusChange,
}: {
  isOpen: boolean;
  status: PublicTunnelStatus | null;
  onClose: () => void;
  onStatusChange: (status: PublicTunnelStatus) => void;
}) {
  const [editingProvider, setEditingProvider] = useState<TunnelProvider | null>(null);
  const [token, setToken] = useState('');
  const [publicUrl, setPublicUrl] = useState('');
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [busyProvider, setBusyProvider] = useState<TunnelProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<CopyKind | null>(null);

  useEffect(() => {
    if (isOpen) return;
    setEditingProvider(null);
    setToken('');
    setPublicUrl('');
    setApiKeyVisible(false);
    setError(null);
  }, [isOpen]);

  const configureAndStart = useCallback(async () => {
    const provider = editingProvider;
    const bridge = window.antseedDesktop;
    if (!provider || !bridge?.publicTunnelConfigure || !bridge.publicTunnelStart) return;
    setBusyProvider(provider);
    setError(null);
    try {
      const configured = await bridge.publicTunnelConfigure({
        provider,
        tunnelToken: token.trim(),
        publicUrl: publicUrl.trim(),
      });
      if (!configured.ok) {
        setError(configured.error ?? 'Could not save tunnel settings');
        return;
      }
      const result = await bridge.publicTunnelStart({ provider });
      if (!result.ok) {
        setError(result.error ?? 'Could not start tunnel');
        return;
      }
      if (result.status) onStatusChange(result.status);
      setEditingProvider(null);
      setToken('');
      setPublicUrl('');
    } finally {
      setBusyProvider(null);
    }
  }, [editingProvider, onStatusChange, publicUrl, token]);

  const toggleTunnel = useCallback(async (provider: TunnelProvider) => {
    const bridge = window.antseedDesktop;
    const isRunning = status?.running === true && status.activeProvider === provider;
    setBusyProvider(provider);
    setError(null);
    try {
      const result = isRunning
        ? await bridge?.publicTunnelStop?.()
        : await bridge?.publicTunnelStart?.({ provider });
      if (!result?.ok) {
        setError(result?.error ?? 'Tunnel action failed');
        return;
      }
      if (result.status) onStatusChange(result.status);
    } finally {
      setBusyProvider(null);
    }
  }, [onStatusChange, status?.activeProvider, status?.running]);

  const copy = useCallback((value: string, kind: CopyKind) => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1500);
    });
  }, []);

  const loadApiKey = useCallback(async (): Promise<string | null> => {
    if (apiKey) return apiKey;
    const result = await window.antseedDesktop?.publicTunnelGetApiKey?.();
    const loadedApiKey = result?.apiKey ?? null;
    setApiKey(loadedApiKey);
    return loadedApiKey;
  }, [apiKey]);

  const revealKey = useCallback(async () => {
    if (apiKeyVisible) {
      setApiKeyVisible(false);
      return;
    }
    await loadApiKey();
    setApiKeyVisible(true);
  }, [apiKeyVisible, loadApiKey]);

  const copyApiKey = useCallback(async () => {
    const key = await loadApiKey();
    if (key) copy(key, 'key');
  }, [copy, loadApiKey]);

  const openConfigure = useCallback((provider: TunnelProvider) => {
    setEditingProvider(provider);
    setToken('');
    setPublicUrl('');
    setError(null);
  }, []);

  const closeConfigure = useCallback(() => {
    setEditingProvider(null);
    setError(null);
  }, []);

  const selectedProvider = PROVIDERS.find((provider) => provider.id === editingProvider) ?? null;
  const baseUrl = status?.baseUrl ?? null;
  const hasConnectionDetails = Boolean(baseUrl || status?.configured);
  const publicUrlIsValid = publicUrl.trim().startsWith('https://');
  const publicUrlIsRequired = selectedProvider?.id === 'cloudflare';
  const configureDisabled = busyProvider !== null
    || token.trim().length < 20
    || (publicUrlIsRequired && !publicUrlIsValid)
    || (publicUrl.trim().length > 0 && !publicUrlIsValid);

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        size="lg"
        title="Internet-accessible Antseed endpoint"
        subtitle="Connect Cursor, remote agents, hosted clients, and servers through an authenticated HTTPS endpoint."
        className={styles.modal}
        bodyClassName={styles.modalBody}
      >
      <section className={styles.intro}>
        <div>
          <h3 className={styles.sectionTitle}>Choose a tunnel provider</h3>
          <p className={styles.sectionHint}>Only Antseed’s authenticated <code>/v1</code> model API is published. Port 8377 remains local.</p>
        </div>
        <button type="button" className={styles.docsLink} onClick={() => void window.antseedDesktop?.openExternalUrl?.(TUNNEL_DOCS_URL)}>
          Public tunnel guide <HugeiconsIcon icon={ArrowUpRight01Icon} size={13} strokeWidth={2} />
        </button>
      </section>

      {error && !selectedProvider ? <p className={styles.error} role="alert">{error}</p> : null}

      <div className={styles.providerList}>
        {PROVIDERS.map((provider) => {
          const configured = status?.configuredProviders.includes(provider.id) ?? false;
          const running = status?.running === true && status.activeProvider === provider.id;
          return (
            <section key={provider.id} className={`${styles.providerCard}${running ? ` ${styles.providerCardRunning}` : ''}`}>
              <div className={styles.providerHead}>
                <BrandIcon name={provider.id} hints={[provider.name]} size={28} />
                <div className={styles.providerIdentity}>
                  <div className={styles.providerNameRow}>
                    <span className={styles.providerName}>{provider.name}</span>
                    {running ? <span className={styles.runningBadge}>Running</span> : configured ? <span className={styles.configuredBadge}>Configured</span> : null}
                  </div>
                  <p className={styles.providerDescription}>{provider.description}</p>
                </div>
                {configured ? (
                  <button type="button" className={styles.iconButton} onClick={() => openConfigure(provider.id)} aria-label={`Configure ${provider.name}`}>
                    <HugeiconsIcon icon={Settings02Icon} size={16} strokeWidth={2} />
                  </button>
                ) : null}
                {configured ? (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={running}
                    className={`${formStyles.connectedToggle}${running ? '' : ` ${formStyles.connectedToggleOff}`}`}
                    disabled={busyProvider !== null}
                    onClick={() => void toggleTunnel(provider.id)}
                    aria-label={`${running ? 'Stop' : 'Start'} ${provider.name}`}
                  >
                    <span />
                  </button>
                ) : (
                  <button type="button" className={styles.primaryButton} disabled={busyProvider !== null} onClick={() => openConfigure(provider.id)}>
                    Configure
                  </button>
                )}
              </div>

            </section>
          );
        })}
      </div>

      {hasConnectionDetails ? (
        <section className={styles.connectionDetails}>
          <div>
            <h3 className={styles.sectionTitle}>Connection details</h3>
            <p className={styles.sectionHint}>Use these values in the remote app or agent’s provider settings.</p>
          </div>
          {baseUrl ? (
            <section className={styles.fieldSection}>
              <div className={styles.fieldHead}><span>OpenAI base URL</span></div>
              <div className={styles.credentialRow}>
                <input readOnly className={styles.input} value={baseUrl} />
                <button type="button" className={styles.copyButton} onClick={() => copy(baseUrl, 'url')}>
                  <HugeiconsIcon icon={copied === 'url' ? Tick02Icon : Copy01Icon} size={15} strokeWidth={2} />
                  {copied === 'url' ? 'Copied' : 'Copy'}
                </button>
              </div>
            </section>
          ) : null}
          {status?.configured ? (
            <section className={styles.fieldSection}>
              <div className={styles.fieldHead}><span>API key</span></div>
              <div className={styles.credentialRow}>
                <div className={styles.secretField}>
                  <span className={styles.secretValue}>{apiKeyVisible && apiKey ? apiKey : MASKED_API_KEY}</span>
                  <button type="button" className={styles.iconButton} onClick={() => void revealKey()} aria-label={apiKeyVisible ? 'Hide API key' : 'Reveal API key'}>
                    <HugeiconsIcon icon={apiKeyVisible ? ViewOffSlashIcon : ViewIcon} size={16} strokeWidth={1.8} />
                  </button>
                </div>
                <button type="button" className={styles.copyButton} onClick={() => void copyApiKey()}>
                  <HugeiconsIcon icon={copied === 'key' ? Tick02Icon : Copy01Icon} size={15} strokeWidth={2} />
                  {copied === 'key' ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p className={styles.fieldHint}>Send it as <code>Authorization: Bearer &lt;API_KEY&gt;</code>. The same key works with either provider.</p>
            </section>
          ) : null}
        </section>
      ) : null}
      </Modal>

      <Modal
        isOpen={selectedProvider !== null}
        onClose={closeConfigure}
        size="sm"
        title={selectedProvider?.name ?? 'Tunnel provider'}
        subtitle="Expose only Antseed’s authenticated /v1 API."
        className={styles.modal}
        bodyClassName={styles.settingsBody}
      >
        {selectedProvider ? (
          <>
            <section className={styles.fieldSection}>
              <div className={styles.fieldHead}>
                <span>{selectedProvider.tokenLabel}</span>
                <span className={styles.requiredTag}>Required</span>
              </div>
              <p className={styles.fieldHint}>{selectedProvider.setupHint}</p>
              <input type="password" className={styles.input} value={token} placeholder={selectedProvider.tokenPlaceholder} autoComplete="off" spellCheck={false} onChange={(event) => setToken(event.target.value)} />
              <button type="button" className={styles.docsLink} onClick={() => void window.antseedDesktop?.openExternalUrl?.(selectedProvider.dashboardUrl)}>
                {selectedProvider.dashboardLabel} <HugeiconsIcon icon={ArrowUpRight01Icon} size={12} strokeWidth={2} />
              </button>
            </section>
            <section className={styles.fieldSection}>
              <div className={styles.fieldHead}>
                <span>Public hostname</span>
                <span className={styles.requiredTag}>{publicUrlIsRequired ? 'Required' : 'Optional'}</span>
              </div>
              <input type="url" className={styles.input} value={publicUrl} placeholder={selectedProvider.urlPlaceholder} spellCheck={false} onChange={(event) => setPublicUrl(event.target.value)} />
            </section>
            {error ? <p className={styles.error} role="alert">{error}</p> : null}
            <div className={styles.settingsActions}>
              <button type="button" className={styles.secondaryButton} onClick={closeConfigure}>Cancel</button>
              <button type="button" className={styles.primaryButton} disabled={configureDisabled} onClick={() => void configureAndStart()}>
                {busyProvider === selectedProvider.id ? 'Starting…' : 'Save and start'}
              </button>
            </div>
          </>
        ) : null}
      </Modal>
    </>
  );
}
