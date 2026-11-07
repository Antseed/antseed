import { useCallback, useEffect, useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowReloadHorizontalIcon,
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  Copy01Icon,
  Key01Icon,
  Settings02Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons';
import { BrandIcon, isThemeAwareAppBrand, Modal, resolveBrandKey } from '@antseed/ui';
import type { ConnectedAppProfile, GatewayEndpointInfo, InstalledAppEntry } from '../../../types/bridge';
import { appsResource, installedAppsResource } from '../../../modules/app/vpr-resources';
import { useCachedResource } from '../../../modules/app/cached-resource';
import { TelegramBotCard } from './TelegramBotCard';
import { VprCard, VprPage, VprSearch } from '../vpr/VprKit';
import { AgentSkillsPanel } from '../vpr/AgentSkillsPanel';
import { appLogoUrl } from '../vpr/AppPills';
import { AppsBanner } from '../vpr/AppsBanner';
import { AppsOnboarding } from './AppsOnboarding';
import { isAppsOnboardingSeen, persistAppsOnboardingSeen } from '../../../modules/app/apps-onboarding';
import styles from './VprToolsView.module.scss';
import { recordUserAction } from '../../../modules/telemetry/actions';
import { normalizeTelemetryAppName } from '../../../../shared/telemetry.js';

const BUILT_IN_APP_INFO: Readonly<Record<string, { description: string; websiteUrl: string }>> = {
  opencode: {
    description: 'An open-source coding agent for the terminal, desktop, and IDE.',
    websiteUrl: 'https://opencode.ai/',
  },
  codex: {
    description: 'OpenAI’s coding agent for building, reviewing, and shipping software.',
    websiteUrl: 'https://openai.com/codex/',
  },
  t3code: {
    description: 'A desktop interface for running multiple coding agents in parallel.',
    websiteUrl: 'https://github.com/pingdotgg/t3code',
  },
  pi: {
    description: 'A minimal, extensible coding agent for the terminal.',
    websiteUrl: 'https://pi.dev/',
  },
  gooeypi: {
    description: 'A graphical desktop experience powered by the Pi coding-agent ecosystem.',
    websiteUrl: 'https://pi.dev/',
  },
  crush: {
    description: 'A terminal-based AI coding agent from Charm.',
    websiteUrl: 'https://github.com/charmbracelet/crush',
  },
  goose: {
    description: 'An open-source AI agent that can plan, code, and automate development tasks.',
    websiteUrl: 'https://block.github.io/goose/',
  },
  hermes: {
    description: 'A desktop AI agent with tools, skills, file previews, voice, profiles, and automation.',
    websiteUrl: 'https://hermes-agent.nousresearch.com/',
  },
  zed: {
    description: 'A high-performance collaborative code editor with built-in AI assistance. Zed keeps API keys in its own keychain: paste your gateway key into Zed’s Antseed provider once.',
    websiteUrl: 'https://zed.dev/download',
  },
  droid: {
    description: 'Factory’s coding agent for the terminal and desktop.',
    websiteUrl: 'https://factory.ai/',
  },
};

function appInfo(profile: ConnectedAppProfile): { description: string; websiteUrl?: string } {
  return BUILT_IN_APP_INFO[profile.name]
    ?? { description: `${profile.displayName} uses your Antseed gateway for AI requests.` };
}

/** Two-pane modal navigation: the main pane slides to the application list
    the same way the app's screens slide ('none' = no animation on open). */
type ModalPane = { pane: 'main' | 'apps'; dir: 'none' | 'forward' | 'back' };

function maskKey(key: string): string {
  return key.length > 16 ? `${key.slice(0, 12)}…${key.slice(-4)}` : key;
}

function CopyRow({ label, value, display }: { label: string; value: string; display?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={styles.endpointValue}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }).catch(() => setCopied(false));
      }}
      title={`Copy ${label}`}
    >
      <code>{display ?? value}</code>
      <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={13} strokeWidth={2} />
      <span>{copied ? 'Copied' : label}</span>
    </button>
  );
}

/**
 * Base URL + key for any OpenAI- or Anthropic-compatible tool the list does
 * not cover.
 */
function GatewayEndpointCard({ onOpenConsole }: { onOpenConsole: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const [endpoint, setEndpoint] = useState<GatewayEndpointInfo | null>(null);
  useEffect(() => {
    if (!open || endpoint?.ok) return;
    void window.antseedDesktop?.gatewayGetEndpoint?.().then(setEndpoint);
  }, [endpoint?.ok, open]);
  return (
    <div className={styles.endpointCard}>
      <button type="button" className={styles.endpointHead} aria-expanded={open} onClick={() => setOpen(!open)}>
        <HugeiconsIcon icon={Key01Icon} size={14} strokeWidth={2} />
        <span className={styles.endpointTitle}>Use with any other tool</span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={14}
          strokeWidth={2}
          className={`${styles.endpointChevron}${open ? ` ${styles.endpointChevronOpen}` : ''}`}
        />
      </button>
      {open ? (
        <>
          <p className={styles.endpointHint}>
            Any tool that takes an OpenAI- or Anthropic-compatible base URL and API key works with your
            gateway. Paste these into its settings and pick a model there.
          </p>
          {endpoint?.ok && endpoint.baseUrl && endpoint.apiKey ? (
            <div className={styles.endpointRows}>
              <CopyRow label="Copy URL" value={endpoint.baseUrl} />
              <CopyRow label="Copy key" value={endpoint.apiKey} display={maskKey(endpoint.apiKey)} />
            </div>
          ) : (
            <p className={styles.endpointHint}>{endpoint?.error ?? 'Loading…'}</p>
          )}
          <div className={styles.actions}>
            <button type="button" onClick={() => onOpenConsole('/keys')}>Manage API keys</button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** The first clause of a connect error; the full text stays in the tooltip. */
function shortError(error: string): string {
  const first = error.split(/ — |\. /)[0]!.trim().replace(/\.$/, '');
  return first.length > 90 ? `${first.slice(0, 87)}…` : first;
}

export function VprToolsView() {
  const appsSnapshot = useCachedResource(appsResource);
  const profiles = appsSnapshot.data ?? [];
  // First-ever visit to this screen (however the user got here): play the
  // coach-mark walkthrough once, and mark it seen immediately so the nav dot
  // never comes back.
  const [showOnboarding, setShowOnboarding] = useState(() => !isAppsOnboardingSeen());
  useEffect(() => {
    if (showOnboarding) persistAppsOnboardingSeen();
  }, [showOnboarding]);
  // The app being connected or disconnected right now. Connecting also
  // restarts an app that was already running, so the row stays busy well
  // past the click.
  const [busy, setBusy] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [settingsPane, setSettingsPane] = useState<ModalPane>({ pane: 'main', dir: 'none' });
  const [pickerSearch, setPickerSearch] = useState('');
  const [identityDraft, setIdentityDraft] = useState('');
  // undefined = untouched; null = "default action" picked; entry = app picked.
  const [launchDraft, setLaunchDraft] = useState<InstalledAppEntry | null | undefined>(undefined);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const installedAppsResourceSnapshot = useCachedResource(installedAppsResource, false);
  const installedApps = installedAppsResourceSnapshot.data;
  const installedAppsError = installedAppsResourceSnapshot.error;

  const openConsole = useCallback((path: string) => {
    void window.antseedDesktop?.gatewayOpenConsole?.(path).then((result) => {
      if (result && !result.ok) setMessage(result.error ?? 'Could not open your gateway');
    });
  }, []);

  const openUrl = useCallback(async (url: string) => {
    const result = await window.antseedDesktop?.openExternalUrl?.(url);
    if (result && !result.ok) setMessage(result.error ?? 'Could not open tool');
  }, []);

  const openTool = useCallback(async (toolName: string) => {
    const result = await window.antseedDesktop?.openTool?.(toolName);
    if (result && !result.ok) setMessage(result.error ?? 'Could not open tool');
  }, []);

  const connectProfile = useCallback(async (profile: ConnectedAppProfile) => {
    const bridge = window.antseedDesktop;
    if (!bridge?.appsConnect) return;
    recordUserAction('app_connect', 'apps', normalizeTelemetryAppName(profile.name));
    setBusy(profile.name);
    setMessage(null);
    try {
      const result = await bridge.appsConnect(profile.name);
      await appsResource.refresh();
      if (!result.ok) {
        setMessage(shortError(result.error ?? `Could not connect ${profile.displayName}`));
        return;
      }
      // Bring the app itself forward — a user-picked application wins over
      // the packaged open-url action.
      if (profile.appAction === 'open-url' && profile.openUrl && !profile.launchAppName) {
        await openUrl(profile.openUrl);
      } else if (profile.launchAppName || profile.appAction === 'open-tool') {
        await openTool(profile.toolName ?? profile.name);
      }
    } finally {
      setBusy(null);
    }
  }, [openTool, openUrl]);

  const disconnectProfile = useCallback(async (profile: ConnectedAppProfile) => {
    const bridge = window.antseedDesktop;
    if (!bridge?.appsDisconnect) return;
    recordUserAction('app_disconnect', 'apps', normalizeTelemetryAppName(profile.name));
    setBusy(profile.name);
    setMessage(null);
    try {
      const result = await bridge.appsDisconnect(profile.name);
      await appsResource.refresh();
      if (!result.ok) setMessage(result.error ?? `Could not disconnect ${profile.displayName}`);
    } finally {
      setBusy(null);
    }
  }, []);

  const restartApp = useCallback(async (profileName: string, label: string) => {
    const bridge = window.antseedDesktop;
    if (!bridge?.appsRestartApp) return;
    setActionBusy(profileName);
    setMessage(null);
    try {
      const result = await bridge.appsRestartApp(profileName);
      setMessage(result.ok ? `Restarted ${label}` : (result.error ?? `Unable to restart ${label}`));
      if (result.ok) await appsResource.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
    }
  }, []);

  // ---------- Per-app settings modal ----------

  const ensureInstalledApps = useCallback(() => {
    if (installedApps === null && !installedAppsResourceSnapshot.loading) {
      void installedAppsResource.refresh();
    }
  }, [installedApps, installedAppsResourceSnapshot.loading]);

  const openSettings = useCallback((profile: ConnectedAppProfile) => {
    setSettingsFor(profile.name);
    setSettingsPane({ pane: 'main', dir: 'none' });
    setPickerSearch('');
    setIdentityDraft((profile.toolSlugs?.length ? profile.toolSlugs : [profile.name]).join(', '));
    setLaunchDraft(undefined);
    ensureInstalledApps();
  }, [ensureInstalledApps]);

  // Picking an application only stages a draft — it applies on Save.
  const chooseApp = useCallback((app: InstalledAppEntry | null) => {
    setLaunchDraft(app);
    setSettingsPane({ pane: 'main', dir: 'back' });
  }, []);

  const settingsProfile = settingsFor ? profiles.find((profile) => profile.name === settingsFor) ?? null : null;
  const settingsInfo = settingsProfile ? appInfo(settingsProfile) : null;
  const settingsIdentity = settingsProfile
    ? (settingsProfile.toolSlugs?.length ? settingsProfile.toolSlugs : [settingsProfile.name]).join(', ')
    : '';
  const identityDirty = settingsProfile !== null && identityDraft.trim() !== settingsIdentity;
  const launchDirty = settingsProfile !== null && launchDraft !== undefined
    && (launchDraft?.name ?? null) !== (settingsProfile.launchAppName ?? null);
  const settingsDirty = identityDirty || launchDirty;
  // The drafted pick wins over the persisted one for everything the modal shows.
  const settingsLaunchName = launchDraft === undefined
    ? settingsProfile?.launchAppName ?? null
    : launchDraft?.name ?? null;

  const saveSettings = useCallback(async () => {
    const bridge = window.antseedDesktop;
    if (!settingsFor || !bridge) return;
    setSettingsSaving(true);
    setMessage(null);
    try {
      if (launchDirty && bridge.appsSetAppLaunch) {
        const result = await bridge.appsSetAppLaunch({
          name: settingsFor,
          app: launchDraft ? { name: launchDraft.name, path: launchDraft.path } : null,
        });
        if (!result.ok) {
          setMessage(result.error ?? 'Could not save the app setting');
          return;
        }
      }
      if (identityDirty && bridge.appsSetAppIdentity) {
        const slugs = identityDraft.split(',').map((entry) => entry.trim()).filter(Boolean);
        const result = await bridge.appsSetAppIdentity({ name: settingsFor, toolSlugs: slugs.length > 0 ? slugs : null });
        if (!result.ok) {
          setMessage(result.error ?? 'Could not save the client names');
          return;
        }
      }
      // Sync drafts to the normalized values the main process persisted.
      const listed = (await appsResource.refresh()) ?? [];
      setLaunchDraft(undefined);
      const updated = listed.find((profile) => profile.name === settingsFor);
      if (updated) setIdentityDraft((updated.toolSlugs?.length ? updated.toolSlugs : [updated.name]).join(', '));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSettingsSaving(false);
    }
  }, [identityDirty, identityDraft, launchDirty, launchDraft, settingsFor]);

  const orderedProfiles = useMemo(
    // Connected apps float to the top; the sort is stable, so each group keeps its order.
    () => [...profiles].sort((a, b) => Number(b.connected) - Number(a.connected)),
    [profiles],
  );

  return (
    <section className={`view view-vpr-tools view-pinned-header ${styles.view}`} role="tabpanel">
      <VprPage title="Agents &amp; apps" root titleInBody>
      <div className={styles.stack}>
        {message ? <p className={styles.note} role="status">{message}</p> : null}

        <div className={styles.appScroll}>
          <AppsBanner title="Agents &amp; apps" subtitle="Let your agent call Antseed for another model, or run your apps on Antseed." />
          <VprCard className={styles.agentCard}>
            <AgentSkillsPanel />
          </VprCard>

          <div className={styles.listHeader}>
            <p className={styles.listTitle}>Run an app on Antseed&apos;s models</p>
            <p className={styles.listCaption}>The app uses your gateway as its model provider, and you pick models inside it.</p>
          </div>

          <div className={styles.appList}>
            <TelegramBotCard />
            {orderedProfiles.map((profile) => {
              const connected = profile.connected;
              const canRestart = connected && profile.canRestart === true;
              const notInstalled = !connected && profile.installed === false;
              const brandKey = resolveBrandKey(profile.name, profile.displayName);
              const profileCard = (
                <div key={profile.name} className={`${styles.appPill}${connected ? ` ${styles.appPillConnected}` : ''}`}>
                  <div className={styles.appHead}>
                    <span className={styles.appIdentity}>
                      {appLogoUrl(profile.name, profile.displayName) ? (
                        <img src={appLogoUrl(profile.name, profile.displayName)} alt="" className={styles.appLogo} />
                      ) : profile.iconDataUri && !isThemeAwareAppBrand(brandKey) ? (
                        <img src={profile.iconDataUri} alt="" className={styles.appIcon} />
                      ) : (
                        <BrandIcon brand={brandKey} size={24} />
                      )}
                      <span className={styles.appText}>
                        <span className={styles.appNameRow}>
                          {/* The name itself launches the associated app when one is available. */}
                          {profile.launchAppName || profile.appAction === 'open-url' || profile.appAction === 'open-tool' ? (
                            <button
                              type="button"
                              className={styles.appNameLink}
                              onClick={() => {
                                void (profile.appAction === 'open-url' && profile.openUrl && !profile.launchAppName
                                  ? openUrl(profile.openUrl)
                                  : openTool(profile.toolName ?? profile.name));
                              }}
                              title={`Open ${profile.launchAppName ?? profile.displayName}`}
                            >
                              {profile.displayName}
                            </button>
                          ) : (
                            <span className={styles.appName}>{profile.displayName}</span>
                          )}
                        </span>
                        {notInstalled ? (
                          <span className={`${styles.appMeta} ${styles.appMetaMuted}`}>Not installed</span>
                        ) : profile.error ? (
                          <span className={`${styles.appMeta} ${styles.appMetaWarning}`} title={profile.error}>
                            <span className={styles.restartDot} aria-hidden="true" />
                            {shortError(profile.error)}
                          </span>
                        ) : connected ? (
                          <span className={`${styles.appMeta}${profile.needsRestart ? ` ${styles.appMetaWarning}` : ''}`}>
                            <span className={profile.needsRestart ? styles.restartDot : styles.connectedDot} aria-hidden="true" />
                            {profile.needsRestart ? 'Restart required' : 'Connected'}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    {busy === profile.name ? (
                      <span
                        className={styles.appBusy}
                        role="status"
                        aria-label={`${connected ? 'Disconnecting' : 'Connecting'} ${profile.displayName}`}
                      />
                    ) : canRestart ? (
                      <button
                        type="button"
                        className={`${styles.appOpen}${profile.needsRestart ? ` ${styles.appRestartNeeded}` : ''}`}
                        onClick={() => { void restartApp(profile.name, profile.displayName); }}
                        disabled={actionBusy === profile.name}
                        aria-label={`Restart ${profile.displayName}`}
                        title={profile.needsRestart ? `Restart ${profile.displayName} to apply the connection` : `Restart ${profile.displayName}`}
                      >
                        <HugeiconsIcon icon={ArrowReloadHorizontalIcon} size={16} strokeWidth={2} />
                      </button>
                    ) : null}
                    {notInstalled ? null : <button
                      type="button"
                      className={`${styles.configAction}${settingsFor === profile.name ? ` ${styles.configActionActive}` : ''}`}
                      onClick={() => openSettings(profile)}
                      aria-haspopup="dialog"
                      aria-label={`${profile.displayName} settings`}
                      title={`${profile.displayName} settings`}
                    >
                      <HugeiconsIcon icon={Settings02Icon} size={15} strokeWidth={2} />
                    </button>}
                    {connected ? (
                      <button
                        type="button"
                        role="switch"
                        aria-checked
                        className={styles.connectedToggle}
                        disabled={busy !== null}
                        onClick={() => { void disconnectProfile(profile); }}
                        aria-label={`Disconnect ${profile.displayName}`}
                        title={`Disconnect ${profile.displayName}`}
                      >
                        <span />
                      </button>
                    ) : notInstalled ? (
                      profile.downloadUrl ? (
                        <button
                          type="button"
                          className={styles.downloadAction}
                          onClick={() => { void openUrl(profile.downloadUrl!); }}
                          title={`Get ${profile.displayName}, then connect it here`}
                        >
                          Download
                          <HugeiconsIcon icon={ArrowUpRight01Icon} size={13} strokeWidth={2} />
                        </button>
                      ) : null
                    ) : (
                      <button
                        type="button"
                        className={styles.connectAction}
                        disabled={busy !== null}
                        onClick={() => { void connectProfile(profile); }}
                      >
                        Connect
                      </button>
                    )}
                  </div>
                </div>
              );
              return profileCard;
            })}
          </div>

          <GatewayEndpointCard onOpenConsole={openConsole} />
        </div>

        <div className={styles.appFooter}>
          <button type="button" className={styles.learnMore} onClick={() => setHelpOpen(true)}>
            What are connected apps?
          </button>
        </div>
      </div>
      </VprPage>

      {showOnboarding && <AppsOnboarding onDone={() => setShowOnboarding(false)} />}

      <Modal
        isOpen={helpOpen}
        onClose={() => setHelpOpen(false)}
        size="sm"
        title="Connected apps"
        subtitle="How your tools use your gateway"
        bodyClassName={styles.settingsBody}
      >
        <section className={styles.settingSection}>
          <div className={styles.settingHead}>
            <span className={styles.settingTitle}>What connecting does</span>
          </div>
          <p className={styles.settingHint}>
            Connecting points the app at your Antseed gateway with an API key, through a small change to the
            app&apos;s own config file — written on Connect and removed on Disconnect (a backup of the original is
            kept next to it). Requests are served by the Antseed network and paid from your gateway&apos;s balance.
          </p>
        </section>
        <section className={styles.settingSection}>
          <div className={styles.settingHead}>
            <span className={styles.settingTitle}>Choosing models</span>
          </div>
          <p className={styles.settingHint}>
            Connected apps list the gateway&apos;s models in their own model picker. Pick and switch models
            inside each app, the way you normally would. Start a new session after connecting so the app reads
            its new settings.
          </p>
        </section>
        <section className={styles.settingSection}>
          <div className={styles.settingHead}>
            <span className={styles.settingTitle}>Keys, usage and limits</span>
          </div>
          <p className={styles.settingHint}>
            Usage, spend limits and API keys are managed in your gateway. By default every app shares one key;
            switch to a key per app in Settings to see usage per app.
          </p>
          <div className={styles.settingActions}>
            <button type="button" className={styles.settingQuiet} onClick={() => openConsole('/keys')}>
              Open your gateway
              <HugeiconsIcon icon={ArrowUpRight01Icon} size={12} strokeWidth={2} />
            </button>
          </div>
        </section>
      </Modal>

      {/* Per-app settings: the application to open and the request-identity
          client names, edited as drafts and applied by Save, plus Disconnect. */}
      <Modal
        isOpen={settingsProfile !== null}
        onClose={() => setSettingsFor(null)}
        size="sm"
        title={settingsPane.pane === 'apps' ? (
          <span className={styles.modalBackTitle}>
            <button
              type="button"
              className={styles.paneBackButton}
              onClick={() => setSettingsPane({ pane: 'main', dir: 'back' })}
              aria-label="Back"
            >
              <HugeiconsIcon icon={ArrowLeft01Icon} size={15} strokeWidth={2} />
            </button>
            Choose application
          </span>
        ) : (settingsProfile?.displayName ?? 'App settings')}
        subtitle={settingsPane.pane === 'apps'
          ? undefined
          : settingsInfo ? (
            <span className={styles.modalAppSubtitle}>
              {settingsInfo.description}
              {settingsInfo.websiteUrl ? (
                <button
                  type="button"
                  className={styles.settingWebsiteLink}
                  onClick={() => void openUrl(settingsInfo.websiteUrl!)}
                >
                  Website / download
                  <HugeiconsIcon icon={ArrowUpRight01Icon} size={12} strokeWidth={2} />
                </button>
              ) : null}
            </span>
          ) : undefined}
        bodyClassName={styles.settingsBody}
      >
        {settingsProfile ? (
          <div key={settingsPane.pane} className={`${styles.pane}${settingsPane.dir === 'forward' ? ` ${styles.paneForward}` : settingsPane.dir === 'back' ? ` ${styles.paneBack}` : ''}`}>
            {settingsPane.pane === 'apps' ? (
              <AppPickerPane
                apps={installedApps}
                error={installedAppsError}
                search={pickerSearch}
                onSearch={setPickerSearch}
                activeName={settingsLaunchName}
                onChoose={chooseApp}
                noneLabel="Default action"
                noneMeta="Use the app’s built-in open behavior"
              />
            ) : (
              <>
                <section className={styles.settingSection}>
                  <div className={styles.settingHead}>
                    <span className={styles.settingTitle}>Connection</span>
                    {settingsProfile.connected ? (
                      <span className={styles.settingConnected}>
                        <span className={styles.connectedDot} aria-hidden="true" />
                        Connected
                      </span>
                    ) : null}
                  </div>
                  <p className={styles.settingHint}>
                    {settingsProfile.connected
                      ? `${settingsProfile.displayName} uses your gateway. Disconnecting restores its original settings.`
                      : `Connect from the apps list to point ${settingsProfile.displayName} at your gateway.`}
                  </p>
                </section>

                <section className={styles.settingSection}>
                  <div className={styles.settingHead}>
                    <span className={styles.settingTitle}>Application</span>
                  </div>
                  <p className={styles.settingHint}>
                    The installed application launched for {settingsProfile.displayName} — used by the restart
                    button and when jumping back into a chat session.
                  </p>
                  <button
                    type="button"
                    className={styles.settingValueRow}
                    onClick={() => setSettingsPane({ pane: 'apps', dir: 'forward' })}
                  >
                    {settingsProfile.iconDataUri
                      ? <img src={settingsProfile.iconDataUri} alt="" className={styles.pickerIcon} />
                      : <BrandIcon name={settingsProfile.name} hints={[settingsProfile.displayName]} size={20} />}
                    <span className={styles.settingValueName}>{settingsLaunchName ?? 'Default action'}</span>
                    <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={2} className={styles.settingValueChevron} />
                  </button>
                </section>

                <section className={styles.settingSection}>
                  <div className={styles.settingHead}>
                    <span className={styles.settingTitle}>Request identity</span>
                  </div>
                  <p className={styles.settingHint}>
                    Requests are matched to {settingsProfile.displayName} by the client name they carry — the
                    User-Agent product or session header, like <code>opencode</code> or <code>codex</code>.
                    Separate multiple names with commas.
                  </p>
                  <form
                    className={styles.settingInputRow}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveSettings();
                    }}
                  >
                    <input
                      type="text"
                      className={styles.settingInput}
                      value={identityDraft}
                      placeholder={settingsProfile.name}
                      spellCheck={false}
                      onChange={(event) => setIdentityDraft(event.currentTarget.value)}
                      disabled={settingsSaving}
                    />
                  </form>
                </section>

                <div className={styles.settingFooter}>
                  {settingsDirty ? (
                    <button
                      type="button"
                      className={styles.settingPrimary}
                      disabled={settingsSaving || busy !== null}
                      onClick={() => void saveSettings()}
                    >
                      {settingsSaving ? 'Saving...' : 'Save'}
                    </button>
                  ) : settingsProfile.connected ? (
                    <button
                      type="button"
                      className={styles.settingDanger}
                      disabled={busy !== null}
                      onClick={() => { void disconnectProfile(settingsProfile); }}
                    >
                      Disconnect
                    </button>
                  ) : null}
                </div>
              </>
            )}
          </div>
        ) : null}
      </Modal>
    </section>
  );
}

/** Application-list pane the settings modal slides to: a
    searchable list with a "none" row first. The back affordance lives in
    the modal header (title swaps to back + "Choose application"). */
function AppPickerPane({ apps, error, search, onSearch, activeName, onChoose, noneLabel, noneMeta }: {
  apps: InstalledAppEntry[] | null;
  error: string | null;
  search: string;
  onSearch: (value: string) => void;
  /** Currently associated application name, or null when none is set. */
  activeName: string | null;
  onChoose: (app: InstalledAppEntry | null) => void;
  noneLabel: string;
  noneMeta: string;
}) {
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    const list = apps ?? [];
    return query ? list.filter((app) => app.name.toLowerCase().includes(query)) : list;
  }, [apps, search]);

  return (
    <div className={styles.pickerStack}>
      <VprSearch value={search} onChange={onSearch} placeholder="Search applications" />
      <div className={styles.pickerList}>
        <button
          type="button"
          className={`${styles.pickerRow}${activeName === null ? ` ${styles.pickerRowActive}` : ''}`}
          onClick={() => onChoose(null)}
        >
          <span className={styles.pickerRowText}>
            <span className={styles.pickerRowName}>{noneLabel}</span>
            <span className={styles.pickerRowMeta}>{noneMeta}</span>
          </span>
          {activeName === null ? <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2} /> : null}
        </button>
        {apps === null ? (
          <div className={styles.pickerEmpty}>Loading applications...</div>
        ) : error ? (
          <div className={styles.pickerEmpty}>{error}</div>
        ) : filtered.length === 0 ? (
          <div className={styles.pickerEmpty}>No applications match your search</div>
        ) : (
          filtered.map((app) => (
            <button
              type="button"
              key={app.path}
              className={`${styles.pickerRow}${activeName === app.name ? ` ${styles.pickerRowActive}` : ''}`}
              onClick={() => onChoose(app)}
              title={app.path}
            >
              {app.iconDataUri
                ? <img src={app.iconDataUri} alt="" className={styles.pickerIcon} />
                : <BrandIcon name={app.name} hints={[app.name]} size={20} />}
              <span className={styles.pickerRowText}>
                <span className={styles.pickerRowName}>{app.name}</span>
              </span>
              {activeName === app.name ? <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2} /> : null}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
