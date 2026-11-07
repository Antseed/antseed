import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  Copy01Icon,
  GithubIcon,
  NewTwitterIcon,
  TelegramIcon,
} from '@hugeicons/core-free-icons';
import { getUiStateRef } from '../../../core/store';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { VprCard, VprPage, VprSettingRow, VprToggle } from '../vpr/VprKit';
import styles from './VprHelpView.module.scss';

declare const __APP_VERSION__: string;

type Props = { onSelectView?: (view: import('../../types').ViewName) => void };

const TELEGRAM_URL = 'https://t.me/antseed';
const X_URL = 'https://x.com/antseed';
const DOCS_BASE_URL = 'https://antseed.com/docs';
const GATEWAY_DOCS_URL = `${DOCS_BASE_URL}/gateway`;
const DESKTOP_DOCS_URL = `${DOCS_BASE_URL}/desktop`;
const GITHUB_ISSUES_URL = 'https://github.com/AntSeed/antseed/issues/new';

type HelpLink = { label: string; url: string };
type HelpSection = { heading: string; body: string; link?: HelpLink };
type HelpArticle = {
  key: string;
  label: string;
  intro: string;
  sections: HelpSection[];
  links?: HelpLink[];
};
type HelpTopic = { key: string; label: string; articles: HelpArticle[] };

const HELP_TOPICS: HelpTopic[] = [
  {
    key: 'getting-started',
    label: 'Getting started',
    articles: [
      {
        key: 'what-is',
        label: 'What this app does',
        intro: 'Antseed runs an AI gateway for you and connects your tools to it. Requests are served by the Antseed peer-to-peer network and paid from your balance.',
        sections: [
          {
            heading: 'Your gateway',
            body: 'The app runs a gateway on this computer (or uses one someone runs for you). It has an OpenAI- and Anthropic-compatible API and an API key, like any AI provider.',
          },
          {
            heading: 'Connected apps',
            body: 'Connect coding agents and AI clients from Agents & apps. Each app is pointed at your gateway with its key and lists the gateway’s models in its own model picker.',
          },
          {
            heading: 'Usage, keys and limits',
            body: 'Spend, request history, API keys and limits live in your gateway’s console. Use API keys at the top of the window to open it.',
          },
        ],
        links: [
          { label: 'Gateway and console', url: GATEWAY_DOCS_URL },
          { label: 'Desktop app guide', url: DESKTOP_DOCS_URL },
        ],
      },
      {
        key: 'console',
        label: 'Sign in to your gateway',
        intro: 'The first time you open your gateway’s console, you claim it: add a passkey or connect a wallet once, and sign in with it from then on.',
        sections: [
          {
            heading: 'First sign-in',
            body: 'Manage API keys opens a one-time setup link while the console has no owner. Finish the setup in your browser; the app does not keep a password.',
          },
          {
            heading: 'After that',
            body: 'The same buttons open the console, where you sign in with the passkey or wallet you added.',
          },
        ],
        links: [{ label: 'Console sign-in', url: `${GATEWAY_DOCS_URL}/sign-in` }],
      },
    ],
  },
  {
    key: 'apps',
    label: 'Connected apps',
    articles: [
      {
        key: 'connect',
        label: 'Connect an app',
        intro: 'Open Agents & apps and click Connect. The app’s own config file gets your gateway’s address and API key; Disconnect restores the original (a backup is kept next to it).',
        sections: [
          {
            heading: 'Choose models in the app',
            body: 'Connected apps list your gateway’s models. Pick and switch models inside each app, the way you normally would.',
          },
          {
            heading: 'Restart after connecting',
            body: 'A running app keeps the settings it read at launch. Restart it, or start a new session, so it uses the gateway.',
          },
          {
            heading: 'Zed',
            body: 'Zed keeps API keys in its own keychain. After connecting, open Agents & apps → Zed’s settings, copy the API key, paste it into the Antseed provider in Zed, then choose I’ve pasted it.',
          },
        ],
      },
      {
        key: 'other-tools',
        label: 'Use any other tool',
        intro: 'Any tool that accepts an OpenAI- or Anthropic-compatible base URL and API key works with your gateway.',
        sections: [
          {
            heading: 'URL and key',
            body: 'Agents & apps → Use with any other tool shows the base URL and key to paste into the tool’s settings. Send the key as a Bearer token (Authorization header).',
          },
          {
            heading: 'Cursor',
            body: 'Cursor calls models from its own servers, so it cannot reach a gateway on this computer. It works with a gateway that has a public URL: set one in Settings → Gateway.',
          },
        ],
        links: [{ label: 'Gateway API', url: `${GATEWAY_DOCS_URL}/api` }],
      },
    ],
  },
  {
    key: 'gateway',
    label: 'Gateway and keys',
    articles: [
      {
        key: 'local-remote',
        label: 'Local or remote gateway',
        intro: 'By default the gateway runs on this computer and starts with the app. Settings → Gateway can point the app at a gateway someone else runs instead.',
        sections: [
          {
            heading: 'This computer',
            body: 'The local gateway pays from this app’s balance and stops when you quit. Connected apps are disconnected while it is stopped and reconnected at launch.',
          },
          {
            heading: 'Remote',
            body: 'Enter the gateway’s URL and an API key it issued. Chat and connected apps use it directly, and keep working while this app is closed. Funding and keys are managed in that gateway’s console.',
          },
        ],
      },
      {
        key: 'keys',
        label: 'API keys',
        intro: 'The app creates an API key on your local gateway and gives it to the chat and your connected apps.',
        sections: [
          {
            heading: 'One key or a key per app',
            body: 'By default every app shares one key. Turn on A key per app in Settings to give each connected app its own key, so the console shows usage and limits per app.',
          },
          {
            heading: 'Replace keys',
            body: 'Replace keys revokes the current keys, creates new ones and updates every connected app. Running apps restart to pick up the new key.',
          },
        ],
        links: [{ label: 'Budgets and limits', url: `${GATEWAY_DOCS_URL}/budgets` }],
      },
    ],
  },
  {
    key: 'payments',
    label: 'Funding',
    articles: [
      {
        key: 'funds',
        label: 'Add funds',
        intro: 'Add funds by card or USDC on Base. Sellers are paid from this balance as you use them.',
        sections: [
          {
            heading: 'In the app',
            body: 'Home → Add funds opens the card checkout or a USDC deposit address. Deposits land in your balance automatically.',
          },
          {
            heading: 'In your gateway',
            body: 'Balance, spend and limits are shown in your gateway’s console, which can also add funds.',
          },
        ],
        links: [{ label: 'Funding', url: `${GATEWAY_DOCS_URL}/funding` }],
      },
      {
        key: 'signer',
        label: 'Your signer key',
        intro: 'The signer key authorizes payments to sellers for requests from this computer. Back it up from Settings → Wallet, or import one you already use.',
        sections: [
          {
            heading: 'Keep a backup',
            body: 'Anyone with the signer key can spend its balance. Store the backup somewhere safe and never share it.',
          },
        ],
      },
    ],
  },
  {
    key: 'troubleshooting',
    label: 'Troubleshooting',
    articles: [
      {
        key: 'no-response',
        label: 'An app gets no response',
        intro: 'Check Home: it says whether your gateway is running and reachable.',
        sections: [
          {
            heading: 'Gateway not running',
            body: 'The local gateway starts with the app and can take a minute while it finds peers. If it stays stopped, open Developer mode → Live logs from this page.',
          },
          {
            heading: 'App still uses its old settings',
            body: 'Restart the app or start a new session. Agents & apps shows Restart required next to apps that started before they were connected.',
          },
          {
            heading: 'Out of funds',
            body: 'Paid requests fail when the balance runs out. Add funds from Home, or check the key’s limits in your gateway.',
          },
        ],
        links: [{ label: 'Gateway troubleshooting', url: `${GATEWAY_DOCS_URL}/troubleshooting` }],
      },
      {
        key: 'report',
        label: 'Report a problem',
        intro: 'Bugs and questions are welcome on GitHub and in the community chat.',
        sections: [
          {
            heading: 'What to include',
            body: 'Include the app version, operating system, affected app, expected result, actual result, and redacted diagnostics.',
          },
        ],
      },
    ],
  },
];

/** Global reading order for the "Read next" link at the bottom of articles. */
const ARTICLE_ORDER: Array<{ topicKey: string; article: HelpArticle }> = HELP_TOPICS.flatMap(
  (topic) => topic.articles.map((article) => ({ topicKey: topic.key, article })),
);

function nextArticle(topicKey: string, articleKey: string): { topicKey: string; article: HelpArticle } | null {
  const index = ARTICLE_ORDER.findIndex(
    (entry) => entry.topicKey === topicKey && entry.article.key === articleKey,
  );
  return index >= 0 ? ARTICLE_ORDER[index + 1] ?? null : null;
}

/** Diagnostic screens surfaced from Help — the only entry point for them. */
const DIAGNOSTIC_ROUTES: Array<{ view: import('../../types').ViewName; label: string }> = [
  { view: 'connection', label: 'Connection details' },
  { view: 'config', label: 'Configuration' },
];

function openExternal(url: string): void {
  void window.antseedDesktop?.openExternalUrl?.(url);
}

// Must match the pane animation duration in VprHelpView.module.scss.
const PAGE_SLIDE_MS = 300;

type HelpPage = { topicKey: string | null; articleKey: string | null };

function pageDepth(page: HelpPage): number {
  return page.articleKey ? 2 : page.topicKey ? 1 : 0;
}

function pageKey(page: HelpPage): string {
  return `${page.topicKey ?? ''}/${page.articleKey ?? ''}`;
}

// Renderer-lifetime scroll positions per help page. Written once per
// navigation (and on view unmount) — no scroll listeners, no state updates —
// so drilling into a topic or a diagnostic screen and coming back lands at
// the same spot.
const helpScrollByPage = new Map<string, number>();

export function VprHelpView({ onSelectView }: Props) {
  const snap = useUiSelector((state) => ({
    connectBadgeLabel: state.connectBadge.label,
    networkHealth: state.ovDhtHealth,
    peers: state.ovPeers,
    serviceCount: state.ovServiceCount,
    devMode: state.devMode,
    configFormData: state.configFormData,
    configSaving: state.configSaving,
  }), shallowEqual);
  const actions = useActions();

  // Internal page slide (same ExpressVPN-style transition as the top-level
  // ViewHost): the outgoing page stays mounted for one animation beat.
  const [nav, setNav] = useState<{ page: HelpPage; previous: HelpPage | null; direction: 'forward' | 'back' }>({
    page: { topicKey: null, articleKey: null },
    previous: null,
    direction: 'forward',
  });

  const activePaneRef = useRef<HTMLDivElement | null>(null);
  const currentPageRef = useRef(nav.page);
  currentPageRef.current = nav.page;

  // The pane itself is a pinned-header flex column; the scrolling element is
  // the VprPage body inside it.
  function paneScroller(): HTMLElement | null {
    return activePaneRef.current?.querySelector<HTMLElement>('[data-view-scroll]') ?? null;
  }

  function goTo(page: HelpPage, direction?: 'forward' | 'back'): void {
    const el = paneScroller();
    if (el) helpScrollByPage.set(pageKey(currentPageRef.current), el.scrollTop);
    setNav((current) => ({
      page,
      previous: current.page,
      direction: direction ?? (pageDepth(page) >= pageDepth(current.page) ? 'forward' : 'back'),
    }));
  }

  // Restore the incoming page's scroll before paint; save on unmount (e.g.
  // when a diagnostic row navigates to another view).
  useLayoutEffect(() => {
    const el = paneScroller();
    if (el) el.scrollTop = helpScrollByPage.get(pageKey(nav.page)) ?? 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageKey(nav.page)]);
  useEffect(() => () => {
    const el = paneScroller();
    if (el) helpScrollByPage.set(pageKey(currentPageRef.current), el.scrollTop);
  }, []);

  useEffect(() => {
    if (!nav.previous) return undefined;
    const timer = window.setTimeout(() => {
      setNav((current) => (current.previous ? { ...current, previous: null } : current));
    }, PAGE_SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [nav]);

  const [copied, setCopied] = useState(false);
  const [appVersion, setAppVersion] = useState<string>(
    typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '',
  );
  useEffect(() => {
    window.antseedDesktop?.getAppVersion?.().then(setAppVersion).catch(() => {});
  }, []);

  // Developer mode is the single switch for diagnostics: it enables debug
  // logging (settings module) and reveals the diagnostic screens below.
  function toggleDevMode(next: boolean): void {
    if (!snap.configFormData) return;
    void actions.saveConfig({ ...snap.configFormData, devMode: next });
  }

  async function copyDiagnostics(): Promise<void> {
    const state = getUiStateRef();
    const recentLogs = state.logs.slice(-50)
      .map((event) => `[${event.mode}] ${event.line}`)
      .join('\n');
    const report = [
      `Antseed desktop v${appVersion}`,
      `Status: ${snap.networkHealth} | Gateway ${snap.connectBadgeLabel}`,
      `Network: ${snap.peers} peers, ${snap.serviceCount} services`,
      '',
      '--- Recent logs ---',
      recentLogs,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch { /* clipboard unavailable */ }
  }

  function renderArticlePage(topic: HelpTopic, article: HelpArticle) {
    const next = nextArticle(topic.key, article.key);
    return (
      <VprPage title={article.label} large onBack={() => goTo({ topicKey: topic.key, articleKey: null })}>
      <div className={`${styles.stack} ${styles.reading}`}>
        <VprCard className={styles.articleCard}>
          <p className={styles.paragraph}>{article.intro}</p>
          {article.sections.map((section) => (
            <div key={section.heading} className={styles.articleSection}>
              <h3 className={styles.articleHeading}>{section.heading}</h3>
              <p className={styles.paragraph}>{section.body}</p>
              {section.link && (
                <button
                  type="button"
                  className={styles.docsLink}
                  onClick={() => openExternal(section.link!.url)}
                >
                  <span>{section.link.label}</span>
                  <HugeiconsIcon icon={ArrowUpRight01Icon} size={14} strokeWidth={2} />
                </button>
              )}
            </div>
          ))}
          {article.links && article.links.length > 0 && (
            <div className={styles.resourceLinks}>
              <span className={styles.resourceLabel}>Related resources</span>
              {article.links.map((link) => (
                <button
                  key={link.url}
                  type="button"
                  className={styles.docsLink}
                  onClick={() => openExternal(link.url)}
                >
                  <span>{link.label}</span>
                  <HugeiconsIcon icon={ArrowUpRight01Icon} size={14} strokeWidth={2} />
                </button>
              ))}
            </div>
          )}
        </VprCard>
        {next && (
          <button
            type="button"
            className={styles.nextRow}
            onClick={() => goTo({ topicKey: next.topicKey, articleKey: next.article.key }, 'forward')}
          >
            <span className={styles.nextKicker}>Read next</span>
            <span className={styles.nextLabel}>
              <span className={styles.nextLabelText}>{next.article.label}</span>
              <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2} className={styles.rowGlyph} />
            </span>
          </button>
        )}
      </div>
      </VprPage>
    );
  }

  function renderTopicPage(topic: HelpTopic) {
    return (
      <VprPage title={topic.label} large onBack={() => goTo({ topicKey: null, articleKey: null })}>
      <div className={`${styles.stack} ${styles.reading}`}>
        <VprCard>
          {topic.articles.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className={styles.row}
              onClick={() => goTo({ topicKey: topic.key, articleKey: entry.key })}
            >
              <span className={styles.rowLabel}>{entry.label}</span>
              <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2} className={styles.rowGlyph} />
            </button>
          ))}
        </VprCard>
      </div>
      </VprPage>
    );
  }

  function renderRootPage() {
    return (
      <VprPage title="Help & Support" backFallback="preferences" subtitle="Ask the community, report a bug, or read the guides.">
      <div className={`${styles.stack} ${styles.columns}`}>

        <div className={styles.section}>
          <p className={styles.sectionLabel}>Community</p>
          <p className={styles.sectionHint}>
            Get help from the team and the community, and follow what we ship.
          </p>
          <VprCard>
            <button type="button" className={styles.row} onClick={() => openExternal(TELEGRAM_URL)}>
              <HugeiconsIcon icon={TelegramIcon} size={18} strokeWidth={1.8} className={styles.rowIcon} />
              <span className={styles.rowLabel}>Join our Telegram</span>
              <HugeiconsIcon icon={ArrowUpRight01Icon} size={16} strokeWidth={2} className={styles.rowGlyph} />
            </button>
            <button type="button" className={styles.row} onClick={() => openExternal(X_URL)}>
              <HugeiconsIcon icon={NewTwitterIcon} size={18} strokeWidth={1.8} className={styles.rowIcon} />
              <span className={styles.rowLabel}>Follow us on X</span>
              <HugeiconsIcon icon={ArrowUpRight01Icon} size={16} strokeWidth={2} className={styles.rowGlyph} />
            </button>
            <button type="button" className={styles.row} onClick={() => openExternal(GITHUB_ISSUES_URL)}>
              <HugeiconsIcon icon={GithubIcon} size={18} strokeWidth={1.8} className={styles.rowIcon} />
              <span className={styles.rowText}>
                <span className={styles.rowLabel}>Report a bug on GitHub</span>
                <span className={styles.rowHint}>Include redacted diagnostics when possible</span>
              </span>
              <HugeiconsIcon icon={ArrowUpRight01Icon} size={16} strokeWidth={2} className={styles.rowGlyph} />
            </button>
          </VprCard>
        </div>

        <div className={styles.section}>
          <p className={styles.sectionLabel}>Guides</p>
          <VprCard>
            {HELP_TOPICS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className={styles.row}
                onClick={() => goTo({ topicKey: entry.key, articleKey: null })}
              >
                <span className={styles.rowLabel}>{entry.label}</span>
                <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2} className={styles.rowGlyph} />
              </button>
            ))}
            <button type="button" className={styles.row} onClick={() => openExternal(DESKTOP_DOCS_URL)}>
              <span className={styles.rowText}>
                <span className={styles.rowLabel}>Desktop app guide</span>
                <span className={styles.rowHint}>Setup, connected apps, funding and troubleshooting</span>
              </span>
              <HugeiconsIcon icon={ArrowUpRight01Icon} size={16} strokeWidth={2} className={styles.rowGlyph} />
            </button>
          </VprCard>
        </div>

        <div className={styles.section}>
          <p className={styles.sectionLabel}>Diagnostic tools</p>
          <VprCard className={styles.settingCard}>
            <VprSettingRow
              title="Developer mode"
              hint="Enables debug logging and the diagnostic screens below"
              control={(
                <VprToggle
                  checked={snap.devMode}
                  onChange={toggleDevMode}
                  ariaLabel="Developer mode"
                  disabled={!snap.configFormData || snap.configSaving}
                />
              )}
            />
            {snap.devMode && (
              <>
                <button
                  type="button"
                  className={`${styles.row} ${styles.rowFlush}`}
                  onClick={() => onSelectView?.('desktop')}
                >
                  <span className={styles.rowText}>
                    <span className={styles.rowLabel}>Live logs</span>
                    <span className={styles.rowHint}>Runtime activity as it happens</span>
                  </span>
                  <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2} className={styles.rowGlyph} />
                </button>
                {DIAGNOSTIC_ROUTES.map((route) => (
                  <button
                    key={route.view}
                    type="button"
                    className={`${styles.row} ${styles.rowFlush}`}
                    onClick={() => onSelectView?.(route.view)}
                  >
                    <span className={styles.rowLabel}>{route.label}</span>
                    <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2} className={styles.rowGlyph} />
                  </button>
                ))}
                <button type="button" className={`${styles.row} ${styles.rowFlush}`} onClick={() => { void copyDiagnostics(); }}>
                  <HugeiconsIcon icon={Copy01Icon} size={18} strokeWidth={1.8} className={styles.rowIcon} />
                  <span className={styles.rowText}>
                    <span className={styles.rowLabel}>{copied ? 'Copied to clipboard' : 'Copy diagnostic report'}</span>
                    <span className={styles.rowHint}>Version, runtime status and recent logs</span>
                  </span>
                  <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2} className={styles.rowGlyph} />
                </button>
              </>
            )}
          </VprCard>
        </div>

        <div className={styles.section}>
          <p className={styles.sectionLabel}>Legal</p>
          <VprCard>
            <button type="button" className={styles.row} onClick={() => openExternal('https://antseed.com/terms-of-service#62-sharing-data-with-ai-services')}>
              <span className={styles.rowLabel}>Privacy Policy</span>
              <HugeiconsIcon icon={ArrowUpRight01Icon} size={16} strokeWidth={2} className={styles.rowGlyph} />
            </button>
            <button type="button" className={styles.row} onClick={() => openExternal('https://antseed.com/terms-of-service')}>
              <span className={styles.rowLabel}>Terms of Service</span>
              <HugeiconsIcon icon={ArrowUpRight01Icon} size={16} strokeWidth={2} className={styles.rowGlyph} />
            </button>
          </VprCard>
        </div>

        <div className={styles.section}>
          <p className={styles.sectionLabel}>App details</p>
          <VprCard>
            <button type="button" className={styles.row} onClick={() => openExternal('https://github.com/AntSeed/antseed/blob/main/CHANGELOG.md')}>
              <span className={styles.rowLabel}>Changelog</span>
              <HugeiconsIcon icon={ArrowUpRight01Icon} size={16} strokeWidth={2} className={styles.rowGlyph} />
            </button>
            <div className={styles.row}>
              <span className={styles.rowLabel}>App version</span>
              <span className={styles.rowValue}>v{appVersion}</span>
            </div>
          </VprCard>
        </div>
      </div>
      </VprPage>
    );
  }

  function renderPage(page: HelpPage) {
    const topic = page.topicKey ? HELP_TOPICS.find((entry) => entry.key === page.topicKey) ?? null : null;
    if (topic && page.articleKey) {
      const article = topic.articles.find((entry) => entry.key === page.articleKey);
      if (article) return renderArticlePage(topic, article);
    }
    if (topic) return renderTopicPage(topic);
    return renderRootPage();
  }

  const sliding = nav.previous !== null;

  return (
    <section
      className={`${styles.host}${sliding ? ` ${styles.hostSliding} ${nav.direction === 'forward' ? styles.hostForward : styles.hostBack}` : ''}`}
      role="tabpanel"
    >
      {nav.previous && (
        <div
          key={`out-${pageKey(nav.previous)}`}
          className={`view view-vpr-help view-pinned-header ${styles.view} ${styles.pane} ${styles.paneOut}`}
          aria-hidden="true"
        >
          {renderPage(nav.previous)}
        </div>
      )}
      <div
        key={pageKey(nav.page)}
        ref={activePaneRef}
        className={`view view-vpr-help view-pinned-header ${styles.view} ${styles.pane}${sliding ? ` ${styles.paneIn}` : ''}`}
      >
        {renderPage(nav.page)}
      </div>
    </section>
  );
}
