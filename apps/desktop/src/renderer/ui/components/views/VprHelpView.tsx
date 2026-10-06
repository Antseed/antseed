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
import { usePublicEndpointModal } from '../tunnels/PublicEndpointModal';
import styles from './VprHelpView.module.scss';

declare const __APP_VERSION__: string;

type Props = { onSelectView?: (view: import('../../types').ViewName) => void };

const TELEGRAM_URL = 'https://t.me/antseed';
const X_URL = 'https://x.com/antseed';
const DOCS_BASE_URL = 'https://antseed.com/docs';
const VPR_GUIDE_URL = `${DOCS_BASE_URL}/guides/vpr`;
const INTEGRATIONS_URL = 'https://antseed.com/integrations';
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
        label: 'What the AI VPN does',
        intro: 'The AI VPN is like a VPN for AI: it routes AI requests from the tools you already use through the Antseed network.',
        sections: [
          {
            heading: 'Keep using your normal tools',
            body: 'Connect apps such as coding assistants and AI clients, then keep working in their familiar interfaces while the AI VPN handles routing in the background.',
          },
          {
            heading: 'Choose how requests route',
            body: 'The AI VPN discovers sellers, applies your model, price, and trust preferences, and handles pay-per-request settlement from your credits.',
          },
        ],
        links: [
          { label: 'Read the complete AI VPN guide', url: VPR_GUIDE_URL },
          { label: 'Understand the Antseed protocol', url: `${DOCS_BASE_URL}/overview` },
        ],
      },
      {
        key: 'router',
        label: 'Start the router',
        intro: 'Use the power button on Home to start or stop the local router. The status area shows network health, the proxy port, and visible peers and services.',
        sections: [
          {
            heading: 'Discovery takes a moment',
            body: 'Peer and model announcements can take a few seconds after startup. If Models stays empty, open it and use Refresh models.',
          },
          {
            heading: 'Stopping the router',
            body: 'Stopping the router prevents connected apps from sending new requests through Antseed. It does not remove their saved connection settings.',
          },
        ],
        links: [{ label: 'Start and use the AI VPN', url: `${VPR_GUIDE_URL}#start-the-router` }],
      },
      {
        key: 'chat',
        label: 'Chat inside the AI VPN',
        intro: 'Use the built-in chat when you want to talk to a network model without opening another tool. Start from the Home prompt or open Chat directly.',
        sections: [
          {
            heading: 'Change the conversation model',
            body: 'Use the model picker in the chat header. For an existing thread, choose whether to continue it on the new model or start a new chat.',
          },
          {
            heading: 'Manage chat history',
            body: 'View chats opens your conversation list. You can return to previous chats, start a clean chat with the current model, and search messages in the active conversation.',
          },
        ],
        links: [{ label: 'Use the built-in AI VPN chat', url: `${VPR_GUIDE_URL}#chat-inside-the-vpr` }],
      },
      {
        key: 'apps',
        label: 'Connect your apps',
        intro: 'Open Connected apps and select a detected tool. The AI VPN updates a supported config file or routes the app through its local proxy.',
        sections: [
          {
            heading: 'Restart when prompted',
            body: 'Config-file integrations must be restarted before they read the new endpoint. Use the Restart action shown on the app row.',
          },
          {
            heading: 'Manual integrations',
            body: 'For apps not detected automatically, use Add custom app or follow the tool-specific endpoint instructions.',
          },
        ],
        links: [
          { label: 'Connect apps with the AI VPN', url: `${VPR_GUIDE_URL}#connect-an-ai-app` },
          { label: 'Open tool-specific integration guides', url: INTEGRATIONS_URL },
        ],
      },
      {
        key: 'conversations',
        label: 'Manage connected-tool conversations',
        intro: 'Connected-tool sessions appear under Recent chats after they send traffic. Each conversation can keep its own model and seller route.',
        sections: [
          {
            heading: 'Set one chat’s model',
            body: 'Open Recent chats, select a conversation, and choose its model. Other conversations and the default model for new sessions are unchanged.',
          },
          {
            heading: 'Set one chat’s seller',
            body: 'Open the model row’s settings to use automatic selection or pin an exact seller for only that conversation.',
          },
          {
            heading: 'Other controls',
            body: 'Rename the conversation, open its connected app, or delete the stored chat entry from the conversation detail page.',
          },
        ],
        links: [
          { label: 'Manage connected-tool conversations', url: `${VPR_GUIDE_URL}#manage-connected-tool-conversations` },
        ],
      },
      {
        key: 'float',
        label: 'The floating window',
        intro: 'The floating window stays above your apps and shows the active model plus current token and cost activity.',
        sections: [
          {
            heading: 'Models and conversations',
            body: 'Change the default model for new sessions, assign a model to one recent conversation, or open the connected app that owns it.',
          },
          {
            heading: 'Floating preferences',
            body: 'Show on traffic opens it automatically when a connected app sends requests. Show routed peer displays the seller that actually served each chat.',
          },
          {
            heading: 'Closing it is safe',
            body: 'Closing the floating window does not stop the router, disconnect apps, or end conversations.',
          },
        ],
        links: [{ label: 'Use the floating window', url: `${VPR_GUIDE_URL}#use-the-floating-window` }],
      },
      {
        key: 'api',
        label: 'Use the local API',
        intro: 'While the router is running, the AI VPN exposes an OpenAI- and Anthropic-compatible API at http://localhost:8377 for tools, SDKs, scripts, and curl.',
        sections: [
          {
            heading: 'Browse available models',
            body: 'GET /v1/models returns the network-wide model catalog from the local proxy. Use /v1/models?type=images to list image services only.',
          },
          {
            heading: 'Send requests',
            body: 'Use /v1/chat/completions, /v1/responses, or /v1/messages for text requests. Image clients can use /v1/images/generations and /v1/images/edits.',
          },
          {
            heading: 'Choose the route',
            body: 'Use model "antseed" to follow the model selected in AI VPN, a catalog model id for automatic seller selection, or <peerId>@<model> to pin one seller.',
          },
        ],
        links: [
          { label: 'Use the AI VPN local API', url: `${VPR_GUIDE_URL}#use-the-local-api` },
          { label: 'Open the complete API guide', url: `${DOCS_BASE_URL}/guides/using-the-api` },
        ],
      },
    ],
  },
  {
    key: 'routing',
    label: 'Models & routing',
    articles: [
      {
        key: 'models',
        label: 'Choose a model and seller',
        intro: 'Open Models to browse currently advertised services, prices, seller availability, and expected savings where a retail comparison exists.',
        sections: [
          {
            heading: 'Automatic selection',
            body: 'Auto select ranks eligible sellers using trust, price, free-route preference, compatibility, and recent failures. Retryable failures can move an automatic route to another seller.',
          },
          {
            heading: 'Seller pins',
            body: 'A pinned seller is a hard route and does not fail over. Remove the pin before troubleshooting that seller’s availability or performance.',
          },
        ],
        links: [
          { label: 'Choose models and sellers', url: `${VPR_GUIDE_URL}#choose-a-model-and-seller` },
          { label: 'How seller reputation works', url: `${DOCS_BASE_URL}/reputation` },
        ],
      },
      {
        key: 'preferences',
        label: 'Routing preferences',
        intro: 'Preferences apply to every model using automatic seller selection.',
        sections: [
          {
            heading: 'Trust and price',
            body: 'Minimum trust is an eligibility gate. Price preference changes ranking, while maximum pricing is the hard spending cap when configured.',
          },
          {
            heading: 'Free routes',
            body: 'Prefer free peers gives zero-cost eligible offers a strong ranking advantage; it does not bypass trust or compatibility rules.',
          },
        ],
        links: [{ label: 'Configure routing preferences', url: `${VPR_GUIDE_URL}#set-routing-preferences` }],
      },
      {
        key: 'failover',
        label: 'Automatic failover and pins',
        intro: 'Automatic routes normally keep a soft affinity to the seller that served a conversation successfully, but they can switch after retryable failures.',
        sections: [
          {
            heading: 'When routes switch',
            body: 'A route may change when the seller is unavailable, cooling down, no longer eligible, or fails in a retryable way.',
          },
          {
            heading: 'When routes stay fixed',
            body: 'Explicit seller pins never switch automatically. Model-only selection allows the router to choose another eligible seller.',
          },
        ],
        links: [
          { label: 'Read the routing guide', url: `${VPR_GUIDE_URL}#automatic-seller-selection` },
          { label: 'API routing and explicit pins', url: `${DOCS_BASE_URL}/guides/using-the-api#automatic-routing-and-explicit-pins` },
        ],
      },
    ],
  },
  {
    key: 'privacy',
    label: 'Privacy & security',
    articles: [
      {
        key: 'prompt-visibility',
        label: 'Who can see my requests?',
        intro: 'Antseed is anonymous by default: sellers receive a pseudonymous peer or wallet identity, not Antseed account, name, email, or personal profile.',
        sections: [
          {
            heading: 'Identity and content are separate',
            body: 'A standard seller can process the prompt it serves, but Antseed does not tell the seller who you are. Verified TEE routes can add stronger content confidentiality.',
          },
          {
            heading: 'What stays local',
            body: 'AI VPN configuration, connected-app setup, routing state, and local activity data remain on your device unless a feature explicitly sends them elsewhere.',
          },
        ],
        links: [
          { label: 'Privacy and seller visibility', url: `${VPR_GUIDE_URL}#privacy-transport-and-seller-trust` },
          { label: 'Review Antseed security boundaries', url: `${DOCS_BASE_URL}/security` },
        ],
      },
      {
        key: 'transport',
        label: 'How peer traffic is encrypted',
        intro: 'The preferred node-to-node transport is a mutually authenticated encrypted TCP channel using wallet-signed ephemeral keys.',
        sections: [
          {
            heading: 'WebRTC is the fallback',
            body: 'WebRTC DataChannels are used when a peer advertises WebRTC but cannot use direct encrypted TCP. WebRTC is not the primary AI VPN transport.',
          },
          {
            heading: 'App connection is separate',
            body: 'Your local app may connect through a config-file endpoint or local HTTPS interception; that local connection is separate from the encrypted peer transport.',
          },
        ],
        links: [
          { label: 'Read the transport specification', url: `${DOCS_BASE_URL}/transport` },
          { label: 'Learn about WebRTC data channels', url: 'https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels' },
        ],
      },
      {
        key: 'certificate',
        label: 'Trust the local certificate',
        intro: 'Apps connected through local HTTPS interception must trust the certificate authority the AI VPN generates on your computer.',
        sections: [
          {
            heading: 'When it is needed',
            body: 'Only intercepted HTTPS apps need the certificate. Apps configured to call the local AI VPN API directly do not.',
          },
          {
            heading: 'Certificate errors',
            body: 'Open Connected apps, expand HTTPS certificate, trust the current certificate, and restart the affected app.',
          },
        ],
        links: [{ label: 'Understand the local certificate', url: `${VPR_GUIDE_URL}#trust-the-local-https-certificate` }],
      },
      {
        key: 'tee',
        label: 'TEE-verified sellers',
        intro: 'A Trusted Execution Environment can add hardware-backed confidentiality when a seller offers a verifiable TEE route.',
        sections: [
          {
            heading: 'Verify the evidence',
            body: 'Treat a TEE label as a claim to verify. Attestation must bind the hardware evidence to the workload, seller identity, and expected configuration.',
          },
          {
            heading: 'Availability varies',
            body: 'Not every seller or model runs in a TEE. Standard routes should be assumed visible to the seller unless stated and verified otherwise.',
          },
        ],
        links: [
          { label: 'Verify a seller’s TEE', url: `${DOCS_BASE_URL}/guides/verify-tee` },
          { label: 'Read the TEE privacy guidance', url: `${VPR_GUIDE_URL}#tee-verified-sellers` },
        ],
      },
    ],
  },
  {
    key: 'payments',
    label: 'Credits & payments',
    articles: [
      {
        key: 'balance',
        label: 'Add and understand credits',
        intro: 'Credits are USDC on Base deposited for your AI VPN signing identity. Paid requests consume credits through bounded seller payment channels.',
        sections: [
          {
            heading: 'Available and reserved',
            body: 'Available credits can open new channels or be withdrawn. Reserved credits are assigned to active channels but remain yours until authorized spending is settled.',
          },
          {
            heading: 'Funding methods',
            body: 'The Add credits screen can offer card or USDC funding methods depending on location and currently enabled providers.',
          },
        ],
        links: [
          { label: 'Manage AI VPN credits', url: `${VPR_GUIDE_URL}#credits-and-payments` },
          { label: 'Read the complete payments guide', url: `${DOCS_BASE_URL}/guides/payments` },
          { label: 'Verify official USDC addresses', url: 'https://developers.circle.com/stablecoins/usdc-contract-addresses' },
        ],
      },
      {
        key: 'channels',
        label: 'Payment channels and activity',
        intro: 'A paid session reserves a capped amount for one seller. Each request advances a cumulative authorization, so the seller can settle only up to the latest amount signed.',
        sections: [
          {
            heading: 'Channel switchovers',
            body: 'When a channel budget is exhausted, the AI VPN normally settles it and opens another automatically. One retry may be enough during the switchover.',
          },
          {
            heading: 'Inspect or close channels',
            body: 'Open Activity to view locked amounts, settlement state, spending history, and cooperative or on-chain close actions.',
          },
        ],
        links: [
          { label: 'Understand payment channels', url: `${VPR_GUIDE_URL}#payment-channels-and-reserved-funds` },
          { label: 'Protocol payment flow', url: `${DOCS_BASE_URL}/payments` },
        ],
      },
      {
        key: 'withdraw',
        label: 'Withdraw unused credits',
        intro: 'Open Credits and choose Withdraw unused credits. Only available balance can be withdrawn immediately.',
        sections: [
          {
            heading: 'Reserved funds',
            body: 'Credits reserved by active channels must be released through settlement or channel closure before they become withdrawable.',
          },
          {
            heading: 'Unresponsive seller',
            body: 'Use Activity to request an on-chain close, then follow the displayed grace-period instructions before withdrawing the released balance.',
          },
        ],
        links: [{ label: 'Withdraw and release credits', url: `${VPR_GUIDE_URL}#withdraw-unused-credits` }],
      },
      {
        key: 'identity',
        label: 'Signer and funding wallet',
        intro: 'The AI VPN signing identity authorizes protocol messages and bounded channel spending. It is separate from the wallet used to fund credits.',
        sections: [
          {
            heading: 'Desktop key storage',
            body: 'The desktop signing key is encrypted at rest using the operating system keychain. It does not need to hold normal wallet funds.',
          },
          {
            heading: 'Bounded exposure',
            body: 'A funding wallet can deposit for the signer without giving the AI VPN control of that wallet. Signed channel authorizations are seller-specific, capped, and time-limited.',
          },
        ],
        links: [{ label: 'Signer security boundaries', url: `${DOCS_BASE_URL}/security#signing-identity-vs-funding-wallet` }],
      },
    ],
  },
  {
    key: 'rewards',
    label: 'Rewards',
    articles: [
      {
        key: 'ants',
        label: 'ANTS rewards and claims',
        intro: 'Rewards shows ANTS attributed to eligible network usage on the selected chain. Availability and transferability depend on the deployed contracts and current network phase.',
        sections: [
          {
            heading: 'Claiming',
            body: 'When claims are available, the AI VPN opens a secure browser flow for the authorized wallet signature.',
          },
          {
            heading: 'No guarantees',
            body: 'A pending amount is not a promise of token value, future emissions, permanent eligibility, or immediate transferability.',
          },
        ],
        links: [
          { label: 'Understand AI VPN rewards', url: `${VPR_GUIDE_URL}#rewards` },
          { label: 'Read the ANTS token overview', url: 'https://antseed.com/ants-token' },
        ],
      },
    ],
  },
  {
    key: 'troubleshooting',
    label: 'Troubleshooting',
    articles: [
      {
        key: 'no-peers',
        label: 'No peers or models listed',
        intro: 'Confirm the router is running and the Home status area is healthy, then allow a few seconds for peer discovery.',
        sections: [
          {
            heading: 'Refresh and inspect',
            body: 'Use Refresh models. If the catalog stays empty, enable Developer mode and open Available peers to inspect discovery directly.',
          },
          {
            heading: 'Check network controls',
            body: 'Security software may be blocking peer connections. Antseed prefers encrypted TCP and uses WebRTC DataChannels as a fallback; WebRTC is not its only transport.',
          },
        ],
        links: [{ label: 'Troubleshoot missing peers and models', url: `${VPR_GUIDE_URL}#no-peers-or-models-are-listed` }],
      },
      {
        key: 'app-connect',
        label: "An app won't connect",
        intro: 'Disconnect and reconnect the app from Connected apps, then restart it if the row requests a restart.',
        sections: [
          {
            heading: 'Check overrides',
            body: 'Confirm the app is not overriding the base URL or API settings written by the AI VPN.',
          },
          {
            heading: 'Check compatibility',
            body: 'Confirm the selected model supports the API format used by the app, or follow its integration-specific setup guide.',
          },
        ],
        links: [
          { label: 'Troubleshoot a connected app', url: `${VPR_GUIDE_URL}#a-connected-app-does-not-send-requests` },
          { label: 'Open integration-specific guides', url: INTEGRATIONS_URL },
        ],
      },
      {
        key: 'tls',
        label: 'Certificate or SSL errors',
        intro: 'An intercepted HTTPS app must trust the current certificate generated by the AI VPN.',
        sections: [
          {
            heading: 'Trust and restart',
            body: 'Open Connected apps, expand HTTPS certificate, trust the current certificate, and restart the affected app.',
          },
          {
            heading: 'Old certificate',
            body: 'If an older Antseed certificate is still trusted, trusting the current certificate replaces it for future intercepted connections.',
          },
        ],
        links: [{ label: 'Fix certificate errors', url: `${VPR_GUIDE_URL}#an-app-reports-a-certificate-or-ssl-error` }],
      },
      {
        key: 'payments',
        label: 'Requests fail with payment errors',
        intro: 'Open Credits and compare available balance with reserved balance. A paid channel cannot open without enough available credits for its capped authorization.',
        sections: [
          {
            heading: 'Channel switchovers',
            body: 'When a channel is exhausted, the AI VPN normally settles it and opens another automatically. Retry the request once before changing configuration.',
          },
          {
            heading: 'Inspect Activity',
            body: 'Use Activity to find channels that remain open, are settling, or are waiting for an on-chain close.',
          },
        ],
        links: [{ label: 'Troubleshoot payment errors', url: `${VPR_GUIDE_URL}#requests-fail-with-payment-errors` }],
      },
      {
        key: 'model-not-served',
        label: '"Model is not served by this peer"',
        intro: 'The app requested a model that the selected seller does not currently advertise.',
        sections: [
          {
            heading: 'Refresh the route',
            body: 'Re-select the model in the AI VPN. If the error persists, disconnect and reconnect the app to refresh its model and endpoint state.',
          },
          {
            heading: 'Check the pin',
            body: 'If the route is pinned, confirm that seller still offers the exact model or remove the pin to allow another eligible seller.',
          },
        ],
        links: [{ label: 'Fix a model and seller mismatch', url: `${VPR_GUIDE_URL}#model-is-not-served-by-this-peer` }],
      },
      {
        key: 'slow',
        label: 'Responses are slow or time out',
        intro: 'Seller performance and network paths vary. Try another eligible seller, or remove a hard seller pin so automatic routing can fail over.',
        sections: [
          {
            heading: 'Automatic routes',
            body: 'Retryable failures can cool down the current seller and move a model-only route to another eligible seller.',
          },
          {
            heading: 'Large requests',
            body: 'Large prompts and attachments take longer to upload. The floating activity pulse helps distinguish active transfer from a stalled request.',
          },
        ],
        links: [{ label: 'Troubleshoot slow responses', url: `${VPR_GUIDE_URL}#responses-are-slow-or-time-out` }],
      },
      {
        key: 'reserved',
        label: 'Reserved credits stay unavailable',
        intro: 'Reserved credits are assigned to an active payment channel and cannot be withdrawn until that channel settles or closes.',
        sections: [
          {
            heading: 'Close the channel',
            body: 'Open Activity and request a cooperative close when the seller is reachable. Otherwise request an on-chain close and follow the grace-period instructions.',
          },
        ],
        links: [{ label: 'Release reserved credits', url: `${VPR_GUIDE_URL}#reserved-credits-remain-unavailable` }],
      },
      {
        key: 'diagnostics',
        label: 'Collect diagnostics and report a bug',
        intro: 'Enable Developer mode from Help to reveal logs, peer discovery, connection details, configuration, and the diagnostic report action.',
        sections: [
          {
            heading: 'Before sharing',
            body: 'Review copied diagnostics for secrets or sensitive prompt content before posting them publicly.',
          },
          {
            heading: 'Useful bug details',
            body: 'Include the AI VPN version, operating system, affected app, expected result, actual result, and redacted diagnostics.',
          },
        ],
        links: [
          { label: 'Collect AI VPN diagnostics', url: `${VPR_GUIDE_URL}#collect-diagnostics` },
          { label: 'Open a GitHub issue', url: GITHUB_ISSUES_URL },
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
  { view: 'peers', label: 'Available peers' },
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
  const { status: tunnelStatus, openPublicEndpointModal } = usePublicEndpointModal();
  const snap = useUiSelector((state) => ({
    connectBadgeLabel: state.connectBadge.label,
    networkHealth: state.ovDhtHealth,
    proxyPort: state.ovProxyPort,
    peers: state.ovPeers,
    serviceCount: state.ovServiceCount,
    modelLabel: state.vprRouteSelection.model?.label ?? null,
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
      `Antseed AI VPN v${appVersion}`,
      `Status: ${snap.networkHealth} | ${snap.connectBadgeLabel} | Port ${snap.proxyPort}`,
      `Network: ${snap.peers} peers, ${snap.serviceCount} services`,
      `Model: ${snap.modelLabel ?? 'none selected'}`,
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
      <VprPage title={topic.label} onBack={() => goTo({ topicKey: topic.key, articleKey: null })}>
      <div className={styles.stack}>
        <h2 className={styles.title}>{article.label}</h2>
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
      <VprPage title="Help & Support" onBack={() => goTo({ topicKey: null, articleKey: null })}>
      <div className={styles.stack}>
        <h2 className={styles.title}>{topic.label}</h2>
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
      <VprPage title="Help & Support" backFallback="credits">
      <div className={styles.stack}>

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
          <p className={styles.sectionLabel}>AI VPN</p>
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
            <button type="button" className={styles.row} onClick={() => openExternal(VPR_GUIDE_URL)}>
              <span className={styles.rowText}>
                <span className={styles.rowLabel}>Complete AI VPN guide</span>
                <span className={styles.rowHint}>Full setup, security, payments and troubleshooting</span>
              </span>
              <HugeiconsIcon icon={ArrowUpRight01Icon} size={16} strokeWidth={2} className={styles.rowGlyph} />
            </button>
            <button type="button" className={styles.row} onClick={openPublicEndpointModal}>
              <span className={styles.rowText}>
                <span className={styles.rowLabel}>Internet-accessible endpoint</span>
                <span className={styles.rowHint}>{tunnelStatus?.running ? 'Running — view URL, API key, or provider settings' : 'Set up ngrok or Cloudflare for Cursor and remote agents'}</span>
              </span>
              <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2} className={styles.rowGlyph} />
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
            <button type="button" className={styles.row} onClick={() => openExternal('https://antseed.com/terms-of-service#16-privacy-and-data')}>
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
