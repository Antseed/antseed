import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Copy01Icon,
  LinkSquare02Icon,
  MinusSignIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons';
import { useCopyFeedback } from '@antseed/ui';
import type { AgentSkillTarget, GatewayEndpointInfo, GatewayRewardsSummary, GatewaySavings } from '../../../types/bridge';
import type { ViewName } from '../../types';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { selectHeadlineBalanceUsdc } from '../../../core/balance';
import { formatCredits } from '../../../core/format';
import { useCachedResource } from '../../../modules/app/cached-resource';
import { appsResource, gatewayResource } from '../../../modules/app/vpr-resources';
import { homeProgress, useHomeProgress } from '../../../modules/app/home-progress';
import { daysSince, LOW_BALANCE_USD, pickHomePromo, promoDismissKey } from '../../../modules/app/home-promos';
import { AppPillIcon } from '../vpr/AppPills';
import { usePrivateMode } from '../vpr/PrivacyToggle';
import styles from './HomeDashboard.module.scss';

const NEXT_STEP_LABELS = [
  'Send your first prompt',
  'Add Antseed to your agent or app',
  'Make your first deposit',
  'Get API keys for more agents',
];
const AGENT_ICON_LIMIT = 6;

function usd(value: string | number): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `$${numeric.toFixed(2)}` : '—';
}

function savedUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0';
  if (value < 0.01) return '<$0.01';
  if (value >= 1000) return `$${(value / 1000).toFixed(1)}k`;
  return `$${value.toFixed(2)}`;
}

type Props = {
  onSelectView?: (view: ViewName) => void;
  /** Before the first prompt Home shows only the setup card, under its chat box. */
  setupOnly?: boolean;
};

/**
 * Home's working half: what Antseed has done for the user (usage), what is
 * left to set up, and one banner that changes with the days.
 */
export function HomeDashboard({ onSelectView, setupOnly = false }: Props) {
  const progress = useHomeProgress();
  const gateway = useCachedResource(gatewayResource);
  const apps = useCachedResource(appsResource);
  const { balance } = useUiSelector((state) => ({ balance: selectHeadlineBalanceUsdc(state) }), shallowEqual);
  const privateMode = usePrivateMode();
  const [skills, setSkills] = useState<AgentSkillTarget[]>([]);
  const [endpoint, setEndpoint] = useState<GatewayEndpointInfo | null>(null);
  const [savings, setSavings] = useState<GatewaySavings | null>(null);
  const [rewards, setRewards] = useState<GatewayRewardsSummary | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const appKey = endpoint?.ok ? endpoint.apiKey ?? '' : '';
  const { copied, copy } = useCopyFeedback(appKey, homeProgress.markKey);

  useEffect(() => {
    let cancelled = false;
    const bridge = window.antseedDesktop;
    bridge?.agentSkillsList?.().then((list) => { if (!cancelled) setSkills(list); }).catch(() => {});
    bridge?.gatewayGetEndpoint?.().then((info) => { if (!cancelled) setEndpoint(info); }).catch(() => {});
    bridge?.gatewayGetSavings?.().then((result) => { if (!cancelled) setSavings(result); }).catch(() => {});
    bridge?.gatewayGetRewards?.().then((result) => { if (!cancelled && result.ok && result.data) setRewards(result.data); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const openConsole = useCallback((path: string) => {
    void window.antseedDesktop?.gatewayOpenConsole?.(path).then((result) => {
      if (result && !result.ok) setError(result.error ?? 'Could not open your dashboard');
    });
  }, []);

  const status = gateway.data?.status;
  const remote = status?.mode === 'remote';
  const keyInfo = gateway.data?.keyInfo ?? null;
  const balanceUsd = Number(balance);
  // A remote gateway pays from its own wallet, so this device's balance says nothing about it.
  const funded = remote || (Number.isFinite(balanceUsd) && balanceUsd > 0);
  const connectedApp = (apps.data ?? []).find((app) => app.connected) ?? null;
  const skillAgent = skills.find((skill) => skill.installed) ?? null;
  const agent = progress.agent ?? skillAgent?.label ?? null;
  const steps = [progress.firstPromptAt !== null, agent !== null || connectedApp !== null, funded, progress.key];
  const doneCount = steps.filter(Boolean).length;
  const allDone = doneCount === steps.length;
  const nextStep = steps.findIndex((done) => !done);

  useEffect(() => {
    if (allDone) homeProgress.markSetupDone();
  }, [allDone]);

  const setupState = setupOnly || !progress.setupHidden
    ? progress.setupClosed ? 'closed' : progress.setupMinimized ? 'minimized' : 'open'
    : 'gone';
  const shownSavings = savings && savings.savedUsd > 0 ? savings : null;
  const freeSavings = shownSavings && shownSavings.paidUsd <= 0 ? shownSavings : null;
  const pendingAnts = rewards?.available ? rewards.pendingAnts : null;
  const day = daysSince(progress.firstPromptAt);
  const promo = setupOnly || remote || !Number.isFinite(balanceUsd)
    ? null
    : pickHomePromo({
      day,
      funded,
      lowBalance: funded && balanceUsd < LOW_BALANCE_USD,
      privateMode,
      rewardsLive: rewards?.available === true,
      dismissed: progress.promosDismissed,
    });
  const progressWidth = `${(doneCount / steps.length) * 100}%`;
  const agentIcons = [...skills].sort((a, b) => Number(b.detected) - Number(a.detected)).slice(0, AGENT_ICON_LIMIT);

  async function addSkills(target: AgentSkillTarget): Promise<void> {
    if (installing) return;
    setInstalling(target.id);
    setError(null);
    try {
      const result = await window.antseedDesktop?.agentSkillsInstall?.(target.id);
      if (result?.targets) setSkills(result.targets);
      if (result?.ok) homeProgress.markAgent(target.label);
      else setError(result?.error ?? `Could not add Antseed to ${target.label}`);
    } finally {
      setInstalling(null);
    }
  }

  async function copyPrompt(): Promise<void> {
    setError(null);
    const result = await window.antseedDesktop?.agentSkillsCopyPrompt?.();
    if (result?.ok) homeProgress.markAgent('prompt');
    else setError(result?.error ?? 'Could not copy the setup prompt');
  }

  const closeSetupButton = (
    <button
      type="button"
      className={styles.iconButton}
      onClick={homeProgress.closeSetup}
      aria-label="Close setup"
      title="Close. You can bring it back from Home."
    >
      <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={2} />
    </button>
  );

  return (
    <div className={`${styles.page}${setupOnly ? ` ${styles.pageInline}` : ''}`}>
      {setupOnly ? null : (
        <>
          <header className={styles.header}>
            <span className={`${styles.status}${status && !status.reachable && !status.starting ? ` ${styles.statusWarn}` : ''}`}>
              <span className={styles.statusDot} />
              {status ? `${remote ? 'Remote gateway' : 'Local gateway'} · ${status.reachable ? 'ready' : status.starting ? 'starting' : 'unreachable'}` : 'Gateway starting'}
            </span>
            <h1 className={styles.heading}>Welcome back</h1>
            <p className={styles.subline}>
              {remote
                ? 'Your chat, your agents and your apps all go through your Antseed gateway.'
                : 'Antseed runs on this computer. Your chat, your agents and your apps all go through it.'}
            </p>
          </header>

          <section className={styles.card} aria-label="Your usage">
            <div className={styles.cardHead}>
              <h2 className={styles.cardTitle}>Your usage</h2>
              <button type="button" className={styles.link} onClick={() => openConsole('/activity')}>
                Every request
                <HugeiconsIcon icon={LinkSquare02Icon} size={13} strokeWidth={2} />
              </button>
            </div>
            {shownSavings ? (
              <div className={styles.saved}>
                <span className={styles.savedValue}>{savedUsd(shownSavings.savedUsd)} saved</span>
                <p className={styles.savedText}>
                  {shownSavings.paidUsd > 0
                    ? `The same requests at retail prices would have cost ${usd(shownSavings.retailUsd)}. You paid ${usd(shownSavings.paidUsd)}.`
                    : `Free models covered it. The same requests at retail prices would have cost ${usd(shownSavings.retailUsd)}.`}
                </p>
              </div>
            ) : null}
            <div className={styles.tiles}>
              <Tile label="Requests" value={keyInfo ? keyInfo.requests.toLocaleString() : '—'} />
              <Tile label="Spent, all time" value={keyInfo ? usd(keyInfo.spentUsd ?? 0) : '—'} />
              {remote ? null : (
                <Tile label="Balance" value={usd(balance)} action={{ label: 'Add funds', onClick: () => onSelectView?.('deposit') }} />
              )}
              <Tile
                label="Rewards"
                value={pendingAnts !== null ? formatCredits(pendingAnts) : '—'}
                unit={pendingAnts !== null ? ' ANTS' : undefined}
                action={{ label: rewards && !rewards.available ? 'Not live yet' : 'See rewards', onClick: () => onSelectView?.('rewards') }}
              />
            </div>
          </section>
        </>
      )}

      {setupState === 'minimized' ? (
        <section className={`${styles.card} ${styles.setupMini}`} aria-label="Get set up">
          <button type="button" className={styles.setupMiniOpen} onClick={homeProgress.openSetup} aria-expanded={false}>
            <span className={styles.cardTitle}>Get set up</span>
            <span className={styles.miniBar} aria-hidden="true"><span style={{ width: progressWidth }} /></span>
            <span className={styles.count}>{doneCount} of {steps.length} done</span>
            {nextStep >= 0 ? <span className={styles.miniNext}>Next: {NEXT_STEP_LABELS[nextStep]}</span> : null}
            <HugeiconsIcon icon={ArrowDown01Icon} size={15} strokeWidth={2} className={styles.miniChevron} />
          </button>
          {closeSetupButton}
        </section>
      ) : null}

      {setupState === 'open' ? (
        <section className={styles.card} aria-label="Get set up">
          <div className={styles.cardHead}>
            <h2 className={styles.cardTitle}>Get set up</h2>
            <div className={styles.cardTools}>
              <span className={styles.count}>{doneCount} of {steps.length} done</span>
              <button
                type="button"
                className={styles.iconButton}
                onClick={homeProgress.minimizeSetup}
                aria-label="Minimize setup"
                aria-expanded
                title="Minimize"
              >
                <HugeiconsIcon icon={MinusSignIcon} size={14} strokeWidth={2} />
              </button>
              {closeSetupButton}
            </div>
          </div>
          <div className={styles.progress} aria-hidden="true"><span style={{ width: progressWidth }} /></div>
          <ol className={styles.steps}>
            <SetupStep
              n={1}
              done={steps[0]}
              title="Send your first prompt"
              caption="Ask anything in the box above. You start on a free model, no deposit needed."
              doneLine="Done. Your chats are under Recent in the sidebar whenever you want them."
            />
            <SetupStep
              n={2}
              done={steps[1]}
              title="Use Antseed in your agent or app"
              caption="Your agent keeps its own model and calls Antseed for images, video or a second opinion. Your coding apps can run on Antseed models too."
              doneLine={agent === 'prompt'
                ? 'Setup prompt copied. Paste it into your agent.'
                : agent
                  ? `Added to ${agent}. Ask it “using Antseed, make an image of…”`
                  : `${connectedApp?.displayName ?? 'Your app'} is connected.`}
            >
              <div className={styles.agentIcons}>
                {agentIcons.map((target) => (
                  <button
                    key={target.id}
                    type="button"
                    className={`${styles.agent}${target.detected ? '' : ` ${styles.agentMuted}`}`}
                    disabled={installing !== null}
                    onClick={() => { void addSkills(target); }}
                    title={`Add Antseed to ${target.label}${target.detected ? '' : ' (not found on this computer)'}`}
                    aria-label={`Add Antseed to ${target.label}`}
                  >
                    <AppPillIcon name={target.id} displayName={target.label} />
                  </button>
                ))}
              </div>
              <button type="button" className={styles.link} onClick={() => { void copyPrompt(); }}>
                <HugeiconsIcon icon={Copy01Icon} size={13} strokeWidth={2} />
                Copy prompt
              </button>
              <button type="button" className={styles.link} onClick={() => onSelectView?.('tools')}>
                Connect an app
                <HugeiconsIcon icon={ArrowRight01Icon} size={13} strokeWidth={2} />
              </button>
              <button type="button" className={styles.link} onClick={() => onSelectView?.('tools')}>
                On your phone? Use Telegram
                <HugeiconsIcon icon={ArrowRight01Icon} size={13} strokeWidth={2} />
              </button>
            </SetupStep>
            <SetupStep
              n={3}
              done={steps[2]}
              title="Make your first deposit"
              caption={freeSavings
                ? `Free models have saved you ${savedUsd(freeSavings.savedUsd)} so far. Add funds to use paid models in chat, your agents and your apps, and earn ANTS on what you spend.`
                : 'Free models get you started. Add funds to use paid models in chat, your agents and your apps, and earn ANTS on what you spend.'}
              doneLine={remote
                ? 'Your gateway pays from its own balance.'
                : `Your balance is ${usd(balance)}. Chat, agents and apps all draw from it, and what you spend earns ANTS.`}
            >
              <button type="button" className={styles.action} onClick={() => onSelectView?.('deposit')}>Add funds</button>
            </SetupStep>
            <SetupStep
              n={4}
              done={steps[3]}
              title="Running more than one agent?"
              caption="Generate an API key for each one in your dashboard, with its own budget. They all share your balance."
              doneLine={(
                <>
                  Your keys, budgets and routing are in your{' '}
                  <button type="button" className={styles.inlineLink} onClick={() => openConsole('/keys')}>dashboard</button>.
                </>
              )}
            >
              <button
                type="button"
                className={styles.action}
                onClick={() => { homeProgress.markKey(); openConsole('/keys?new=1'); }}
              >
                Generate API keys
                <HugeiconsIcon icon={LinkSquare02Icon} size={13} strokeWidth={2} />
              </button>
              <button
                type="button"
                className={styles.link}
                disabled={!appKey}
                onClick={() => { void copy(); }}
                title={appKey ? 'Copy the key this app uses' : endpoint && !endpoint.ok ? endpoint.error : 'Your gateway is starting'}
              >
                <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={13} strokeWidth={2} />
                {copied ? 'Copied' : 'Or copy this app’s key'}
              </button>
            </SetupStep>
          </ol>
          {error ? <p className={styles.note} role="alert">{error}</p> : null}
        </section>
      ) : null}

      {promo ? (
        <section className={`${styles.card} ${styles.promo}`} aria-label={promo.title}>
          <div className={styles.promoBody}>
            <span className={styles.promoEyebrow}>{promo.eyebrow}</span>
            <h2 className={styles.promoTitle}>{promo.title}</h2>
            <p className={styles.promoText}>{promo.text}</p>
          </div>
          <button type="button" className={styles.action} onClick={() => onSelectView?.(promo.target)}>{promo.cta}</button>
          <button
            type="button"
            className={`${styles.iconButton} ${styles.promoClose}`}
            onClick={() => homeProgress.dismissPromo(promoDismissKey(promo, day))}
            aria-label="Close"
            title="Close"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={2} />
          </button>
        </section>
      ) : null}

      {setupState === 'closed' ? (
        <button type="button" className={`${styles.link} ${styles.setupReopen}`} onClick={homeProgress.openSetup}>
          Show setup steps, {doneCount} of {steps.length} done
          <HugeiconsIcon icon={ArrowDown01Icon} size={13} strokeWidth={2} />
        </button>
      ) : null}
    </div>
  );
}

function Tile({ label, value, unit, action }: {
  label: string;
  value: string;
  unit?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileValue}>
        {value}
        {unit ? <span className={styles.tileUnit}>{unit}</span> : null}
      </span>
      {action ? <button type="button" className={styles.tileLink} onClick={action.onClick}>{action.label}</button> : null}
    </div>
  );
}

function SetupStep({ n, done, title, caption, doneLine, children }: {
  n: number;
  done: boolean;
  title: string;
  caption: string;
  doneLine: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className={`${styles.step}${done ? ` ${styles.stepDone}` : ''}`}>
      <span className={styles.stepMark} aria-label={done ? 'Done' : `Step ${n}`}>
        {done ? <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2.4} /> : n}
      </span>
      <div className={styles.stepBody}>
        <p className={styles.stepTitle}>{title}</p>
        {done ? (
          <p className={styles.stepText} role="status">{doneLine}</p>
        ) : (
          <>
            <p className={styles.stepText}>{caption}</p>
            {children ? <div className={styles.stepActions}>{children}</div> : null}
          </>
        )}
      </div>
    </li>
  );
}
