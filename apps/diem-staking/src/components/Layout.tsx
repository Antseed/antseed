// Static layout sections: Nav, Hero, AlphaStrip, ClaimBanner, HowItWorks, FAQ,
// DualCards, Footer. These don't depend on on-chain state (ClaimBanner and
// Hero take a couple of computed values as props so they can show the max rate /
// pool TVL). Every VPR download link flows through `useVprDownload`
// so Mac, Windows and Linux visitors get a download-proxy href — same
// behaviour as antseed.com.

import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { useAccount } from 'wagmi';

import { fmtPct, fmtPrice } from '../lib/format';
import { useVprDownload, type Platform } from '../lib/vpr';

const ANTSEED_URL = 'https://antseed.com';
const DIEM_TERMS_URL = 'https://diemantseed.com/terms-of-service.html';
const ZOKYO_URL = 'https://www.zokyo.io';
const AUDIT_REPORT_URL = '/antseed-zokyo-audit-report-may-14-2026.pdf';
const CONTRACT_URL_BASE = 'https://basescan.org/address';
type ThemeMode = 'dark' | 'light';
const THEME_STORAGE_KEY = 'diem-theme-mode';

function readInitialTheme(): ThemeMode {
  const current = document.documentElement.getAttribute('data-theme');
  return current === 'light' ? 'light' : 'dark';
}

// OS glyph for the primary download button. Matches the mark used in
// apps/website/src/lib/DesktopDownloadIcon.tsx so the two properties feel
// identical across hosts.
function PlatformIcon({ platform, size = 16 }: { platform: Platform; size?: number }) {
  if (platform === 'win') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M3 5.5L11 4.3v7.2H3zM12 4.2L21 3v8.5h-9zM3 12.5h8v7.2L3 18.5zM12 12.5h9V21l-9-1.3z" />
      </svg>
    );
  }
  if (platform === 'mac') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
      </svg>
    );
  }
  return null;
}

// Platforms where we show the OS-specific label + icon. Other platforms
// (Linux / mobile / unknown) keep the brand-generic "Download VPR →".
function hasDirectInstaller(platform: Platform): platform is 'mac' | 'win' {
  return platform === 'mac' || platform === 'win';
}

export function AlphaStrip({ maxStakeDisplay }: { maxStakeDisplay: string | null }) {
  if (!maxStakeDisplay) {
    return (
      <div className="alpha-strip">
        <span className="alpha-pill">◆ ALPHA</span>
        <span className="alpha-msg">Live on Base mainnet · pool capacity uncapped.</span>
      </div>
    );
  }
  return (
    <div className="alpha-strip">
      <span className="alpha-pill">◆ ALPHA</span>
      <span className="alpha-msg">Alpha cap: <strong>{maxStakeDisplay}</strong> $DIEM total.</span>
    </div>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeMode>(readInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  const toggle = () => {
    const next: ThemeMode = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    document.documentElement.style.colorScheme = next;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Ignore storage failures; the in-page toggle still works.
    }
  };

  return (
    <button
      className="theme-toggle"
      type="button"
      onClick={toggle}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      <span aria-hidden="true">{theme === 'dark' ? '☾' : '☀'}</span>
    </button>
  );
}

export function Nav() {
  const { isConnected } = useAccount();
  const scrollTo = (id: string) => (e: MouseEvent) => {
    e.preventDefault();
    const el = document.getElementById(id);
    if (!el) return;
    const nav = document.querySelector<HTMLElement>('.nav');
    const offset = (nav?.offsetHeight ?? 73) + 8;
    window.scrollTo({ top: Math.max(0, el.offsetTop - offset), behavior: 'smooth' });
    history.replaceState(null, '', `#${id}`);
  };
  return (
    <nav className="nav">
      <a className="brand" href={ANTSEED_URL}>
        <span>
          <span className="ant">ANT</span>
          <span className="seed">SEED</span>
        </span>
        <span className="slash">/</span>
        <span className="diem">Diem Capacity</span>
      </a>
      <div className="nav-links">
        <a href="#how" onClick={scrollTo('how')} className="link hide-sm">How it works</a>
        <a href="#faq" onClick={scrollTo('faq')} className="link hide-sm">FAQ</a>
        <ThemeToggle />
        <div className={`nav-connect-wrap ${isConnected ? 'is-connected' : 'is-disconnected'}`}>
          <ConnectButton
            accountStatus={{ smallScreen: 'avatar', largeScreen: 'full' }}
            chainStatus="none"
            showBalance={false}
          />
        </div>
      </div>
    </nav>
  );
}

export function Hero({ diemPrice, apy }: { diemPrice: number | null; apy: number }) {
  return (
    <section className="hero" id="stake">
      <span className="eyebrow"><span className="pulse" /> Provider Capacity Program on Base</span>
      <h1 className="hero-title">Lock $DIEM to participate in provider capacity.</h1>
      <p className="hero-sub">
        Lock DIEM into the Provider Capacity Program on Base. If the connected provider
        infrastructure processes paid inference requests, eligible participants may receive
        USDC allocations according to the program rules. Allocations are variable, not
        guaranteed, and may be zero.
      </p>
      <div className="hero-meta">
        <span className="live-badge">$DIEM ${fmtPrice(diemPrice)}</span>
        <span className="dot" />
        <span><strong>{fmtPct(apy)}</strong> <span className="apr-sub">max USDC allocation rate</span></span>
        <span className="dot" />
        <span><strong>$ANTS</strong> incentives may be available</span>
        <span className="dot" />
        <span>
          Audited by{' '}
          <a href={ZOKYO_URL} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline', textUnderlineOffset: 2 }}>
            <strong>Zokyo</strong>
          </a>{' '}
          ·{' '}
          <a href={AUDIT_REPORT_URL} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline', textUnderlineOffset: 2 }}>
            View report
          </a>
        </span>
      </div>
    </section>
  );
}

export function ClaimBanner() {
  const { href, platform } = useVprDownload();

  // Jump to the stake card and switch it to the Claim tab (the card listens
  // for this event — see StakeCard).
  const openClaimTab = (e: MouseEvent) => {
    e.preventDefault();
    window.dispatchEvent(new Event('diem:open-claim'));
    const card = document.querySelector<HTMLElement>('.stake-card');
    const nav = document.querySelector<HTMLElement>('.nav');
    const offset = (nav?.offsetHeight ?? 73) + 8;
    if (card) window.scrollTo({ top: Math.max(0, card.offsetTop - offset), behavior: 'smooth' });
  };

  return (
    <div className="claim-banner">
      <div className="claim-banner-inner">
        <div>
          <span className="eyebrow"><span className="pulse" /> $ANTS claims live on this page</span>
          <h2>Claim your <em>$ANTS</em> right here.</h2>
          <p>
            This page handles everything: DIEM locking, withdrawal requests, USDC claims,
            and eligible $ANTS incentives. Open the Claim tab above with the same wallet
            you participate with — no separate app needed to claim. To spend your $ANTS on
            AI models, download VPR, the Antseed desktop app.
          </p>
          <div className="claim-path" aria-label="How to claim ANTS">
            <span><strong>1</strong> Connect wallet</span>
            <span><strong>2</strong> Open Claim tab</span>
            <span><strong>3</strong> Claim USDC</span>
            <span><strong>4</strong> Claim $ANTS</span>
          </div>
          <div className="claim-banner-actions">
            <a href="#stake" className="btn-primary" onClick={openClaimTab}>
              Claim your $ANTS →
            </a>
            {/* Match antseed.com's download button: OS icon + "Download for
                <OS>" when we have a direct installer, brand-generic fallback
                otherwise. */}
            <a
              href={href}
              className="btn-ghost"
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
            >
              {hasDirectInstaller(platform) ? (
                <>
                  <PlatformIcon platform={platform} />
                  {platform === 'mac' ? 'Download VPR for Mac' : 'Download VPR for Windows'}
                </>
              ) : (
                <>Download VPR →</>
              )}
            </a>
            <a href={ANTSEED_URL} className="btn-ghost" target="_blank" rel="noopener noreferrer">
              What is Antseed?
            </a>
          </div>
        </div>
        <div className="claim-mock">
          <div className="line"><span className="comment"># this page › Claim tab</span></div>
          <div className="line"><span className="key">claim location</span><span className="num">this page</span></div>
          <div className="line"><span className="key">wallet</span><span className="num">same as Program</span></div>
          <div className="line"><span className="key">$ANTS pending</span><span className="num">ready to claim</span></div>
          <hr />
          <div className="line"><span className="comment"># spend in VPR on any model →</span></div>
          <div className="line"><span className="key">claude-sonnet-4.6</span><span className="num">ready</span></div>
          <div className="line"><span className="key">gpt-5.2</span><span className="num">ready</span></div>
          <div className="line"><span className="key">sora-2 · video</span><span className="num">ready</span></div>
        </div>
      </div>
    </div>
  );
}

export function HowItWorks() {
  const { href } = useVprDownload();
  return (
    <section id="how">
      <span className="sec-label">How it works</span>
      <h2 className="sec-title">Four steps. <em>Fully on-chain.</em></h2>
      <p className="sec-sub">
        Your $DIEM stays in a smart contract on Base. USDC allocations, if any, depend on
        paid inference activity processed by the connected provider infrastructure, after
        applicable operator fees and program rules.
      </p>

      <div className="steps">
        <Step num="01" label="Lock" title="Lock your $DIEM">
          Connect your wallet and lock DIEM into the Program contract on Base. Your participation
          is governed by smart-contract state and the published Program parameters.
        </Step>
        <Step num="02" label="Capacity" title="Support provider capacity">
          Locked DIEM is used as capacity support for connected provider infrastructure serving
          Antseed inference requests. Usage depends on buyer demand, uptime, pricing, and operations.
        </Step>
        <Step num="03" label="USDC" title="USDC allocations, if any">
          If paid requests are processed, eligible participants may receive USDC allocations after
          applicable operator fees and Program rules. Allocations are not guaranteed and may be zero.
        </Step>
        <Step num="04" label="$ANTS" title="Claim eligible $ANTS right here">
          $ANTS incentives may accrue by epoch if available under the Program rules. Claim
          them from the Claim tab on this page with the same wallet you lock with, then
          spend them on network services in{' '}
          <a href={href} target="_blank" rel="noopener noreferrer">VPR</a>, the Antseed
          desktop app.
        </Step>
      </div>

      <Why />
    </section>
  );
}

function Step(props: { num: string; label: string; title: string; children: ReactNode }) {
  return (
    <div className="step">
      <span className="step-num">{props.num} ·  {props.label}</span>
      <h3>{props.title}</h3>
      <p>{props.children}</p>
    </div>
  );
}

function Why() {
  const items = [
    { h: 'Usage-based USDC allocations', p: 'USDC allocations depend on actual paid usage, pricing, uptime, costs, competition, operator performance, and Program rules. Past activity does not predict future allocations.' },
    { h: 'Your $DIEM stays on Base', p: 'DIEM is locked in a Base smart contract. Participation still involves smart-contract, token, liquidity, operator, tax, and regulatory risks.' },
    { h: 'USDC allocations and token incentives', p: 'Eligible participants may receive USDC allocations from paid provider activity and may receive $ANTS incentives if available under the Program rules. Neither is guaranteed.' },
    { h: 'Transparent operator fee', p: 'A 10% operator fee is currently deducted from gross USDC inflows before remaining USDC is allocated according to the Program rules.' },
  ];
  return (
    <div className="why-block">
      <h3 className="why-subtitle">USDC allocations depend on <em>actual provider usage</em>.</h3>
      <p className="why-lead">
        USDC allocations, if any, come from paid inference requests processed by the connected
        provider infrastructure, after applicable operator fees and Program rules. Usage may
        fluctuate and allocations may be zero.
      </p>
      <div className="why-grid">
        {items.map((it) => (
          <div className="why" key={it.h}>
            <div className="check">✓</div>
            <div>
              <h4>{it.h}</h4>
              <p>{it.p}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DualCards() {
  const { href, platform, label } = useVprDownload();
  return (
    <section>
      <div className="dual">
        <a href={href} className="dual-card" target="_blank" rel="noopener noreferrer">
          <span className="tag">◆  VPR</span>
          <h4>The Antseed desktop app</h4>
          <p>Chat with Claude, GPT, and every open model. Generate images and video. All at provider cost. No subscription markup. Free to download.</p>
          <span className="arrow">{hasDirectInstaller(platform) ? `${label} →` : 'Download VPR →'}</span>
        </a>
        <a href={ANTSEED_URL} className="dual-card" target="_blank" rel="noopener noreferrer">
          <span className="tag">◆  Antseed</span>
          <h4>The P2P AI network</h4>
          <p>No central gatekeeper. No markup. Pay per token in USDC. Connect any agent, any coding tool, or just chat through VPR. Same network underneath.</p>
          <span className="arrow">Explore Antseed →</span>
        </a>
      </div>
    </section>
  );
}

export function FAQ() {
  const { href } = useVprDownload();
  return (
    <section id="faq">
      <span className="sec-label">FAQ</span>
      <h2 className="sec-title">Common questions.</h2>
      <div className="faqs">
        <details className="faq" open>
          <summary>Where do USDC allocations come from?</summary>
          <div className="body">
            USDC allocations, if any, come from paid inference requests processed by the
            connected provider infrastructure and settled through Antseed smart contracts.
            After applicable operator fees and Program deductions, remaining USDC is allocated
            according to the Program rules. No allocation is guaranteed, and future usage may be zero.
          </div>
        </details>
        <details className="faq">
          <summary>How is the maximum rate calculated?</summary>
          <div className="body">
            The displayed rate is based on a fixed maximum of 0.5 USDC per DIEM per day,
            annualized (× 365), then divided by the live DIEM price. It is informational only
            and is not a forecast, target, promise, APY, or guaranteed return. Future USDC
            allocations may be lower or zero.
          </div>
        </details>
        <details className="faq">
          <summary>Has the smart contract been audited?</summary>
          <div className="body">
            Yes. The DIEM staking smart contract was audited by{' '}
            <a href={ZOKYO_URL} target="_blank" rel="noopener noreferrer">Zokyo</a>.{' '}
            <a href={AUDIT_REPORT_URL} target="_blank" rel="noopener noreferrer">View the audit report</a>.
          </div>
        </details>
        <details className="faq">
          <summary>How does withdrawing work?</summary>
          <div className="body">
            From Venice's side the proxy is a single participant, so every withdrawal would reset
            the cooldown for the whole Program. To avoid that we batch: withdrawal requests queue into
            the currently-open withdrawal batch on-chain. You'll see three states in the app:
            <strong>queued</strong> (your amount is in the open batch, accrual stopped
            instantly) → <strong>cooling down</strong> (batch flushed to Venice in one call,
            waiting for Venice's native cooldown) → <strong>claimable</strong> (your DIEM is
            ready to withdraw). Once the current batch finishes claiming, a new batch
            opens. Each state advances with a tx anyone in the batch can trigger — so you'll
            often find yours has moved already by the time you check back.
            <br /><br />
            Each batch also has a minimum open window (24h by default) measured from the
            first queuer — this stops a single user from queuing and immediately flushing,
            which would push everyone else into a fresh Venice cooldown. The queue state
            shows a live countdown until the batch is flushable.
          </div>
        </details>
        <details className="faq">
          <summary>How do I claim eligible $ANTS incentives?</summary>
          <div className="body">
            Eligible $ANTS incentives may be available by epoch for the same wallet you use
            in the Program. Claim them directly from this page: open the Claim tab in the
            card above, connect your wallet, and claim any pending $ANTS. You can then use
            $ANTS on supported network services inside{' '}
            <a href={href} target="_blank" rel="noopener noreferrer">VPR</a>, the Antseed
            desktop app.
          </div>
        </details>
        <details className="faq">
          <summary>What's an epoch and how often can USDC be claimed?</summary>
          <div className="body">
            USDC allocations, if any, are credited by the contract when paid inference activity
            settles and Program conditions are met. There is no epoch wait for claimable USDC;
            claim to your wallet whenever available. <strong>$ANTS</strong> incentives are
            calculated by weekly epoch if available under Program rules and may be subject to
            eligibility, validation, caps, delays, or other restrictions.
          </div>
        </details>
        <details className="faq">
          <summary>Are there any pool fees?</summary>
          <div className="body">
            Yes. A 10% operator fee is currently deducted from gross USDC inflows before
            remaining USDC is allocated according to the Program rules. The fee compensates
            provider infrastructure operation and related costs. Your wallet transactions
            still require Base gas.
          </div>
        </details>
      </div>
    </section>
  );
}

export function Footer({ proxyAddress }: { proxyAddress: string | null }) {
  const { href: vprHref } = useVprDownload();
  const contractHref = proxyAddress ? `${CONTRACT_URL_BASE}/${proxyAddress}` : `${CONTRACT_URL_BASE}/`;
  return (
    <footer>
      <div>
        <a className="brand" href="/">
          <span>
            <span className="ant">ANT</span>
            <span className="seed">SEED</span>
          </span>
          <span className="slash">/</span>
          <span className="diem">Diem</span>
        </a>
      </div>
      <div className="links">
        <a href={ANTSEED_URL}>antseed.com</a>
        <a href={vprHref} target="_blank" rel="noopener noreferrer">VPR</a>
        <a href={contractHref} target="_blank" rel="noopener noreferrer">Contract</a>
        <a href={AUDIT_REPORT_URL} target="_blank" rel="noopener noreferrer">Audit</a>
        <a href="#stake">Lock DIEM</a>
        <a href={DIEM_TERMS_URL} target="_blank" rel="noopener noreferrer">Terms</a>
      </div>
      <div>Live on Base · v0.1</div>
    </footer>
  );
}

export { ANTSEED_URL };
