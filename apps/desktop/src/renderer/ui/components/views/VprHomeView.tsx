import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowUp02Icon } from '@hugeicons/core-free-icons';
import { useCachedResource } from '../../../modules/app/cached-resource';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import type { ViewName } from '../../types';
import { ChatModelDropdown } from '../chat/ChatModelDropdown';
import { ChatSellerPicker } from '../chat/ChatSellerPicker';
import { joinPinnedModel } from '../../../../shared/pinned-model.js';
import { HomeField } from '../vpr/HomeField';
import { PrivacyNote, PrivacyToggle, usePrivacyControl } from '../vpr/PrivacyToggle';
import { privacyResource } from '../../../modules/app/vpr-resources';
import { homeProgress, useHomeProgress } from '../../../modules/app/home-progress';
import { HomeDashboard } from './HomeDashboard';
import styles from './VprHomeView.module.scss';
import { modelsForPrivacy } from '../../hooks/usePrivateMode';

type Props = { onSelectView?: (view: ViewName) => void };

const COMPOSER_MAX_HEIGHT = 200;

export function VprHomeView({ onSelectView }: Props) {
  const actions = useActions();
  const snap = useUiSelector((state) => ({
    chatModels: state.chatModels,
    chatModelsLoading: state.chatModelsLoading,
    chatModelsError: state.chatModelsError,
    chatSelectedModelId: state.chatSelectedModelId,
    chatImageModelId: state.chatImageModelId,
    chatActiveConversation: state.chatActiveConversation,
    chatConversationsLoaded: state.chatConversationsLoaded,
    hasConversations: state.chatConversations.length > 0,
  }), shallowEqual);
  const progress = useHomeProgress();
  const [draft, setDraft] = useState('');
  const privacy = useCachedResource(privacyResource);
  const privateMode = privacy.data?.mode === 'private';
  // Counts the user's switches, so a dismissed privacy note can flash back.
  const [privacySwitches, setPrivacySwitches] = useState(0);
  const privacyControl = usePrivacyControl((mode, choice) => {
    actions.privacyModeChosen(mode, choice);
    setPrivacySwitches((count) => count + 1);
  });
  const models = modelsForPrivacy(snap.chatModels, privateMode);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Someone who chatted before Home tracked progress has sent their first prompt.
  useEffect(() => {
    if (snap.chatConversationsLoaded && snap.hasConversations) homeProgress.markFirstPrompt();
  }, [snap.chatConversationsLoaded, snap.hasConversations]);
  const beforeFirstPrompt = progress.firstPromptAt === null;

  // The prompt grows with its text, up to a few lines.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [draft]);

  function submitDraft(): void {
    const text = draft.trim();
    // A send during a privacy switch is held until it lands. The model may still
    // move once Private's list is in. An image chat needs a text model too.
    if (!text || !snap.chatSelectedModelId || (privateMode && snap.chatModelsLoading)) return;
    // Home always starts a new chat rather than continuing the open one.
    if (snap.chatActiveConversation) actions.startNewChatOnModel(snap.chatSelectedModelId);
    if (snap.chatImageModelId) {
      actions.generateImage(text);
    } else {
      actions.sendMessage(text);
    }
    setDraft('');
    homeProgress.markFirstPrompt();
    onSelectView?.('chat');
  }

  return (
    <section className={`view view-vpr-home ${styles.view}${privateMode ? '' : ` ${styles.day}`}`} role="tabpanel">
      <HomeField night={privacy.data ? privateMode : undefined} />
      <div className={styles.dragBar} aria-hidden="true" />
      {beforeFirstPrompt ? (
        <>
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
                    disabled={draft.trim().length === 0 || !snap.chatSelectedModelId}
                  >
                    <HugeiconsIcon icon={ArrowUp02Icon} size={20} strokeWidth={2} />
                  </button>
                </div>
              </form>
              <div data-glide-fade>
                <PrivacyNote control={privacyControl} switches={privacySwitches} />
              </div>
            </div>

            <div className={styles.setup} data-glide-fade>
              <HomeDashboard onSelectView={onSelectView} setupOnly />
            </div>

          </div>
        </>
      ) : (
        <div className={styles.scroll} data-view-scroll data-glide-fade>
          <HomeDashboard onSelectView={onSelectView} />
        </div>
      )}
    </section>
  );
}
