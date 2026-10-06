import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowUp02Icon,
  BubbleChatIcon,
  ConnectIcon,
  DiscoverCircleIcon,
  PowerIcon,
  PreferenceHorizontalIcon,
  SquarePowerIcon,
} from '@hugeicons/core-free-icons';
import { BrandIcon, type BrandKey } from './brand/BrandIcon';
import styles from './SetupAppPreview.module.scss';

/* Everything in the walkthrough is hard-coded: it plays during first-run
   setup, before discovery has produced anything, so live data would leave a
   new user staring at empty scenes. The names shown are model families and
   apps actually on the network. */

/** The walkthrough's Apps scene: the headline integrations. */
const PREVIEW_APPS: Array<{ brand: BrandKey; label: string }> = [
  { brand: 'anthropic', label: 'Claude' },
  { brand: 'openai', label: 'ChatGPT' },
  { brand: 'cursor', label: 'Cursor' },
  { brand: 'opencode', label: 'OpenCode' },
  { brand: 'telegram', label: 'Telegram Bot' },
];

/** The Models scene rows: a mix of free and paid. */
const PREVIEW_MODELS: Array<{ brand: BrandKey; label: string; chip: string; free: boolean }> = [
  { brand: 'deepseek', label: 'DeepSeek V4 Flash', chip: 'Free', free: true },
  { brand: 'qwen', label: 'Qwen 3.5 Coder', chip: 'Free', free: true },
  { brand: 'openai', label: 'GPT 5.6 Sol', chip: '$0.55', free: false },
  { brand: 'anthropic', label: 'Claude Opus 5', chip: '$1.20', free: false },
  { brand: 'glm', label: 'GLM 5.2', chip: '$0.30', free: false },
];

const SCENE_DURATION_SECONDS = 4;
const PREVIEW_SCENES = [
  { caption: 'Turn it on — your AI VPN joins the network', icon: SquarePowerIcon },
  { caption: 'Chat with any model, pay per use', icon: BubbleChatIcon },
  { caption: 'The latest models, free ones included', icon: DiscoverCircleIcon },
  { caption: 'Connect the apps you already use', icon: ConnectIcon },
];

function sceneDelay(index: number): string {
  return `${index * SCENE_DURATION_SECONDS}s`;
}

/**
 * Miniature AI VPN window that plays as a walkthrough-loader: the nav rail on
 * the left, the main pane cycling Home → Models → Apps → Chat at the app's
 * real portrait proportions, and a caption line underneath narrating each
 * scene. Pure CSS timing — one 16s period, 4s per scene, elements staggered
 * within their scene by animation-delay.
 */
export function SetupAppPreview() {
  return (
    <div className={styles.walkthrough} aria-hidden="true">
      {/* Caption line above the frame, one entry per scene, on the same clock. */}
      <div className={styles.captions}>
        {PREVIEW_SCENES.map(({ caption }, index) => (
          <span key={caption} className={styles.caption} style={{ animationDelay: sceneDelay(index) }}>
            {caption}
          </span>
        ))}
      </div>
      <div className={styles.frame}>
        {/* The rail's active tab follows the scene on stage: AI VPN → Models →
            Apps → Chat, on the same 16s clock as the scenes. */}
        <div className={styles.rail}>
          {PREVIEW_SCENES.map(({ caption, icon }, index) => (
            <span
              key={caption}
              className={`${styles.railItem} ${styles.railItemCycle}`}
              style={{ animationDelay: sceneDelay(index) }}
            >
              <HugeiconsIcon icon={icon} size={13} strokeWidth={2} />
            </span>
          ))}
          <span className={styles.railItem}>
            <HugeiconsIcon icon={PreferenceHorizontalIcon} size={13} strokeWidth={2} />
          </span>
        </div>

        <div className={styles.pane}>
          {/* Scene 1 — Home: banner, power button, composer, app pills. */}
          <div className={`${styles.scene} ${styles.sceneHome}`}>
            <div className={styles.banner} />
            <div className={styles.power}>
              <HugeiconsIcon icon={PowerIcon} size={22} strokeWidth={2.2} />
            </div>
            <span className={styles.statusLine}>Running</span>
            <div className={styles.composer}>
              <span className={styles.composerText}>How can I help you today?</span>
              <span className={styles.composerSend}>
                <HugeiconsIcon icon={ArrowUp02Icon} size={12} strokeWidth={2.4} />
              </span>
            </div>
            {/* App pills + usage: your tools connect here, and the Saving
                tile is the point — using Antseed saves money. */}
            <div className={styles.pillRow}>
              {PREVIEW_APPS.slice(0, 4).map((app) => (
                <span key={app.brand} className={styles.pill}>
                  <BrandIcon brand={app.brand} name={app.brand} size={11} />
                </span>
              ))}
            </div>
            <div className={styles.homeUsage}>
              <span className={styles.usageTile}>
                <span className={styles.usageLabel}>Requests</span>
                <span className={styles.usageValue}>128</span>
              </span>
              <span className={styles.usageTile}>
                <span className={styles.usageLabel}>Tokens</span>
                <span className={styles.usageValue}>1.2M</span>
              </span>
              <span className={styles.usageTile}>
                <span className={styles.usageLabel}>Saving</span>
                <span className={`${styles.usageValue} ${styles.usageSaving}`}>$12.40</span>
              </span>
            </div>
          </div>

          {/* Scene 2 — Chat: the first question, answered. */}
          <div className={`${styles.scene} ${styles.sceneChat}`}>
            <span className={styles.sceneTitle}>Chat</span>
            <div className={`${styles.bubble} ${styles.bubbleUser}`}>What is Antseed?</div>
            <div className={`${styles.bubble} ${styles.bubbleTyping}`}><span /><span /><span /></div>
            <div className={`${styles.bubble} ${styles.bubbleAnswer}`}>
              A peer-to-peer network of AI models — each request routes to the best seller, and you only pay for what you use.
            </div>
          </div>

          {/* Scene 3 — Models: real discovered rows, or logo skeletons. */}
          <div className={`${styles.scene} ${styles.sceneModels}`}>
            <span className={styles.sceneTitle}>Models</span>
            {PREVIEW_MODELS.map((row, index) => (
              <div key={row.label} className={styles.modelRow} style={{ animationDelay: `${8.25 + 0.3 * index}s` }}>
                <BrandIcon brand={row.brand} name={row.brand} size={14} />
                <span className={styles.modelName}>{row.label}</span>
                <span className={`${styles.chip} ${row.free ? styles.chipFree : styles.chipPrice}`}>{row.chip}</span>
              </div>
            ))}
          </div>

          {/* Scene 4 — Apps: your tools connecting, toggles flipping on. */}
          <div className={`${styles.scene} ${styles.sceneApps}`}>
            <span className={styles.sceneTitle}>Connected apps</span>
            {PREVIEW_APPS.map((app, index) => (
              <div key={app.brand} className={styles.appRow} style={{ animationDelay: `${12.2 + 0.3 * index}s` }}>
                <BrandIcon brand={app.brand} name={app.brand} size={15} />
                <span className={styles.appName}>{app.label}</span>
                <span className={styles.toggle} style={{ animationDelay: `${12.7 + 0.3 * index}s` }}>
                  <span className={styles.toggleKnob} style={{ animationDelay: `${12.7 + 0.3 * index}s` }} />
                </span>
              </div>
            ))}
            <span className={styles.appsHint}>Requests route through your AI VPN</span>
          </div>

        </div>
      </div>

    </div>
  );
}
