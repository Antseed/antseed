import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowUp02Icon } from '@hugeicons/core-free-icons';
import { useCachedResource } from '../../../modules/app/cached-resource';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import type { ViewName } from '../../types';
import { ChatModelDropdown } from '../chat/ChatModelDropdown';
import { ChatSellerPicker } from '../chat/ChatSellerPicker';
import { joinPinnedModel, splitPinnedModel } from '../../../../shared/pinned-model.js';
import { AgentSkillsPanel } from '../vpr/AgentSkillsPanel';
import { HomeField } from '../vpr/HomeField';
import { modelsForPrivacy, PrivacyNote, PrivacyToggle, usePrivacyControl } from '../vpr/PrivacyToggle';
import { privacyResource, usePrivacySwitch } from '../../../modules/app/vpr-resources';
import styles from './VprHomeView.module.scss';

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
  }), shallowEqual);
  const [draft, setDraft] = useState('');
  const privacy = useCachedResource(privacyResource);
  const privateMode = privacy.data?.mode === 'private';
  const { switching } = usePrivacySwitch();
  const privacyControl = usePrivacyControl((mode) => { actions.privacyModeChosen(mode); });
  const models = modelsForPrivacy(snap.chatModels, privateMode);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // The prompt grows with its text, up to a few lines.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [draft]);

  function submitDraft(): void {
    const text = draft.trim();
    // The model may still move once Private's list is in.
    if (!text || switching || (privateMode && snap.chatModelsLoading)) return;
    // Home always starts a new chat rather than continuing the open one.
    if (snap.chatActiveConversation) actions.startNewChatOnModel(snap.chatSelectedModelId);
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

      </div>
    </section>
  );
}
