import { useEffect, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowUpRight01Icon, Moon02Icon, Sun02Icon } from '@hugeicons/core-free-icons';
import { Button, Modal, Segmented, TextField } from '@antseed/ui';
import { activeThemeMode, applyThemeMode, type ThemeMode } from '../../lib/theme';
import type { TelemetryStatus } from '../../../../shared/telemetry';
import type { GatewayKeyMode, GatewayMode, GatewaySettings, GatewaySettingsPatch } from '../../../types/bridge';
import { appsResource, reloadPrivacyForNewGateway, gatewayResource } from '../../../modules/app/vpr-resources';
import { useCachedResource } from '../../../modules/app/cached-resource';
import { VprCard, VprPage, VprSettingRow, VprToggle } from '../vpr/VprKit';
import { ExportSignerKeyDialog, ImportSignerKeyDialog } from './SignerKeyDialogs';
import { VprFreeTierCard } from './VprFreeTierCard';
import styles from './VprPreferencesView.module.scss';

type Props = { onSelectView?: (view: import('../../types').ViewName) => void };

const TELEMETRY_DOC_URL = 'https://github.com/Antseed/antseed/blob/main/docs/telemetry.md';

/**
 * Which gateway the desktop uses and how its keys are split. Switching
 * gateway, key mode or rotating keys re-points every connected app.
 */
function GatewaySection() {
  const gateway = useCachedResource(gatewayResource);
  const [settings, setSettings] = useState<GatewaySettings | null>(null);
  const [mode, setMode] = useState<GatewayMode>('local');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [remoteKey, setRemoteKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void window.antseedDesktop?.gatewayGetSettings?.()?.then((loaded) => {
      if (!loaded) return;
      setSettings(loaded);
      setMode(loaded.mode);
      setRemoteUrl(loaded.remoteUrl ?? '');
    });
  }, []);

  const apply = async (label: string, patch: GatewaySettingsPatch) => {
    const bridge = window.antseedDesktop;
    if (!bridge?.gatewayUpdateSettings) return;
    setBusy(label);
    setMessage(null);
    try {
      const result = await bridge.gatewayUpdateSettings(patch);
      if (!result.ok || !result.settings) {
        setMessage(result.error ?? 'Could not save the gateway settings');
        // Validation failures leave settings unchanged, but starting the gateway
        // or reconnecting apps can fail after saving. Read back the actual mode.
        const saved = await bridge.gatewayGetSettings?.();
        if (saved) {
          setSettings(saved);
          setMode(saved.mode);
        }
        return;
      }
      setSettings(result.settings);
      setMode(result.settings.mode);
      setRemoteKey('');
      setMessage('Saved. Connected apps now use the new settings.');
    } finally {
      // Refresh consumers even on failure: settings may already have changed.
      void gatewayResource.refresh();
      void appsResource.refresh();
      void reloadPrivacyForNewGateway();
      setBusy(null);
    }
  };

  // Asked in the app's own dialog: Electron has no native confirm().
  const [confirmingRotate, setConfirmingRotate] = useState(false);
  const rotate = async () => {
    setConfirmingRotate(false);
    const bridge = window.antseedDesktop;
    if (!bridge?.gatewayRotateKeys) return;
    setBusy('rotate');
    setMessage(null);
    try {
      const result = await bridge.gatewayRotateKeys();
      setMessage(result.ok ? 'New keys created and connected apps updated.' : (result.error ?? 'Could not replace the keys'));
      void appsResource.refresh();
    } finally {
      setBusy(null);
    }
  };

  const openConsole = (path: string) => {
    void window.antseedDesktop?.gatewayOpenConsole?.(path)?.then((result) => {
      if (result && !result.ok) setMessage(result.error ?? 'Could not open your gateway');
    });
  };

  const current = settings?.mode ?? 'local';
  const remoteDirty = mode === 'remote' && (
    current !== 'remote'
    || remoteUrl.trim() !== (settings?.remoteUrl ?? '')
    || remoteKey.trim().length > 0
  );
  const status = gateway.data?.status;

  return (
    <div className={styles.appearanceSection}>
      <span className={styles.sectionLabel}>Gateway</span>
      <VprCard className={styles.card}>
        <VprSettingRow
          title="Gateway"
          hint={mode === 'local'
            ? 'Runs on this computer and pays from this app’s balance.'
            : 'Use a gateway someone runs for you (your team, or your own server).'}
          control={(
            <Segmented<GatewayMode>
              label="Gateway"
              value={mode}
              options={[
                { value: 'local', label: 'This computer', disabled: busy !== null },
                { value: 'remote', label: 'Remote', disabled: busy !== null },
              ]}
              onChange={(value) => {
                setMode(value);
                setMessage(null);
                if (value === 'local' && current !== 'local') void apply('mode', { mode: 'local' });
              }}
            />
          )}
        />
        {mode === 'remote' ? (
          <form
            className={styles.remoteForm}
            onSubmit={(event) => {
              event.preventDefault();
              void apply('remote', {
                mode: 'remote',
                remoteUrl: remoteUrl.trim(),
                ...(remoteKey.trim() ? { remoteApiKey: remoteKey.trim() } : {}),
              });
            }}
          >
            <TextField
              label="Gateway URL"
              value={remoteUrl}
              placeholder="https://gateway.example.com"
              spellCheck={false}
              onChange={(event) => setRemoteUrl(event.currentTarget.value)}
            />
            <TextField
              label="API key"
              type="password"
              value={remoteKey}
              placeholder={settings?.hasRemoteKey ? 'Saved — paste a new key to replace it' : 'antseed_…'}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setRemoteKey(event.currentTarget.value)}
            />
            <div className={styles.formActions}>
              <Button type="submit" size="sm" disabled={!remoteDirty || busy !== null || !remoteUrl.trim() || (!settings?.hasRemoteKey && !remoteKey.trim())}>
                {busy === 'remote' ? 'Connecting…' : 'Use this gateway'}
              </Button>
            </div>
          </form>
        ) : null}
        <VprSettingRow
          title="A key per app"
          hint={current === 'remote'
            ? 'A remote gateway’s keys are managed in its console.'
            : 'Give every connected app its own API key, so your gateway shows usage and limits per app. Off: one key for everything.'}
          control={(
            <VprToggle
              checked={(settings?.keyMode ?? 'shared') === 'per-app'}
              disabled={current === 'remote' || busy !== null}
              onChange={(next) => { void apply('keyMode', { keyMode: (next ? 'per-app' : 'shared') as GatewayKeyMode }); }}
              ariaLabel="A key per app"
            />
          )}
        />
        <div className={styles.formActions}>
          <Button
            variant="outline"
            size="sm"
            trailingIcon={<HugeiconsIcon icon={ArrowUpRight01Icon} size={14} strokeWidth={2} />}
            onClick={() => openConsole('/keys')}
          >
            Manage API keys
          </Button>
          {current === 'local' ? (
            <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirmingRotate(true)}>
              {busy === 'rotate' ? 'Replacing…' : 'Replace keys'}
            </Button>
          ) : null}
        </div>
        {status && !status.reachable && status.lastError ? (
          <p className={styles.formNote} role="alert">{status.lastError}</p>
        ) : null}
        {message ? <p className={styles.formNote} role="status">{message}</p> : null}
      </VprCard>
      <Modal
        isOpen={confirmingRotate}
        onClose={() => setConfirmingRotate(false)}
        size="sm"
        title="Replace the desktop’s API keys?"
        footer={(
          <>
            <Button variant="ghost" onClick={() => setConfirmingRotate(false)}>Cancel</Button>
            <Button onClick={() => { void rotate(); }}>Replace keys</Button>
          </>
        )}
      >
        <p className={styles.formNote}>The old keys stop working, and connected apps get the new ones (running apps restart).</p>
      </Modal>
    </div>
  );
}

export function VprPreferencesView({ onSelectView }: Props) {
  const gateway = useCachedResource(gatewayResource);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => activeThemeMode());
  const [telemetryStatus, setTelemetryStatus] = useState<TelemetryStatus | null>(null);
  const [exportKeyOpen, setExportKeyOpen] = useState(false);
  const [importKeyOpen, setImportKeyOpen] = useState(false);
  const local = gateway.data?.status.mode !== 'remote';

  useEffect(() => {
    let cancelled = false;
    void window.antseedDesktop?.getTelemetryStatus?.()
      .then((status) => {
        if (!cancelled && status) setTelemetryStatus(status);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const toggleTelemetry = (next: boolean) => {
    const setTelemetryEnabled = window.antseedDesktop?.setTelemetryEnabled;
    if (!telemetryStatus || !setTelemetryEnabled) return;

    const previousStatus = telemetryStatus;
    setTelemetryStatus({
      ...previousStatus,
      enabled: next,
      userDisabled: !next,
    });
    void setTelemetryEnabled(next)
      .then((result) => {
        if (result?.ok) setTelemetryStatus(result);
        else setTelemetryStatus(previousStatus);
      })
      .catch(() => setTelemetryStatus(previousStatus));
  };

  const selectTheme = (mode: ThemeMode) => {
    applyThemeMode(mode);
    setThemeMode(mode);
  };

  return (
    <section className={`view view-vpr-preferences view-pinned-header ${styles.view}`} role="tabpanel">
      <VprPage title="Settings" root subtitle="Your gateway, wallet, privacy and appearance.">
      <div className={`${styles.stack} ${styles.columns}`}>
        <GatewaySection />

        {local ? (
          <div className={styles.appearanceSection}>
            <span className={styles.sectionLabel}>Wallet</span>
            <VprCard className={styles.card}>
              <VprSettingRow
                title="Add funds"
                hint="Card or USDC. Balance, spend and limits are in your gateway."
                control={(
                  <button type="button" className={styles.accessManage} onClick={() => onSelectView?.('deposit')}>
                    Add funds
                  </button>
                )}
              />
              <VprSettingRow
                title="Signer key"
                hint="The key that pays for requests from this computer. Back it up, or import one you already use."
                control={(
                  <span className={styles.formActions}>
                    <button type="button" className={styles.accessManage} onClick={() => setExportKeyOpen(true)}>Back up</button>
                    <button type="button" className={styles.accessManage} onClick={() => setImportKeyOpen(true)}>Import</button>
                  </span>
                )}
              />
            </VprCard>
            <VprFreeTierCard />
          </div>
        ) : null}

        <div className={styles.appearanceSection}>
          <span className={styles.sectionLabel}>Privacy</span>
          <VprCard className={styles.card}>
            <VprSettingRow
              title="Product telemetry"
              hint={telemetryStatus?.available === false
                ? 'Telemetry is unavailable in this build or has been disabled by configuration.'
                : 'Help improve Antseed by sharing coarse feature usage and reliability information, plus each request\'s token counts, timings, estimated cost and the seller that answered, linked to your public on-chain address. Prompts, messages, files, and your balance are never collected.'}
              control={(
                <VprToggle
                  checked={telemetryStatus?.enabled ?? false}
                  onChange={toggleTelemetry}
                  ariaLabel="Product telemetry"
                  disabled={!telemetryStatus?.available}
                />
              )}
            />
            <button
              type="button"
              className={styles.telemetryDetails}
              onClick={() => { void window.antseedDesktop?.openExternalUrl?.(TELEMETRY_DOC_URL); }}
            >
              Review every event and privacy control
            </button>
          </VprCard>
        </div>

        <div className={styles.appearanceSection}>
          <span className={styles.sectionLabel}>Appearance</span>
          <VprCard className={styles.card}>
            <VprSettingRow
              title="Theme"
              hint="Applies to every Antseed window."
              control={(
                <div className={styles.themeSegment} role="radiogroup" aria-label="Theme">
                  {([
                    { mode: 'light' as const, label: 'Light', icon: Sun02Icon },
                    { mode: 'dark' as const, label: 'Dark', icon: Moon02Icon },
                  ]).map(({ mode, label, icon }) => (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={themeMode === mode}
                      className={`${styles.themeSegmentButton}${themeMode === mode ? ` ${styles.themeSegmentActive}` : ''}`}
                      onClick={() => selectTheme(mode)}
                    >
                      <HugeiconsIcon icon={icon} size={14} strokeWidth={1.8} />
                      {label}
                    </button>
                  ))}
                </div>
              )}
            />
          </VprCard>
        </div>
      </div>
      </VprPage>

      <ExportSignerKeyDialog isOpen={exportKeyOpen} onClose={() => setExportKeyOpen(false)} />
      <ImportSignerKeyDialog
        isOpen={importKeyOpen}
        onClose={() => setImportKeyOpen(false)}
        onImported={() => { void gatewayResource.refresh(); }}
      />
    </section>
  );
}
