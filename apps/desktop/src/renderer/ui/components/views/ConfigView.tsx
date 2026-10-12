import { useEffect, useCallback } from 'react';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { useRetainedState } from '../../hooks/useRetainedState';
import { VprBackTitle, VprCard, VprSettingRow, VprToggle } from '../vpr/VprKit';
import styles from './ConfigView.module.scss';

type ConfigViewProps = {
  onSelectView?: (view: import('../../types').ViewName) => void;
};

type VoiceModelStatus = {
  available: boolean;
  activeModel: string;
  error: string | null;
  models: Array<{ id: string; label: string; size: string; installed: boolean; selected: boolean; bundled: boolean }>;
};

// Renderer-lifetime cache: settings edits survive lazy page unmounts until the
// form is saved or the app process exits.
const configViewCache = {
  proxyPort: '8377',
  minRep: '0',
  chainId: 'base-mainnet',
  disableMetadataV2Services: false,
  dirty: false,
  initialized: false,
  voiceStatus: null as VoiceModelStatus | null,
  voiceInstalling: false,
  voiceMessage: null as string | null,
};

function isVoiceModelStatus(value: unknown): value is VoiceModelStatus {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  return Boolean(record && Array.isArray(record.models));
}

export function ConfigView({ onSelectView }: ConfigViewProps) {
  const { configFormData, configSaving, configMessage } = useUiSelector((state) => ({
    configFormData: state.configFormData,
    configSaving: state.configSaving,
    configMessage: state.configMessage,
  }), shallowEqual);
  const actions = useActions();

  // Local form state — initialized from config, edited locally, saved on button click
  const [proxyPort, setProxyPort] = useRetainedState(configViewCache, 'proxyPort');
  const [minRep, setMinRep] = useRetainedState(configViewCache, 'minRep');
  const [chainId, setChainId] = useRetainedState(configViewCache, 'chainId');
  const [disableMetadataV2Services, setDisableMetadataV2Services] = useRetainedState(configViewCache, 'disableMetadataV2Services');
  const [dirty, setDirty] = useRetainedState(configViewCache, 'dirty');
  const [voiceStatus, setVoiceStatus] = useRetainedState(configViewCache, 'voiceStatus');
  const [voiceInstalling, setVoiceInstalling] = useRetainedState(configViewCache, 'voiceInstalling');
  const [voiceMessage, setVoiceMessage] = useRetainedState(configViewCache, 'voiceMessage');

  // Sync from config on first load only
  const [initialized, setInitialized] = useRetainedState(configViewCache, 'initialized');
  useEffect(() => {
    if (configFormData && !initialized) {
      setProxyPort(String(configFormData.proxyPort));
      setMinRep(String(configFormData.minRep));
      setChainId(configFormData.cryptoChainId || 'base-mainnet');
      setDisableMetadataV2Services(configFormData.disableMetadataV2Services);
      setInitialized(true);
    }
  }, [configFormData, initialized, setChainId, setDisableMetadataV2Services, setInitialized, setMinRep, setProxyPort]);

  const markDirty = useCallback(() => setDirty(true), [setDirty]);

  const refreshVoiceStatus = useCallback(async () => {
    const result = await window.antseedDesktop?.voiceGetStatus?.();
    if (isVoiceModelStatus(result)) setVoiceStatus(result);
  }, []);

  useEffect(() => {
    void refreshVoiceStatus();
  }, [refreshVoiceStatus]);

  async function handleVoiceModelChange(modelId: string) {
    setVoiceMessage(null);
    const result = await window.antseedDesktop?.voiceSetModel?.(modelId) as { ok?: boolean; error?: string; status?: unknown } | undefined;
    if (!result?.ok) {
      setVoiceMessage(result?.error || 'Could not switch voice model.');
      return;
    }
    if (isVoiceModelStatus(result.status)) setVoiceStatus(result.status);
  }

  async function handleInstallBaseModel() {
    setVoiceInstalling(true);
    setVoiceMessage('Downloading Base multilingual (~142 MB)…');
    try {
      const result = await window.antseedDesktop?.voiceInstallModel?.('base') as { ok?: boolean; error?: string; status?: unknown } | undefined;
      if (!result?.ok) throw new Error(result?.error || 'Install failed.');
      if (isVoiceModelStatus(result.status)) setVoiceStatus(result.status);
      setVoiceMessage('Base multilingual installed and selected.');
    } catch (error) {
      setVoiceMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setVoiceInstalling(false);
    }
  }

  // Save all config and restart the buyer runtime
  async function handleSaveAndRestart() {
    if (!configFormData) return;
    await actions.saveConfig({
      ...configFormData,
      proxyPort: parseInt(proxyPort, 10) || 8377,
      peerRefreshIntervalMs: configFormData.peerRefreshIntervalMs,
      minRep: parseInt(minRep, 10) || 0,
      disableMetadataV2Services,
      cryptoChainId: chainId,
    });
    setDirty(false);
    // Restart buyer runtime to pick up new config. Connected apps stay
    // connected across the restart — a restart is not a disconnect.
    try {
      await actions.restartConnect();
    } catch { /* will auto-start on next request */ }
  }

  const baseInstalled = voiceStatus?.models.some((model) => model.id === 'base' && model.installed) ?? false;

  return (
    <section className={`view view-config ${styles.view}`} role="tabpanel">
      <div className={styles.stack}>
        <VprBackTitle title="Configuration" fallback="help" />

        <VprCard className={styles.card}>
          <span className={styles.cardTitle}>Buyer</span>
          <VprSettingRow
            title="Proxy port"
            hint="Local port for service routing and chat requests"
            control={(
              <input
                type="number"
                className={styles.input}
                value={proxyPort}
                onChange={(e) => { setProxyPort(e.target.value); markDirty(); }}
              />
            )}
          />
          <VprSettingRow
            title="Minimum peer reputation"
            hint="Peers below this score are excluded from routing"
            control={(
              <input
                type="number"
                className={styles.input}
                min="0"
                max="100"
                value={minRep}
                onChange={(e) => { setMinRep(e.target.value); markDirty(); }}
              />
            )}
          />
          <VprSettingRow
            title="Disable metadata attribution"
            hint="Omit per-service usage details from paid and free usage metadata"
            control={(
              <VprToggle
                checked={disableMetadataV2Services}
                onChange={() => { setDisableMetadataV2Services((value) => !value); markDirty(); }}
                ariaLabel="Disable service metadata attribution"
                disabled={configSaving}
              />
            )}
          />
        </VprCard>

        <VprCard className={styles.card}>
          <span className={styles.cardTitle}>Payments</span>
          <VprSettingRow
            title="Chain environment"
            hint="Settlement chain for payments — contract addresses resolve automatically"
            control={(
              <select
                className={styles.select}
                value={chainId}
                onChange={(e) => { setChainId(e.target.value); markDirty(); }}
              >
                <option value="base-mainnet">Base Mainnet</option>
                <option value="base-sepolia">Base Sepolia (testnet)</option>
                <option value="base-local">Base Local (development)</option>
              </select>
            )}
          />
        </VprCard>

        {dirty && (
          <div className={styles.saveRow}>
            <button
              type="button"
              className={styles.saveButton}
              onClick={() => void handleSaveAndRestart()}
              disabled={configSaving}
            >
              {configSaving ? 'Saving...' : 'Save & Restart'}
            </button>
          </div>
        )}

        <VprCard className={styles.card}>
          <span className={styles.cardTitle}>Voice transcription</span>
          <VprSettingRow
            title="Local Whisper model"
            hint="Voice messages are transcribed locally — Tiny downloads on first use, Base is more accurate"
            control={(
              <select
                className={styles.select}
                value={voiceStatus?.activeModel || 'tiny'}
                onChange={(e) => void handleVoiceModelChange(e.target.value)}
                disabled={!voiceStatus}
              >
                {(voiceStatus?.models || []).map((model) => (
                  <option key={model.id} value={model.id} disabled={!model.installed && model.id !== 'tiny'}>
                    {model.label} {model.size}
                    {model.installed ? '' : model.id === 'tiny' ? ' — downloads on first use' : ' — not installed'}
                  </option>
                ))}
              </select>
            )}
          />
          <VprSettingRow
            title="Better accuracy"
            hint="Install Base multilingual (~142 MB) for improved transcription quality"
            control={(
              <button
                type="button"
                className={styles.saveButton}
                onClick={() => void handleInstallBaseModel()}
                disabled={voiceInstalling || baseInstalled}
              >
                {voiceInstalling ? 'Installing…' : baseInstalled ? 'Installed' : 'Install Base'}
              </button>
            )}
          />
          {voiceMessage ? <p className={styles.note}>{voiceMessage}</p> : null}
          {voiceStatus?.error ? <p className={`${styles.note} ${styles.noteError}`}>{voiceStatus.error}</p> : null}
        </VprCard>

        {configMessage ? (
          <p className={`${styles.note}${configMessage.type === 'error' ? ` ${styles.noteError}` : ''}`}>
            {configMessage.text}
          </p>
        ) : null}
      </div>
    </section>
  );
}
