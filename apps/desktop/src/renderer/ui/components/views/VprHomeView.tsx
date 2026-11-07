import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowUp02Icon } from '@hugeicons/core-free-icons';
import type { ConnectedAppProfile } from '../../../types/bridge';
import { appsResource } from '../../../modules/app/vpr-resources';
import { useCachedResource } from '../../../modules/app/cached-resource';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import type { ViewName } from '../../types';
import { recordUserAction } from '../../../modules/telemetry/actions';
import { normalizeTelemetryAppName } from '../../../../shared/telemetry.js';
import { ChatModelDropdown } from '../chat/ChatModelDropdown';
import { ChatSellerPicker } from '../chat/ChatSellerPicker';
import { joinPinnedModel, splitPinnedModel } from '../../../../shared/pinned-model.js';
import { AgentSkillsPanel } from '../vpr/AgentSkillsPanel';
import { AppPillIcon, appPillStyles as pills } from '../vpr/AppPills';
import { HomeField } from '../vpr/HomeField';
import { chooseDefaultChatModel } from '../../../modules/chat/models';
import { modelsForPrivacy, PrivacyNote, PrivacyToggle, usePrivacyControl } from '../vpr/PrivacyToggle';
import { privacyResource, usePrivacySwitch } from '../../../modules/app/vpr-resources';
import styles from './VprHomeView.module.scss';

type Props = { onSelectView?: (view: ViewName) => void };

const COMPOSER_MAX_HEIGHT = 200;

/** Survives leaving Home and coming back while Private is on. */
let modelMovedForPrivate: { from: string; to: string } | null = null;

export function VprHomeView({ onSelectView }: Props) {
  const actions = useActions();
  const snap = useUiSelector((state) => ({
    chatModels: state.chatModels,
    chatModelsLoading: state.chatModelsLoading,
    chatModelsError: state.chatModelsError,
    chatSelectedModelId: state.chatSelectedModelId,
    chatImageModelId: state.chatImageModelId,
    chatActiveConversation: state.chatActiveConversation,
  }), shallowEqual);
  const apps = useCachedResource(appsResource);
  const [draft, setDraft] = useState('');
  const [connecting, setConnecting] = useState<string | null>(null);
  const privacy = useCachedResource(privacyResource);
  const privateMode = privacy.data?.mode === 'private';
  const { switching } = usePrivacySwitch();
  const privacyControl = usePrivacyControl((mode) => {
    if (mode !== 'private') {
      // Back from Private: return to the model Private moved away from, unless
      // the user has since picked another one.
      const previous = modelMovedForPrivate;
      modelMovedForPrivate = null;
      if (!previous || snap.chatSelectedModelId !== previous.to) return;
      if (snap.chatActiveConversation) actions.startNewChat();
      actions.selectChatModel(previous.from);
      return;
    }
    // Private lists only models a TEE seller serves: move off one that isn't.
    const { modelId: listedId } = splitPinnedModel(snap.chatSelectedModelId);
    const selected = snap.chatModels.find((model) => model.id === listedId);
    if (!selected || selected.tee) return;
    const next = chooseDefaultChatModel(snap.chatModels.filter((model) => model.tee), null);
    if (!next) return;
    modelMovedForPrivate = { from: snap.chatSelectedModelId, to: next };
    if (snap.chatActiveConversation) actions.startNewChat();
    actions.selectChatModel(next);
  });
  // The gateway lists what the key's policy allows, so a seller's price and the
  // Free badge change with the mode: re-read once the switch has landed.
  const landedMode = switching ? null : privacy.data?.mode ?? null;
  const previousMode = useRef(landedMode);
  useEffect(() => {
    if (!landedMode) return;
    const changed = previousMode.current !== null && previousMode.current !== landedMode;
    previousMode.current = landedMode;
    if (changed) void actions.refreshChatModels(true);
  }, [actions, landedMode]);
  const models = modelsForPrivacy(snap.chatModels, privateMode);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const appListRef = useRef<HTMLDivElement>(null);

  const profiles = apps.data ?? [];
  const connectedCount = profiles.filter((profile) => profile.connected).length;

  // Home never scrolls: when the window is too short for every app row, the
  // rows that would be cut off are hidden whole (all apps are on the Apps page).
  useLayoutEffect(() => {
    const list = appListRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return undefined;
    const clipRows = () => {
      for (const pill of Array.from(list.children) as HTMLElement[]) {
        pill.classList.toggle(pills.pillClipped, pill.offsetTop + pill.offsetHeight > list.clientHeight + 1);
      }
    };
    const observer = new ResizeObserver(clipRows);
    observer.observe(list);
    clipRows();
    return () => observer.disconnect();
  }, [apps.data, connecting]);

  // The prompt grows with its text, up to a few lines.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [draft]);

  async function connectApp(profile: ConnectedAppProfile): Promise<void> {
    if (profile.connected) {
      onSelectView?.('tools');
      return;
    }
    if (connecting) return;
    recordUserAction('app_connect', 'home', normalizeTelemetryAppName(profile.name));
    setConnecting(profile.name);
    try {
      const result = await window.antseedDesktop?.appsConnect?.(profile.name);
      void appsResource.refresh();
      if (!result?.ok) onSelectView?.('tools');
    } finally {
      setConnecting(null);
    }
  }

  function submitDraft(): void {
    const text = draft.trim();
    if (!text || switching) return;
    // Home always starts a new chat rather than continuing the open one.
    if (snap.chatActiveConversation) actions.startNewChat();
    if (snap.chatImageModelId) {
      actions.generateImage(text);
    } else {
      actions.sendMessage(text);
    }
    setDraft('');
    onSelectView?.('chat');
  }

  return (
    <section className={`view view-vpr-home ${styles.view}${privateMode ? '' : ` ${styles.day}`}`} role="tabpanel">
      <HomeField night={privacy.data ? privateMode : undefined} />
      <div className={styles.dragBar} aria-hidden="true" />
      <div className={styles.toggleSlot} data-glide-fade>
        <PrivacyToggle control={privacyControl} />
      </div>
      <div className={styles.stack}>
        <div className={styles.hero}>
          <h1 className={styles.heading} data-glide-fade>
            {privateMode ? <>Private,<br /> and proven</> : <>Ask anything,<br /> on any model</>}
          </h1>
          <p className={styles.subline} data-glide-fade>At the best available prices, with the privacy you want.</p>
          <form
            className={styles.composer}
            data-composer
            onSubmit={(event) => { event.preventDefault(); submitDraft(); }}
          >
            <textarea
              ref={inputRef}
              className={styles.askInput}
              rows={2}
              value={draft}
              placeholder="Ask anything…"
              aria-label="Ask anything, on any model"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submitDraft();
                }
              }}
            />
            <div className={styles.composerFooter}>
              <ChatModelDropdown
                models={models}
                selectedModelId={snap.chatImageModelId ?? snap.chatSelectedModelId}
                loading={snap.chatModelsLoading}
                error={snap.chatModelsError}
                disabled={false}
                onSelect={(modelId) => {
                  // Picks the model for the new chat Home starts, not the open conversation's.
                  if (snap.chatActiveConversation) actions.startNewChat();
                  actions.selectChatModel(modelId);
                }}
                onOpen={() => void actions.refreshChatModels()}
                onRetry={() => void actions.refreshChatModels(true)}
                menuMaxHeight={320}
                menuAnchor="container"
              />
              {!snap.chatImageModelId && snap.chatSelectedModelId ? (
                <ChatSellerPicker
                  modelId={snap.chatSelectedModelId}
                  disabled={false}
                  onChange={(peerId) => {
                    const pinned = joinPinnedModel(snap.chatSelectedModelId, peerId);
                    if (snap.chatActiveConversation) actions.startNewChat();
                    actions.selectChatModel(pinned);
                  }}
                  menuMaxHeight={320}
                  menuAnchor="container"
                />
              ) : null}
              <span className={styles.composerSpacer} />
              <button
                type="submit"
                className={styles.askSend}
                aria-label="Send message"
                title="Send message"
                disabled={draft.trim().length === 0 || switching}
              >
                <HugeiconsIcon icon={ArrowUp02Icon} size={20} strokeWidth={2} />
              </button>
            </div>
          </form>
          <div data-glide-fade>
            <PrivacyNote control={privacyControl} />
          </div>
        </div>

        <div data-glide-fade>
          <AgentSkillsPanel className={`${styles.glass} ${styles.agents}`} />
        </div>

        <div className={`${styles.glass} ${styles.appsSection}`} data-glide-fade>
          <div className={styles.sectionHeader}>
            <p className={styles.sectionTitle}>
              {connectedCount > 0 ? `${connectedCount} ${connectedCount === 1 ? 'app' : 'apps'} connected` : 'Connect your apps'}
            </p>
            <button type="button" className={styles.sectionLink} onClick={() => onSelectView?.('tools')}>
              All apps
            </button>
          </div>
          <p className={styles.sectionCaption}>
            Or run an app on Antseed&apos;s models: it uses your gateway as its model provider, and you pick models inside it.
          </p>
          <div className={`${pills.pillList} ${styles.appList}`} ref={appListRef}>
            {profiles.map((profile) => (
              <button
                key={profile.name}
                type="button"
                className={`${pills.pill}${profile.connected ? ` ${pills.pillActive}` : ''}`}
                disabled={!profile.connected && connecting !== null}
                onClick={() => { void connectApp(profile); }}
                title={profile.connected ? `${profile.displayName} is connected` : `Connect ${profile.displayName}`}
              >
                <AppPillIcon name={profile.name} displayName={profile.displayName} iconDataUri={profile.iconDataUri} />
                <span className={pills.pillLabel}>
                  {connecting === profile.name ? 'Connecting…' : profile.displayName}
                </span>
                {profile.connected && <span className={pills.pillDot} aria-label="Connected" />}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
