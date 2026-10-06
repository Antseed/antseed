import type { CSSProperties, JSX } from 'react';
import { DroidBrandIcon } from './DroidBrandIcon';
import { HermesBrandIcon } from './HermesBrandIcon';

/**
 * Vendor brand marks for the AI VPN Home screen (tool buttons + Popular list).
 *
 * These render inline as SVG so they inherit `currentColor` where monochrome
 * and pin brand hues where the mark is iconic.
 *
 * Resolution is by substring match against a profile `name`, a provider slug,
 * or a model label, so callers can pass whatever identifier they have on hand.
 */

export type BrandKey =
  | 'anthropic'
  | 'openai'
  | 'codex'
  | 'opencode'
  | 't3code'
  | 'pi'
  | 'crush'
  | 'goose'
  | 'zed'
  | 'deepseek'
  | 'qwen'
  | 'kimi'
  | 'glm'
  | 'gemini'
  | 'grok'
  | 'mistral'
  | 'minimax'
  | 'llama'
  | 'telegram'
  | 'hermes'
  | 'droid'
  | 'cursor'
  | 'cloudflare'
  | 'ngrok'
  | 'generic';

type BrandGlyph = (props: { size: number }) => JSX.Element;

const ANTHROPIC_ORANGE = '#D97757';
const CRUSH_PINK = '#FF60B8';
const ZED_BLUE = '#084CCF';
const DEEPSEEK_BLUE = '#4D6BFE';
const GLM_BLUE = '#3859FF';
const GEMINI_BLUE = '#4285F4';
const MISTRAL_ORANGE = '#FA500F';
const META_BLUE = '#0668E1';
const TELEGRAM_BLUE = '#26A5E4';
const CLOUDFLARE_ICON = new URL('../../../assets/cloudflare.svg', import.meta.url).href;
const NGROK_ICON = new URL('../../../assets/ngrok.svg', import.meta.url).href;
const T3CODE_ICON = 'data:image/png;base64,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';
const MINIMAX_ICON = 'data:image/png;base64,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';

const glyphs: Record<BrandKey, BrandGlyph> = {
  // Anthropic / Claude — radiating sunburst mark.
  anthropic: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <g stroke={ANTHROPIC_ORANGE} strokeWidth={2} strokeLinecap="round">
        <path d="M12 3v18" />
        <path d="M3 12h18" />
        <path d="M5.6 5.6l12.8 12.8" />
        <path d="M18.4 5.6L5.6 18.4" />
      </g>
    </svg>
  ),
  // OpenAI / ChatGPT — official blossom geometry from OpenAI's favicon.
  openai: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M12.9851 6.93777C13.1163 6.54364 13.1618 6.12607 13.1186 5.71295C13.0754 5.29983 12.9444 4.90072 12.7344 4.54231C12.4232 4.00021 11.9478 3.57101 11.3768 3.31664C10.8058 3.06227 10.1687 2.99589 9.55751 3.12706C9.28184 2.81639 8.943 2.56818 8.56362 2.39905C8.18425 2.22993 7.77314 2.14379 7.3578 2.1464C6.73292 2.1449 6.1237 2.34187 5.61797 2.70892C5.11225 3.07598 4.73616 3.59415 4.54391 4.18873C4.13684 4.27206 3.75225 4.44139 3.41591 4.68539C3.07957 4.92938 2.79924 5.24241 2.59368 5.60352C2.27994 6.14413 2.14602 6.77039 2.21123 7.39205C2.27644 8.01367 2.5374 8.59851 2.95649 9.06224C2.82527 9.45637 2.77975 9.87394 2.82297 10.2871C2.8662 10.7002 2.99718 11.0993 3.20713 11.4577C3.51841 11.9998 3.99385 12.4289 4.56484 12.6833C5.13584 12.9377 5.77289 13.0041 6.38407 12.8729C6.65975 13.1836 6.99862 13.4318 7.37796 13.601C7.75734 13.7701 8.16844 13.8562 8.58379 13.8536C9.20899 13.8552 9.81853 13.6582 10.3244 13.2909C10.8304 12.9236 11.2065 12.4051 11.3986 11.8101C11.8057 11.7268 12.1903 11.5575 12.5266 11.3135C12.8629 11.0695 13.1433 10.7564 13.3488 10.3953C13.6622 9.85477 13.7958 9.22866 13.7304 8.60726C13.6651 7.98587 13.4041 7.40129 12.9851 6.93777ZM8.58472 13.0883C8.0715 13.089 7.57441 12.9093 7.18031 12.5805C7.19808 12.5708 7.22925 12.5537 7.24956 12.5413L9.58061 11.1948C9.63911 11.1615 9.6877 11.1133 9.72136 11.055C9.75505 10.9967 9.77258 10.9305 9.77217 10.8632V7.57684L10.7575 8.14576C10.7626 8.14834 10.7671 8.15214 10.7704 8.15685C10.7738 8.16157 10.7759 8.16704 10.7766 8.17275V10.8943C10.7759 11.4756 10.5448 12.0329 10.1339 12.4441C9.72308 12.8554 9.16599 13.087 8.58472 13.0883ZM3.87091 11.075C3.61385 10.6309 3.5212 10.1105 3.60918 9.60485C3.62649 9.61524 3.65673 9.6337 3.67842 9.64617L6.00947 10.9926C6.06756 11.0266 6.13365 11.0445 6.20094 11.0445C6.2682 11.0445 6.33428 11.0266 6.39238 10.9926L9.23834 9.34936V10.4872C9.23867 10.493 9.23755 10.4988 9.23509 10.5041C9.23264 10.5094 9.22892 10.5139 9.22427 10.5174L6.86782 11.878C6.36379 12.1683 5.76516 12.2467 5.20333 12.0962C4.64148 11.9457 4.1623 11.5784 3.87091 11.075ZM3.25768 5.98617C3.51363 5.54141 3.91789 5.2009 4.39966 5.02421C4.39966 5.04429 4.39851 5.07985 4.39851 5.10452V7.79747C4.3981 7.86473 4.41561 7.93087 4.44924 7.98915C4.48287 8.04739 4.5314 8.09563 4.58984 8.1289L7.4358 9.77197L6.45054 10.3409C6.44568 10.3441 6.44009 10.346 6.43429 10.3465C6.4285 10.3471 6.42265 10.3462 6.41729 10.3439L4.06062 8.98216C3.55747 8.69077 3.19039 8.21176 3.03987 7.65013C2.88935 7.08853 2.96768 6.49014 3.25768 5.98617ZM11.3527 7.86994L8.50669 6.22667L9.49198 5.65799C9.49684 5.6548 9.50243 5.65283 9.50823 5.65231C9.51402 5.65178 9.51985 5.65272 9.5252 5.655L11.8819 7.01554C12.2429 7.2241 12.5371 7.53119 12.7299 7.90087C12.9228 8.27056 13.0063 8.68752 12.9707 9.10295C12.9351 9.51839 12.7819 9.91509 12.5291 10.2466C12.2762 10.5781 11.9341 10.8307 11.5428 10.9749C11.5428 10.9546 11.5428 10.919 11.5428 10.8943V8.20137C11.5434 8.13423 11.5261 8.06814 11.4926 8.0099C11.4592 7.95165 11.4109 7.90336 11.3527 7.86994ZM12.3333 6.394C12.316 6.38337 12.2858 6.36514 12.2641 6.3527L9.93303 5.00621C9.87493 4.97232 9.80887 4.95444 9.74158 4.95444C9.67432 4.95444 9.60824 4.97232 9.55014 5.00621L6.70418 6.64951V5.51167C6.70386 5.50585 6.70497 5.50005 6.70743 5.49479C6.70988 5.48952 6.7136 5.48492 6.71826 5.48144L9.0747 4.12203C9.4357 3.91387 9.84853 3.81281 10.2649 3.83068C10.6812 3.84856 11.0838 3.98462 11.4257 4.22296C11.7675 4.46129 12.0344 4.79204 12.1951 5.17652C12.3559 5.56099 12.4038 5.98327 12.3333 6.394ZM6.16851 8.42203L5.18299 7.85311C5.17784 7.85053 5.17336 7.84673 5.17002 7.84202C5.16668 7.8373 5.16455 7.83183 5.16385 7.82609V5.10452C5.16411 4.6877 5.28311 4.27956 5.5069 3.9279C5.73071 3.57623 6.05006 3.29559 6.42756 3.11883C6.80507 2.94206 7.22509 2.87649 7.63851 2.92977C8.05195 2.98306 8.44163 3.153 8.76197 3.41971C8.74421 3.42941 8.71327 3.44649 8.69272 3.45895L6.36168 4.80542C6.30317 4.83867 6.25462 4.8869 6.22093 4.94516C6.18727 5.0034 6.16974 5.06958 6.17012 5.13683L6.16851 8.42203ZM6.70371 7.26803L7.97126 6.53595L9.23878 7.26757V8.73127L7.97126 9.46292L6.70371 8.73127V7.26803Z"
        fill="currentColor"
      />
    </svg>
  ),
  // Codex — OpenAI's monochrome look: terminal window with a prompt.
  codex: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="4.5" stroke="currentColor" strokeWidth={1.7} />
      <g stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
        <path d="M7.2 9.2l3.2 2.8-3.2 2.8" />
        <path d="M12.8 15.2h4" />
      </g>
    </svg>
  ),
  // Opencode — outlined nested square.
  opencode: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" stroke="currentColor" strokeWidth={1.8} />
      <rect x="8.5" y="8.5" width="7" height="7" rx="1.5" fill="currentColor" />
    </svg>
  ),
  // t3code — the desktop app icon (repo assets/nightly, macOS artwork).
  t3code: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <image width="64" height="64" href={T3CODE_ICON} />
    </svg>
  ),
  // pi — the tool's blocky geometric "P" monogram.
  pi: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 4.5h10.5v10.5h-5.25V19.5H6V4.5zm3.5 3.5v3.5H13V8H9.5z"
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  ),
  // Crush (Charm) — glamour heart in charm pink.
  crush: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 20.2S4 15.2 4 9.6C4 6.9 6 5 8.4 5c1.5 0 2.8.7 3.6 1.9C12.8 5.7 14.1 5 15.6 5 18 5 20 6.9 20 9.6c0 5.6-8 10.6-8 10.6z"
        fill={CRUSH_PINK}
      />
    </svg>
  ),
  // goose (Block) — walking goose silhouette.
  goose: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M15.2 3.5c1.5 0 2.6 1.1 2.6 2.5 0 .4-.1.8-.3 1.2l2.5 1-2.3 1c-.1 2.6-1.2 4-2.7 5.2-1.1.9-1.8 1.6-2 2.9h3.3v2.2H6.2c-1.9 0-3.2-1.3-3.2-3 0-1.8 1.4-3 3.3-3h2.9c.9 0 1.6-.4 2.2-1 .9-.9 1.5-1.9 1.6-3.4-.9-.4-1.5-1.3-1.5-2.4 0-1.8 1.5-3.2 3.7-3.2z"
        fill="currentColor"
      />
    </svg>
  ),
  // Zed — brand-blue tile with the angular Z stroke.
  zed: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2.5" y="2.5" width="19" height="19" rx="5" fill={ZED_BLUE} />
      <path
        d="M7.5 7.5H16.5L7.5 16.5H16.5"
        stroke="#fff"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  // Deepseek — stylized whale.
  deepseek: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 13.5c3.2 0 4.6-1.6 6.2-3.4 1.5-1.7 3-3.4 6.3-3.4 2 0 3.4.7 4.5 1.7-.6 2.1-1.7 3.3-3.2 4-1.9.9-3 .3-4.6 1.2C15.8 15 13.9 17.5 10 17.5c-4 0-7-2-7-4z"
        fill={DEEPSEEK_BLUE}
      />
      <circle cx="16.3" cy="9.4" r="0.9" fill="#fff" />
    </svg>
  ),
  // Qwen — geometric petal mark (used for the default free model).
  qwen: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2.5l3.4 6h-6.8L12 2.5zM4.2 8.2h6.8l-3.4 6-3.4-6zM13 8.2h6.8l-3.4 6-3.4-6zM8.6 15.5h6.8L12 21.5l-3.4-6z"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </svg>
  ),
  // Kimi / Moonshot — dark tile with the angular K mark.
  kimi: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" fill="#141416" />
      <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" stroke="currentColor" strokeOpacity={0.25} strokeWidth={0.75} />
      <g stroke="#fff" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round">
        <path d="M8.2 6.8v10.4" />
        <path d="M8.2 13.4l7-6.6" />
        <path d="M10.6 11.4l5 5.8" />
      </g>
    </svg>
  ),
  // GLM / Z.ai — blue tile with a Z stroke.
  glm: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2.5" y="2.5" width="19" height="19" rx="6" fill={GLM_BLUE} />
      <path
        d="M8.5 8.2h7l-7 7.6h7"
        stroke="#fff"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  // Gemini — four-point sparkle.
  gemini: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2.5c.6 5.3 4.2 8.9 9.5 9.5-5.3.6-8.9 4.2-9.5 9.5-.6-5.3-4.2-8.9-9.5-9.5 5.3-.6 8.9-4.2 9.5-9.5z"
        fill={GEMINI_BLUE}
      />
    </svg>
  ),
  // Grok / xAI — slanted cut mark.
  grok: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth={2} strokeLinecap="round">
        <path d="M5 5l14 14" />
        <path d="M19 5l-5.6 5.6" />
      </g>
    </svg>
  ),
  // Mistral — chunky orange M.
  mistral: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 19V5h3l5 6 5-6h3v14h-3v-8.6l-5 6-5-6V19H4z"
        fill={MISTRAL_ORANGE}
      />
    </svg>
  ),
  // MiniMax — exact favicon served by minimax.io.
  minimax: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <image width="32" height="32" href={MINIMAX_ICON} />
    </svg>
  ),
  // Llama / Meta — infinity loop.
  llama: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M7 8.5c-4.5 0-4.5 7 0 7 4.5 0 5.5-7 10-7 4.5 0 4.5 7 0 7-4.5 0-5.5-7-10-7z"
        stroke={META_BLUE}
        strokeWidth={1.8}
      />
    </svg>
  ),
  // Telegram — brand-blue disc with the paper-plane knocked out.
  telegram: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"
        fill={TELEGRAM_BLUE}
      />
    </svg>
  ),
  // Hermes Agent — monochrome portrait mark.
  hermes: HermesBrandIcon,
  droid: DroidBrandIcon,
  cursor: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23"
      />
    </svg>
  ),
  cloudflare: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <image width="24" height="24" href={CLOUDFLARE_ICON} />
    </svg>
  ),
  ngrok: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <image width="24" height="24" href={NGROK_ICON} />
    </svg>
  ),
  // Fallback — generic chip.
  generic: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="4" stroke="currentColor" strokeWidth={1.7} />
      <circle cx="12" cy="12" r="2.4" fill="currentColor" />
    </svg>
  ),
};

/* Model-family marks are matched BEFORE the generic provider/protocol marks:
   the haystack mixes provider slug and model label (e.g. "openai Kimi K3"
   for a Kimi model served over the OpenAI protocol), and the model family
   must win over the transport. */
const MATCHERS: Array<[BrandKey, RegExp]> = [
  // Tunnel vendors must precede model-family names ("ngrok" contains "grok").
  ['cloudflare', /cloudflare/i],
  ['ngrok', /ngrok/i],
  // Pure model families first — these never appear as provider slugs.
  ['kimi', /(kimi|moonshot)/i],
  ['glm', /(glm|zhipu)/i],
  ['deepseek', /deep-?seek/i],
  ['qwen', /(qwen|tongyi)/i],
  ['gemini', /(gemini|gemma|google)/i],
  ['grok', /(grok|(^|[^a-z0-9])x-?ai([^a-z0-9]|$))/i],
  ['mistral', /(mistral|mixtral|magistral|devstral|codestral)/i],
  ['minimax', /mini[-\s]?max/i],
  ['llama', /llama/i],
  // Vendors that double as provider/protocol slugs.
  ['telegram', /telegram/i],
  ['hermes', /^(?:hermes(?:-agent)?)(?: hermes(?: agent)?)?$/i],
  ['droid', /(^|[^a-z0-9])(droid|factory)([^a-z0-9]|$)/i],
  ['cursor', /(^|[^a-z0-9])cursor([^a-z0-9]|$)/i],
  ['anthropic', /(anthropic|claude)/i],
  ['codex', /codex/i],
  ['openai', /(openai|chatgpt|gpt|gpt-)/i],
  ['opencode', /(opencode|open-code)/i],
  ['t3code', /(^|[^a-z0-9])t3[ -]?code([^a-z0-9]|$)/i],
  ['crush', /crush/i],
  ['goose', /goose/i],
  // Standalone words only — these appear inside too many other identifiers.
  ['zed', /(^|[^a-z0-9])zed([^a-z0-9]|$)/i],
  ['pi', /(gooey-?pi|(^|[^a-z0-9])pi([^a-z0-9]|$))/i],
];

/* Model lists resolve the same provider+label pairs on every render — cache
   by haystack so the matcher regexes only ever run once per identifier. */
const BRAND_KEY_CACHE_LIMIT = 4096;
const brandKeyCache = new Map<string, BrandKey>();
const THEME_AWARE_APP_BRANDS = new Set<BrandKey>(['cursor', 'hermes', 'droid']);

export function resolveBrandKey(...candidates: Array<string | null | undefined>): BrandKey {
  const haystack = candidates.filter(Boolean).join(' ');
  if (!haystack) return 'generic';
  const cached = brandKeyCache.get(haystack);
  if (cached) return cached;
  let resolved: BrandKey = 'generic';
  for (const [key, pattern] of MATCHERS) {
    if (pattern.test(haystack)) {
      resolved = key;
      break;
    }
  }
  if (brandKeyCache.size >= BRAND_KEY_CACHE_LIMIT) brandKeyCache.clear();
  brandKeyCache.set(haystack, resolved);
  return resolved;
}

export function isThemeAwareAppBrand(brand: BrandKey): boolean {
  return THEME_AWARE_APP_BRANDS.has(brand);
}

export type BrandIconProps = {
  /** Any identifier — profile name, provider slug, or model label. */
  name?: string | null;
  /** Extra hints matched alongside `name` (e.g. provider + label). */
  hints?: Array<string | null | undefined>;
  /** Explicit brand key; skips resolution when provided. */
  brand?: BrandKey;
  size?: number;
  className?: string;
  style?: CSSProperties;
};

export function BrandIcon({ name, hints, brand, size = 20, className, style }: BrandIconProps): JSX.Element {
  const key = brand ?? resolveBrandKey(name, ...(hints ?? []));
  const Glyph = glyphs[key];
  return (
    <span className={className} style={{ display: 'inline-flex', ...style }} aria-hidden="true">
      <Glyph size={size} />
    </span>
  );
}
