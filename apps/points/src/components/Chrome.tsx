import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useEffect, useState, type MouseEvent } from 'react';
import { Link, SECTIONS, useActiveSection, type Route } from '../lib/router';
import { epochAt, epochEndMs, formatCountdown } from '../lib/points';
import { DownloadVpnButton } from './DownloadVpn';
import { LINKS } from '../lib/links';
import { XAccountButton } from './Social';


export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function EpochPill() {
  const now = useNow();
  const epoch = epochAt(now);
  return (
    <span className="pill">
      <span className="dot-live" />
      Epoch <b>{epoch}</b> converts in <b>{formatCountdown(epochEndMs(epoch) - now)}</b>
    </span>
  );
}

/** The logo goes home; on the home page it scrolls back to the top (and drops any #section). */
function toTop(e: MouseEvent<HTMLAnchorElement>) {
  if (window.location.pathname !== '/' || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  window.history.replaceState(null, '', `/${window.location.search}`);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  // Some browsers skip smooth scrolling in background tabs: make sure we land.
  window.setTimeout(() => { if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'instant' }); window.dispatchEvent(new Event('scroll')); }, 700);
}

export function Header({ route }: { route: Route }) {
  const onSand = route !== 'home';
  return (
    <header className={`top${onSand ? ' on-sand' : ''}`}>
      <div className="wrap">
        <div className="bar">
          <Link href="/" className="brand" aria-label="Antseed Points home" onClick={toTop}>
            {/* The full logo (ant + wordmark) in ink: its usual green ant would vanish on the green header. */}
            <img src="/wordmark-ink.svg" alt="Antseed" width={104} height={36} />
            <span>Points</span>
          </Link>
          <nav className="mainnav" aria-label="Main">
            <NavLinks route={route} />
          </nav>
          <div className="right">
            <XAccountButton />
            <ConnectButton.Custom>
              {({ account, openAccountModal, mounted }) =>
                mounted && account ? (
                  <button type="button" className="btn btn-line btn-sm" onClick={openAccountModal}>
                    {account.displayName}
                  </button>
                ) : (
                  // Most visitors never need a wallet (it's only for claiming and staking, which ask for it
                  // themselves), so the header's one action is the way to start: the AI VPN.
                  <DownloadVpnButton className="btn btn-ink btn-sm" label="Download the AI VPN" phoneLabel="Get the AI VPN" />
                )
              }
            </ConnectButton.Custom>
          </div>
        </div>
        <nav className="tabs-m" aria-label="Sections">
          <NavLinks route={route} />
        </nav>
      </div>
    </header>
  );
}

/** The home page's sections; the links scroll there, from anywhere on the site. */
function NavLinks({ route }: { route: Route }) {
  const active = useActiveSection(route === 'home');
  return (
    <>
      {SECTIONS.map((s) => (
        <Link key={s.id} href={`#${s.id}`} aria-current={active === s.id ? 'location' : undefined}>
          {s.label}
        </Link>
      ))}
    </>
  );
}

export function Footer({ asOfBlock }: { asOfBlock?: number }) {
  return (
    <footer className="field-ink foot">
      <div className="wrap foot-g">
        <div className="stack" style={{ gap: 10, maxWidth: 420 }}>
          <img src="/wordmark-white.svg" alt="Antseed" width={104} height={36} />
          <p style={{ margin: 0, opacity: 0.8, fontSize: 14 }}>
            Points come straight from the Antseed contracts on Base. ANTS amounts before Thursday are estimates, not financial advice.
          </p>
          {asOfBlock ? <span style={{ fontSize: 12, opacity: 0.6 }}>Data from Antscan, as of Base block {asOfBlock.toLocaleString('en-US')}</span> : null}
        </div>
        <nav className="foot-col" aria-label="Start">
          <b>Start</b>
          <DownloadVpnButton className="" label="Download the AI VPN" />
          <a href={LINKS.desktopDocs}>Add funds and get going</a>
          <a href={LINKS.quickstart}>Use the API gateway</a>
        </nav>
        <nav className="foot-col" aria-label="Learn">
          <b>Learn</b>
          <a href={LINKS.rules}>Full reward rules</a>
          <a href={LINKS.tokenomics}>ANTS tokenomics</a>
          <a href={LINKS.antscan}>Antscan</a>
        </nav>
        <nav className="foot-col" aria-label="Antseed">
          <b>Antseed</b>
          <a href={LINKS.site}>antseed.com</a>
          <a href={LINKS.x}>@antseed on X</a>
        </nav>
      </div>
    </footer>
  );
}

export function Toast({ text }: { text: string | null }) {
  return (
    <div className={`toast${text ? ' show' : ''}`} role="status">
      {text}
    </div>
  );
}
