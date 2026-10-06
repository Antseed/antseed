import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  Copy01Icon,
  QrCodeIcon,
  SquareLock01Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { shortAddress } from '../../../core/format';
import { VprCard, VprPage } from '../vpr/VprKit';
import type { DepositWatchStatus } from '../../../types/bridge';
import { BalanceSummaryCard } from './BalanceSummaryCard';
import styles from './VprDepositView.module.scss';
import { recordUserAction } from '../../../modules/telemetry/actions';

const AMOUNT_PRESETS = ['5', '10', '25'];

type Props = { onSelectView?: (view: import('../../types').ViewName) => void };
type Stage = 'choose' | 'crypto';

// The chooser sits "before" the method screen on the slide axis, so
// entering a method slides forward and going back slides back — same
// mechanics as ViewHost, reusing the global .view-pane animations.
const STAGE_INDEX: Record<Stage, number> = { choose: 0, crypto: 1 };
// Must match the .view-pane-in/-out animation duration (--motion-duration).
const STAGE_SLIDE_MS = 300;

type StageSlide = { stage: Stage; previous: Stage | null; direction: 'forward' | 'back' };

type DepositWatchInfo = {
  address: string;
  usdcAddress: string;
  chainId: number;
};

function amountToBaseUnits(amount: string): bigint | null {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return null;
  return BigInt(Math.round(value * 1e6));
}

function baseUnitsToUsd(baseUnits: string | undefined): string {
  if (!baseUnits) return '0';
  const value = Number(baseUnits) / 1e6;
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** EIP-681 payment request: opens a prefilled USDC transfer in mobile wallets. */
function buildPaymentUri(info: DepositWatchInfo, amount: string): string {
  const baseUnits = amountToBaseUnits(amount);
  const base = `ethereum:${info.usdcAddress}@${info.chainId}/transfer?address=${info.address}`;
  return baseUnits ? `${base}&uint256=${baseUnits.toString()}` : base;
}

// ─── Styled QR (round dots, rounded finders, Base badge) ───

/** Official Base mark (24×24): blue disc with the white horizontal slot. */
const BASE_LOGO_PATH =
  'M12 24C18.6274 24 24 18.6274 24 12C24 5.37258 18.6274 0 12 0C5.72532 0 ' +
  '0.578514 4.81465 0.0491943 10.9512H15.8916V13.0488H0.0491943C0.578514 ' +
  '19.1853 5.72532 24 12 24Z';

function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  return `M${x + r},${y} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - 2 * r} ` +
    `a${r},${r} 0 0 1 ${-r},${r} h${-(w - 2 * r)} a${r},${r} 0 0 1 ${-r},${-r} ` +
    `v${-(h - 2 * r)} a${r},${r} 0 0 1 ${r},${-r} z`;
}

/** One finder eye: outer rounded ring (even-odd hole) + solid rounded pupil. */
function finderPaths(x: number, y: number): [string, string] {
  return [
    roundedRectPath(x, y, 7, 7, 2.2) + ' ' + roundedRectPath(x + 1, y + 1, 5, 5, 1.6),
    roundedRectPath(x + 2, y + 2, 3, 3, 1.05),
  ];
}

/**
 * Renders the payment QR as themed SVG: round data dots, rounded finder
 * eyes, and the Base logo in a punched-out center badge. Error correction is
 * 'Q' (25%) so the ~4% of modules hidden by the badge stay well within the
 * recovery budget.
 */
function StyledQr({ text, label }: { text: string; label: string }) {
  const matrix = useMemo(() => {
    try {
      const qr = QRCode.create(text, { errorCorrectionLevel: 'Q' });
      return { size: qr.modules.size, data: qr.modules.data as Uint8Array };
    } catch {
      return null;
    }
  }, [text]);

  if (!matrix) return <div className={styles.qrPlaceholder} aria-hidden="true" />;
  const { size, data } = matrix;
  const center = size / 2;
  const badgeR = size * 0.11; // badge diameter ≈ 22% of QR width
  const clearR = badgeR + 0.6; // dot clearance around the badge
  const logoR = badgeR * 0.82;

  const inFinder = (row: number, col: number): boolean =>
    (row < 7 && col < 7) || (row < 7 && col >= size - 7) || (row >= size - 7 && col < 7);
  const underBadge = (row: number, col: number): boolean =>
    Math.hypot(row + 0.5 - center, col + 0.5 - center) < clearR;

  const dots: JSX.Element[] = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!data[row * size + col]) continue;
      if (inFinder(row, col) || underBadge(row, col)) continue;
      dots.push(<circle key={`${row}-${col}`} cx={col + 0.5} cy={row + 0.5} r={0.34} />);
    }
  }

  return (
    <svg className={styles.qr} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label}>
      <g fill="currentColor">
        {dots}
        {[[0, 0], [size - 7, 0], [0, size - 7]].map(([x, y]) => {
          const [ring, pupil] = finderPaths(x!, y!);
          return (
            <g key={`${x}-${y}`}>
              <path d={ring} fillRule="evenodd" />
              <path d={pupil} />
            </g>
          );
        })}
      </g>
      <circle cx={center} cy={center} r={badgeR} className={styles.qrBadgeBg} />
      <circle cx={center} cy={center} r={logoR} fill="#fff" />
      <path
        d={BASE_LOGO_PATH}
        fill="#0052FF"
        transform={`translate(${center - logoR}, ${center - logoR}) scale(${(logoR * 2) / 24})`}
      />
    </svg>
  );
}

// ─── Payment brand marks ───
// Hand-authored, recognizable-but-generic geometric marks (same idiom as
// BrandIcon) — small trust cues on the deposit option rows.

const USDC_BLUE = '#2775CA';

function UsdcMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill={USDC_BLUE} />
      <text x="12" y="16.6" textAnchor="middle" fontSize="13.5" fontWeight="700" fill="#fff">$</text>
    </svg>
  );
}

function BaseMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#0052FF" />
      <rect x="1" y="10.95" width="15.85" height="2.1" fill="#fff" />
    </svg>
  );
}

/** Apple logo silhouette (the classic bitten-apple path, 814×1000 box). */
const APPLE_LOGO_PATH =
  'M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 ' +
  '202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5' +
  '-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57-155.5-127C46.7 ' +
  '790.7 0 663 0 541.8c0-194.4 126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 ' +
  '162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-' +
  '181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-' +
  '110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 ' +
  '18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z';

/* Circular payment badges for the Fun CTA — same idiom as the chain marks
   (filled discs), with a hairline ring on the white ones so they hold up on
   any surface. */

function ApplePayRoundMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="11.5" fill="#fff" stroke="#d5d7db" />
      <path d={APPLE_LOGO_PATH} fill="#000" transform="translate(7.3 6.4) scale(0.0115)" />
    </svg>
  );
}

function MastercardRoundMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="11.5" fill="#fff" stroke="#d5d7db" />
      <circle cx="9.4" cy="12" r="4.6" fill="#EB001B" />
      <circle cx="14.6" cy="12" r="4.6" fill="#F79E1B" fillOpacity="0.9" />
    </svg>
  );
}

function GooglePayRoundMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="11.5" fill="#fff" stroke="#d5d7db" />
      <g transform="translate(6 6) scale(0.5)">
        <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z" />
        <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.31 7.31 24 12 24z" />
        <path fill="#FBBC05" d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z" />
        <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.69 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z" />
      </g>
    </svg>
  );
}

function VisaRoundMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#1434CB" />
      <text x="12" y="14.6" textAnchor="middle" fontSize="7" fontWeight="800" fontStyle="italic" fill="#fff">VISA</text>
    </svg>
  );
}

function AmexRoundMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#016FD0" />
      <text x="12" y="14.6" textAnchor="middle" fontSize="6" fontWeight="800" fill="#fff">AMEX</text>
    </svg>
  );
}

/** Official Stripe mark — from stripe.com's SVG favicon. */
function StripeMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
      <rect width="512" height="512" rx="64" fill="#533AFD" />
      <path fillRule="evenodd" clipRule="evenodd" d="M120 392L392 334.317V120L120 178.357V392Z" fill="#fff" />
    </svg>
  );
}

/** Official Meridian (mrdn.finance) mark — the green pinwheel favicon. */
function MeridianMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 542.25 542.25" fill="#34D399" aria-hidden="true">
      <path d="M493.18,424.48l-106.09,106.09c-7.48,7.48-17.63,11.69-28.21,11.69h-192.03l250.27-250.27,76.06,76.06c15.58,15.58,15.58,40.85,0,56.43Z" />
      <path d="M375.41,0L125.14,250.27l-76.06-76.06c-15.58-15.58-15.58-40.85,0-56.43L155.16,11.69c7.48-7.48,17.63-11.69,28.21-11.69h192.03Z" />
      <path d="M542.25,375.41l-250.27-250.27,76.06-76.06c15.58-15.58,40.85-15.58,56.43,0l106.09,106.09c7.48,7.48,11.69,17.63,11.69,28.21v192.03Z" />
      <path d="M250.27,417.12l-76.06,76.06c-15.58,15.58-40.85,15.58-56.43,0L11.69,387.09c-7.48-7.48-11.69-17.63-11.69-28.21v-192.03l250.27,250.27Z" />
    </svg>
  );
}

/** Official Arbitrum mark (arbitrum.foundation brand asset). */
function ArbitrumMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 2500 2500" aria-hidden="true">
      <path fill="#213147" d="M226,760v980c0,63,33,120,88,152l849,490c54,31,121,31,175,0l849-490c54-31,88-89,88-152V760c0-63-33-120-88-152l-849-490c-54-31-121-31-175,0L314,608c-54,31-87,89-87,152H226z" />
      <path fill="#12AAFF" d="M1435,1440l-121,332c-3,9-3,19,0,29l208,571l241-139l-289-793C1467,1422,1442,1422,1435,1440z" />
      <path fill="#12AAFF" d="M1678,882c-7-18-32-18-39,0l-121,332c-3,9-3,19,0,29l341,935l241-139L1678,883V882z" />
      <path fill="#9DCCED" d="M1250,155c6,0,12,2,17,5l918,530c11,6,17,18,17,30v1060c0,12-7,24-17,30l-918,530c-5,3-11,5-17,5s-12-2-17-5l-918-530c-11-6-17-18-17-30V719c0-12,7-24,17-30l918-530c5-3,11-5,17-5l0,0V155z M1250,0c-33,0-65,8-95,25L237,555c-59,34-95,96-95,164v1060c0,68,36,130,95,164l918,530c29,17,62,25,95,25s65-8,95-25l918-530c59-34,95-96,95-164V719c0-68-36-130-95-164L1344,25c-29-17-62-25-95-25l0,0H1250z" />
      <polygon fill="#213147" points="642,2179 727,1947 897,2088 738,2234" />
      <path fill="#fff" d="M1172,644H939c-17,0-33,11-39,27L401,2039l241,139l550-1507c5-14-5-28-19-28L1172,644z" />
      <path fill="#fff" d="M1580,644h-233c-17,0-33,11-39,27L738,2233l241,139l620-1701c5-14-5-28-19-28V644z" />
    </svg>
  );
}

/** Official BNB Chain mark (yellow disc + notched-diamond glyph). */
function BnbMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 2496 2496" aria-hidden="true">
      <path fill="#F0B90B" fillRule="evenodd" clipRule="evenodd" d="M1248,0c689.3,0,1248,558.7,1248,1248s-558.7,1248-1248,1248S0,1937.3,0,1248S558.7,0,1248,0L1248,0z" />
      <g fill="#fff">
        <path d="M685.9,1248l0.9,330l280.4,165v193.2l-444.5-260.7v-524L685.9,1248L685.9,1248z M685.9,918v192.3l-163.3-96.6V821.4l163.3-96.6l164.1,96.6L685.9,918L685.9,918z M1084.3,821.4l163.3-96.6l164.1,96.6L1247.6,918L1084.3,821.4L1084.3,821.4z" />
        <path d="M803.9,1509.6v-193.2l163.3,96.6v192.3L803.9,1509.6L803.9,1509.6z M1084.3,1812.2l163.3,96.6l164.1-96.6v192.3l-164.1,96.6l-163.3-96.6V1812.2L1084.3,1812.2z M1645.9,821.4l163.3-96.6l164.1,96.6v192.3l-164.1,96.6V918L1645.9,821.4L1645.9,821.4L1645.9,821.4z M1809.2,1578l0.9-330l163.3-96.6v524l-444.5,260.7v-193.2L1809.2,1578L1809.2,1578L1809.2,1578z" />
        <polygon points="1692.1,1509.6 1528.8,1605.3 1528.8,1413 1692.1,1316.4 1692.1,1509.6" />
        <path d="M1692.1,986.4l0.9,193.2l-281.2,165v330.8l-163.3,95.7l-163.3-95.7v-330.8l-281.2-165V986.4L968,889.8l279.5,165.8l281.2-165.8l164.1,96.6H1692.1L1692.1,986.4z M803.9,656.5l443.7-261.6l444.5,261.6l-163.3,96.6l-281.2-165.8L967.2,753.1L803.9,656.5L803.9,656.5z" />
      </g>
    </svg>
  );
}

/** Official Polygon glyph (polygon.technology brand asset) on the brand disc. */
function PolygonMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#6C00F6" />
      <path
        fill="#fff"
        transform="translate(5.5 6.15) scale(0.0731)"
        d="M66.8,54.7l-16.7-9.7L0,74.1v58l50.1,29l50.1-29V41.9L128,25.8l27.8,16.1v32.2L128,90.2l-16.7-9.7v25.8l16.7,9.7l50.1-29V29L128,0L77.9,29v90.2l-27.8,16.1l-27.8-16.1V86.9l27.8-16.1l16.7,9.7V54.7z"
      />
    </svg>
  );
}

/** Official Ethereum mark (ethereum.org diamond on the #627EEA disc). */
function EthMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="16" fill="#627EEA" />
      <g fill="#fff" fillRule="nonzero">
        <path fillOpacity="0.602" d="M16.498 4v8.87l7.497 3.35z" />
        <path d="M16.498 4L9 16.22l7.498-3.35z" />
        <path fillOpacity="0.602" d="M16.498 21.968v6.027L24 17.616z" />
        <path d="M16.498 27.995v-6.028L9 17.616z" />
        <path fillOpacity="0.2" d="M16.498 20.573l7.497-4.353-7.497-3.348z" />
        <path fillOpacity="0.602" d="M9 16.22l7.498 4.353v-7.701z" />
      </g>
    </svg>
  );
}

function explorerTxUrl(chainId: number | undefined, txHash: string): string | null {
  if (chainId === 8453) return `https://basescan.org/tx/${txHash}`;
  if (chainId === 84532) return `https://sepolia.basescan.org/tx/${txHash}`;
  return null;
}

/**
 * Deposit flow: the chooser always leads with the antseed-pay Crossmint card
 * checkout (hosted page in a narrow app popup) — no region gating; the pay
 * page itself shows a proper dead-end screen where a region can't be served.
 * Then the quick USDC-on-Base transfer (scan-to-pay QR), with hosted
 * providers (Meridian) behind "More options". Everything lands in the hot
 * wallet the main-process sweeper watches. Only pages that need an external
 * wallet signature leave the app.
 */
export function VprDepositView({ onSelectView }: Props) {
  const actions = useActions();
  const snap = useUiSelector((state) => ({
    total: state.creditsTotalUsdc,
    available: state.creditsAvailableUsdc,
    reserved: state.creditsReservedUsdc,
    pending: state.creditsPendingUsdc,
    wallet: state.creditsWalletUsdc,
    totalOwned: state.creditsTotalOwnedUsdc,
    creditLimit: state.creditsCreditLimitUsdc,
  }), shallowEqual);

  const [slide, setSlide] = useState<StageSlide>(() => ({
    stage: 'choose',
    previous: null,
    direction: 'forward',
  }));
  const stage = slide.stage;
  const [amount, setAmount] = useState('10');
  const [watchInfo, setWatchInfo] = useState<DepositWatchInfo | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);
  const [watchStatus, setWatchStatus] = useState<DepositWatchStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const [cardNotice, setCardNotice] = useState<string | null>(null);
  // "More options" expander on the chooser — the Fun CTA leads, everything
  // else (QR transfer, hosted provider pages) sits behind this link.
  const [moreOpen, setMoreOpen] = useState(false);
  const copyTimer = useRef<number | null>(null);
  const balanceValues = {
    available: snap.available,
    reserved: snap.reserved,
    pending: snap.pending,
    wallet: snap.wallet,
    totalOwned: snap.totalOwned,
    creditLimit: snap.creditLimit,
    deposited: snap.total,
  };

  const goToStage = useCallback((next: Stage) => {
    setSlide((current) => current.stage === next ? current : {
      stage: next,
      previous: current.stage,
      direction: STAGE_INDEX[next] >= STAGE_INDEX[current.stage] ? 'forward' : 'back',
    });
  }, []);

  useEffect(() => {
    if (!slide.previous) return undefined;
    const timer = window.setTimeout(() => {
      setSlide((current) => (current.previous ? { ...current, previous: null } : current));
    }, STAGE_SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [slide]);

  // The main process watches the hot wallet for incoming USDC and sweeps it
  // into the Deposits contract while this view is mounted. Both methods use
  // the watcher: QR transfers and card-purchase deliveries land in the
  // same wallet.
  useEffect(() => {
    const bridge = window.antseedDesktop;
    let cancelled = false;
    void bridge?.depositsWatchStart?.().then((result) => {
      if (cancelled) return;
      if (result.ok && result.data) {
        setWatchInfo({ address: result.data.address, usdcAddress: result.data.usdcAddress, chainId: result.data.chainId });
      } else {
        setWatchError(result.error ?? 'Deposit watcher unavailable');
      }
    }).catch((err: unknown) => {
      if (!cancelled) setWatchError(err instanceof Error ? err.message : String(err));
    });
    const unsubscribe = bridge?.onDepositsWatchStatus?.((status) => {
      setWatchStatus(status);
      if (status.phase === 'credited') actions.refreshCredits();
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
      void bridge?.depositsWatchStop?.();
    };
  }, [actions]);

  useEffect(() => () => {
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
  }, []);

  const copyAddress = useCallback(() => {
    if (!watchInfo) return;
    void navigator.clipboard.writeText(watchInfo.address).then(() => {
      setCopied(true);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
    });
  }, [watchInfo]);

  const [payPageNotice, setPayPageNotice] = useState<string | null>(null);

  const openBrowserWallet = useCallback(() => {
    recordUserAction('deposit_start', 'deposit');
    setPayPageNotice(null);
    const call = window.antseedDesktop?.paymentsOpenPayPage?.({ kind: 'deposit', amountUsdc: amount });
    if (!call) {
      setPayPageNotice('Payment page unavailable in this build.');
      return;
    }
    void call.then((result) => {
      if (!result.ok) setPayPageNotice(result.error ?? 'Could not open the payment window.');
    }).catch((err: unknown) => {
      setPayPageNotice(err instanceof Error ? err.message : String(err));
    });
  }, [amount]);

  const openCardProvider = useCallback((providerId: string) => {
    recordUserAction('deposit_start', 'deposit');
    setCardNotice(null);
    void window.antseedDesktop?.paymentsOpenCardProvider?.({ providerId, amountUsdc: amount }).then((result) => {
      if (!result.ok) {
        setCardNotice(result.error ?? 'Could not open the payment page.');
      }
    });
  }, [amount]);

  const statusLine = (() => {
    if (watchError) return { tone: 'error' as const, text: watchError };
    if (!watchStatus) return { tone: 'idle' as const, text: 'Waiting for USDC on Base…' };
    switch (watchStatus.phase) {
      case 'deferred':
        return { tone: 'idle' as const, text: 'Waiting for USDC on Base…' };
      case 'received':
        return { tone: 'busy' as const, text: `Received $${baseUnitsToUsd(watchStatus.amountBaseUnits)} — preparing deposit…` };
      case 'sweeping':
        return { tone: 'busy' as const, text: `Depositing $${baseUnitsToUsd(watchStatus.amountBaseUnits)} to your credits…` };
      case 'credited':
        return { tone: 'done' as const, text: `$${baseUnitsToUsd(watchStatus.amountBaseUnits)} added to your balance` };
      case 'error':
        return { tone: 'error' as const, text: watchStatus.error ?? 'Deposit failed' };
    }
  })();

  const creditedTxUrl = watchStatus?.phase === 'credited' && watchStatus.txHash
    ? explorerTxUrl(watchInfo?.chainId, watchStatus.txHash)
    : null;

  // Status line, tone told by the leading mark: orange pulse while waiting,
  // green pulse once funds are detected/sweeping, a check mark when credited.
  // Dot color is inlined (not a CSS descendant rule) so the tone switch can
  // never be lost to stylesheet scoping.
  const dotColor = statusLine.tone === 'busy'
    ? 'var(--accent-green)'
    : statusLine.tone === 'error'
      ? 'var(--accent-red, #d64545)'
      : '#f59e0b';
  const watchStatusRow = (
    <div className={`${styles.watchStatus} ${styles[`watchStatus_${statusLine.tone}`] ?? ''}`} role="status">
      {statusLine.tone === 'done' ? (
        <HugeiconsIcon icon={Tick02Icon} size={15} strokeWidth={2.5} className={styles.watchCheck} />
      ) : (
        <span
          className={`${styles.watchPulse}${statusLine.tone === 'error' ? ` ${styles.watchPulseStatic}` : ''}`}
          style={{ background: dotColor }}
          aria-hidden="true"
        />
      )}
      {statusLine.text}
    </div>
  );

  const amountForm = (
    <VprCard className={styles.amountCard}>
      <span className={styles.amountLabel}>Amount to add</span>
      <div className={styles.amountRow}>
        {AMOUNT_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className={`${styles.amountPreset}${amount === preset ? ` ${styles.amountPresetActive}` : ''}`}
            onClick={() => setAmount(preset)}
          >
            ${preset}
          </button>
        ))}
        <div className={styles.amountInputWrap}>
          <span>$</span>
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            aria-label="Deposit amount in USD"
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
          />
        </div>
      </div>
      <span className={styles.amountHint}>
        1 credit = 1 USDC{Number(snap.total) === 0 ? ' · Minimum first deposit is $1' : ''}
      </span>
    </VprCard>
  );

  function renderStage(current: Stage): JSX.Element {
    if (current === 'choose') {
      return (
        <VprPage title="Add credits" backFallback="credits">
        <div className={styles.stack}>
          <BalanceSummaryCard values={balanceValues} />

          <div className={styles.primaryMethods}>
            {/* Primary path — always the antseed-pay Crossmint card checkout,
                regardless of region (the pay page shows its own dead-end
                screen where it can't serve). Delivers to the hot wallet the
                deposit watcher sweeps. */}
            <button
              type="button"
              className={styles.funCta}
              onClick={() => openCardProvider('antseed-pay')}
            >
              <span className={styles.funCtaText}>
                <span className={styles.funCtaTitle}>Deposit</span>
                <span className={styles.funCtaCaption}>Powered by Crossmint</span>
              </span>
              <span className={styles.methodBadges} aria-hidden="true">
                <MastercardRoundMark />
                <ApplePayRoundMark />
                <GooglePayRoundMark />
                <VisaRoundMark />
              </span>
            </button>
            {payPageNotice && <div className={styles.cardNotice} role="alert">{payPageNotice}</div>}

            <div className={styles.methodGroup}>
              <button
                type="button"
                className={styles.methodCta}
                onClick={() => {
                  recordUserAction('deposit_start', 'deposit');
                  goToStage('crypto');
                }}
              >
                <span className={styles.methodCtaIcon}>
                  <BaseMark size={22} />
                </span>
                <span className={styles.methodCtaText}>
                  <span className={styles.methodCtaTitle}>Quick deposit</span>
                  <span className={styles.methodCtaCaption}>USDC on Base</span>
                </span>
                <span className={styles.methodBadges} aria-hidden="true">
                  <UsdcMark />
                  <span className={styles.badgeChip}>
                    <HugeiconsIcon icon={QrCodeIcon} size={12} strokeWidth={2} />
                  </span>
                </span>
                <span className={styles.methodArrow} aria-hidden="true">
                  <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2} />
                </span>
              </button>
              <span className={styles.methodFootnote}>* Deposited to your credits by the Antseed relayer network</span>
            </div>
            {cardNotice && <div className={styles.cardNotice} role="alert">{cardNotice}</div>}
          </div>

          <button
            type="button"
            className={styles.moreLink}
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
          >
            <span>More options</span>
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={16}
              strokeWidth={2}
              className={`${styles.moreLinkChevron}${moreOpen ? ` ${styles.moreLinkChevronOpen}` : ''}`}
            />
          </button>

          {moreOpen && (
            <div className={styles.optionList}>
              {/* Fixed lineup — deliberately NOT the configurable card
                  provider list, which may carry legacy entries. These ids
                  always resolve in the main process. */}
              <button type="button" className={styles.methodCta} onClick={() => openCardProvider('meridian')}>
                <span className={styles.methodCtaIcon}>
                  <MeridianMark />
                </span>
                <span className={styles.methodCtaText}>
                  <span className={styles.methodCtaTitle}>Deposit using Meridian</span>
                  <span className={styles.methodCtaCaption}>USDC from any chain</span>
                </span>
                <span className={styles.methodBadges} aria-hidden="true">
                  <EthMark />
                  <ArbitrumMark />
                  <BnbMark />
                  <PolygonMark />
                </span>
              </button>
              {/* The pay page's Stripe integration. US only — elsewhere the
                  page shows its region-unavailable screen. */}
              <button type="button" className={styles.methodCta} onClick={() => openCardProvider('antseed-pay-stripe')}>
                <span className={styles.methodCtaIcon}>
                  <StripeMark size={20} />
                </span>
                <span className={styles.methodCtaText}>
                  <span className={styles.methodCtaTitle}>Deposit using Outerfound</span>
                  <span className={styles.methodCtaCaption}>Card · US only</span>
                </span>
                <span className={styles.methodBadges} aria-hidden="true">
                  <VisaRoundMark />
                  <MastercardRoundMark />
                  <AmexRoundMark />
                </span>
              </button>
            </div>
          )}

          <div className={styles.trustStrip}>
            <span className={styles.trustLine}>
              <HugeiconsIcon icon={SquareLock01Icon} size={12} strokeWidth={2} />
              <span>Encrypted &amp; secure · Non-custodial escrow on Base</span>
            </span>
            <span className={styles.trustLine}>
              <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={2.5} />
              <span>Pay per request · No subscriptions, no lock-in</span>
            </span>
          </div>
        </div>
        </VprPage>
      );
    }

    return (
      <VprPage title="Pay with USDC on Base" onBack={() => goToStage('choose')}>
        <div className={styles.stack}>

          {amountForm}

          <VprCard className={styles.payCard}>
            {watchInfo ? (
              <StyledQr text={buildPaymentUri(watchInfo, amount)} label="Scan to send USDC on Base" />
            ) : (
              <div className={styles.qrPlaceholder} aria-hidden="true" />
            )}
            {watchInfo && (
              <button type="button" className={styles.addressRow} onClick={copyAddress} title={watchInfo.address}>
                <code>{shortAddress(watchInfo.address)}</code>
                <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={14} strokeWidth={2} />
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
            )}
            {watchStatusRow}
            <div className={styles.qrMeta}>
              <span>Credits update automatically</span>
              <span aria-hidden="true">·</span>
              <span>$0.05 network fee</span>
            </div>
            {creditedTxUrl && (
              <button
                type="button"
                className={styles.txLink}
                onClick={() => void window.antseedDesktop?.openExternalUrl?.(creditedTxUrl)}
              >
                <span>View transaction</span>
                <HugeiconsIcon icon={ArrowUpRight01Icon} size={14} strokeWidth={2} />
              </button>
            )}
            <div className={styles.networkWarn}>
              Only send USDC on <strong>Base</strong> — other networks won't
              auto-deposit.
            </div>
          </VprCard>

          <button type="button" className={styles.browserWalletLink} onClick={openBrowserWallet}>
            <span>No wallet on your phone? Pay from a connected wallet instead</span>
            <HugeiconsIcon icon={ArrowUpRight01Icon} size={14} strokeWidth={2} />
          </button>
          {payPageNotice && <div className={styles.cardNotice} role="alert">{payPageNotice}</div>}
        </div>
        </VprPage>
    );
  }

  const sliding = slide.previous !== null;

  return (
    <section
      className={`view-host view-vpr-deposit${sliding ? ` view-host-sliding view-host-${slide.direction}` : ''}`}
      role="tabpanel"
    >
      {slide.previous && (
        <div key={`out-${slide.previous}`} className="view-pane view-pane-out" aria-hidden="true">
          <div className={`view view-pinned-header ${styles.view}`}>{renderStage(slide.previous)}</div>
        </div>
      )}
      <div key={stage} className={`view-pane${sliding ? ' view-pane-in' : ''}`}>
        <div className={`view view-pinned-header ${styles.view}`}>{renderStage(stage)}</div>
      </div>
    </section>
  );
}
