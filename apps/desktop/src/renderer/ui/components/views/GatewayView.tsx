import { useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import type { IconSvgElement } from '@hugeicons/react';
import { ArrowLeft01Icon, ArrowUpRight01Icon, Building03Icon, RoboticIcon, UserMultipleIcon } from '@hugeicons/core-free-icons';
import { Button, CodeBlock } from '@antseed/ui';
import type { ChatModel, GatewayStatus } from '../../../types/bridge';
import type { ViewName } from '../../types';
import { splitPinnedModel } from '../../../../shared/pinned-model.js';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useCachedResource } from '../../../modules/app/cached-resource';
import { gatewayResource, privacyResource } from '../../../modules/app/vpr-resources';
import { openGatewayConsole } from '../../../modules/app/console-launch';
import { homeProgress } from '../../../modules/app/home-progress';
import { HomeField } from '../vpr/HomeField';
import homeStyles from './VprHomeView.module.scss';
import dashStyles from './HomeDashboard.module.scss';
import styles from './GatewayView.module.scss';

type Props = { onSelectView?: (view: ViewName) => void };

/** The chip above the headline: whether the gateway answers, and where it is when it isn't this app's own. */
export function gatewayChip(status: GatewayStatus | undefined): { text: string; warn: boolean } {
  if (!status) return { text: 'Starting', warn: false };
  const state = status.reachable ? 'Online' : status.starting ? 'Starting' : 'Unreachable';
  const host = status.mode === 'remote' ? hostOf(status.origin) : null;
  return { text: host ? `${state} · ${host}` : state, warn: !status.reachable && !status.starting };
}

function hostOf(origin: string | null): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).host || null;
  } catch {
    return origin.replace(/^https?:\/\//, '').replace(/\/.*$/, '') || null;
  }
}

/** A chat model from the gateway's list for the example: the one chat uses, else a free one, else any. */
export function exampleModelId(models: readonly ChatModel[], selectedModelId: string | null): string {
  const chatModels = models.filter((model) => model.protocol !== null);
  const selected = splitPinnedModel(selectedModelId).modelId;
  // A model only low-trust sellers serve is never the example, unless it is the chat's own pick.
  const trusted = chatModels.filter((model) => !model.lowTrust);
  const pick = chatModels.find((model) => model.id === selected)
    ?? trusted.find((model) => model.free)
    ?? trusted[0]
    ?? chatModels[0];
  return pick?.id ?? '<model>';
}

/** A Chat Completions call to the gateway, with a placeholder for the key. */
export function curlSnippet(origin: string | null, modelId: string): string {
  const base = origin ? origin.replace(/\/+$/, '') : '<gateway-url>';
  const body = JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'Hello' }] }).replace(/'/g, `'\\''`);
  return [
    `curl ${base}/v1/chat/completions \\`,
    '  -H "Authorization: Bearer <your key>" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '${body}'`,
  ].join('\n');
}

const USES: { icon: IconSvgElement; title: string; text: string }[] = [
  { icon: UserMultipleIcon, title: 'People', text: 'Give a friend or teammate their own key with a spending limit.' },
  { icon: RoboticIcon, title: 'Your running agents', text: 'Point any agent or script at your gateway with an API key.' },
  { icon: Building03Icon, title: 'Your company', text: 'Invite your organization, set rules once, see usage per person.' },
];

export type GatewayPageProps = {
  status: GatewayStatus | undefined;
  modelId: string;
  trying: boolean;
  onTry: () => void;
  onBack: () => void;
  /** Opens a page of the gateway console in the browser. */
  onOpenConsole: (path: string) => void;
  /** Opens the console's new-key form. */
  onCreateKey: () => void;
};

/**
 * What the gateway is for (keys, limits and usage for people, agents and a
 * company), then a short try-out: make a key, call it, see the request land.
 */
export function GatewayPage({ status, modelId, trying, onTry, onBack, onOpenConsole, onCreateKey }: GatewayPageProps) {
  const chip = gatewayChip(status);
  const consoleLink = (
    <Button
      variant="link"
      trailingIcon={<HugeiconsIcon icon={ArrowUpRight01Icon} size={14} strokeWidth={2} />}
      onClick={() => onOpenConsole('/')}
    >
      Open full console
    </Button>
  );
  return (
    <div className={`${dashStyles.page} ${styles.page}`}>
      <header className={dashStyles.header}>
        <span className={`${dashStyles.status}${chip.warn ? ` ${dashStyles.statusWarn}` : ''}`}>
          <span className={dashStyles.statusDot} />
          {chip.text}
        </span>
        <h1 className={dashStyles.heading}>{trying ? 'Try your gateway' : 'Host it once. Share it with anyone.'}</h1>
        {trying ? null : (
          <p className={dashStyles.subline}>Give people, agents and your company their own keys, limits and usage.</p>
        )}
      </header>

      {trying ? (
        <>
          <section className={`${dashStyles.card} ${styles.card}`} aria-label="Try your gateway">
            <ol className={dashStyles.steps}>
              <li className={dashStyles.step}>
                <span className={dashStyles.stepMark} aria-hidden="true">1</span>
                <div className={`${dashStyles.stepBody} ${styles.stepBody}`}>
                  <h2 className={dashStyles.stepTitle}>Create a key</h2>
                  <p className={dashStyles.stepText}>One for each person, agent or script, with its own spending limit.</p>
                  <div className={dashStyles.stepActions}>
                    <Button
                      variant="brand"
                      size="sm"
                      trailingIcon={<HugeiconsIcon icon={ArrowUpRight01Icon} size={14} strokeWidth={2} />}
                      onClick={onCreateKey}
                    >
                      Create a key
                    </Button>
                  </div>
                </div>
              </li>
              <li className={dashStyles.step}>
                <span className={dashStyles.stepMark} aria-hidden="true">2</span>
                <div className={`${dashStyles.stepBody} ${styles.stepBody}`}>
                  <h2 className={dashStyles.stepTitle}>Call it from anything</h2>
                  <p className={dashStyles.stepText}>Any tool that speaks the OpenAI or Anthropic API works. Put your key in place of the placeholder.</p>
                  <CodeBlock code={curlSnippet(status?.origin ?? null, modelId)} label="curl" />
                </div>
              </li>
              <li className={dashStyles.step}>
                <span className={dashStyles.stepMark} aria-hidden="true">3</span>
                <div className={`${dashStyles.stepBody} ${styles.stepBody}`}>
                  <h2 className={dashStyles.stepTitle}>See it arrive</h2>
                  <p className={dashStyles.stepText}>Each request shows up in the request log with its key, model and cost.</p>
                  <div className={dashStyles.stepActions}>
                    <Button
                      variant="link"
                      trailingIcon={<HugeiconsIcon icon={ArrowUpRight01Icon} size={14} strokeWidth={2} />}
                      onClick={() => onOpenConsole('/logs')}
                    >
                      Open the request log
                    </Button>
                  </div>
                </div>
              </li>
            </ol>
          </section>
          <div className={styles.actions}>
            <Button
              variant="link"
              leadingIcon={<HugeiconsIcon icon={ArrowLeft01Icon} size={14} strokeWidth={2} />}
              onClick={onBack}
            >
              Back
            </Button>
            {consoleLink}
          </div>
        </>
      ) : (
        <>
          <section className={`${dashStyles.card} ${styles.card} ${styles.uses}`} aria-label="Who it is for">
            {USES.map((use) => (
              <div key={use.title} className={styles.use}>
                <HugeiconsIcon icon={use.icon} size={34} strokeWidth={1.3} className={styles.useIcon} />
                <h2 className={styles.useTitle}>{use.title}</h2>
                <p className={styles.useText}>{use.text}</p>
              </div>
            ))}
          </section>
          <div className={`${styles.actions} ${styles.actionsCentered}`}>
            <Button variant="brand" onClick={onTry}>Try it out</Button>
            {consoleLink}
          </div>
        </>
      )}
    </div>
  );
}

/** The Gateway page: the value of sharing the gateway, before anyone is sent to its console. */
export function GatewayView(_props: Props) {
  const gateway = useCachedResource(gatewayResource);
  const privacy = useCachedResource(privacyResource);
  const privateMode = privacy.data?.mode === 'private';
  const { chatModels, chatSelectedModelId } = useUiSelector((state) => ({
    chatModels: state.chatModels,
    chatSelectedModelId: state.chatSelectedModelId,
  }), shallowEqual);
  const [trying, setTrying] = useState(false);

  return (
    <section
      className={`view view-gateway ${homeStyles.view} ${styles.view}${privateMode ? '' : ` ${homeStyles.day}`}`}
      role="tabpanel"
    >
      <HomeField night={privacy.data ? privateMode : undefined} />
      <div className={homeStyles.dragBar} aria-hidden="true" />
      <div className={homeStyles.scroll} data-view-scroll data-glide-fade>
        <GatewayPage
          status={gateway.data?.status}
          modelId={exampleModelId(chatModels, chatSelectedModelId)}
          trying={trying}
          onTry={() => setTrying(true)}
          onBack={() => setTrying(false)}
          onOpenConsole={(path) => { void openGatewayConsole(path); }}
          // The same new-key form Home's setup step opens.
          onCreateKey={() => { void openGatewayConsole('/keys?new=1').then((opened) => { if (opened) homeProgress.markKey(); }); }}
        />
      </div>
    </section>
  );
}
