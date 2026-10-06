import { WalletControls } from '../wallet';
import type { ReactNode } from 'react';
import { useApp } from '../app-context';
import { formatDuration } from '../format';
import { useNow } from '../hooks';
import { NAV_GROUPS, href, type Page } from '../router';
import { ActivityDrawer } from './Activity';
import { AddressLink } from './AddressLink';
import { Toasts } from './Toasts';
import { IconButton } from './ui';

interface Props {
  page: Page;
  /** Last successful overview fetch; drives the epoch countdown. */
  updatedAt: number | null;
  loading: boolean;
  children: ReactNode;
}

export function Layout({ page, updatedAt, children }: Props) {
  return (
    <div className="app">
      <Sidebar page={page} updatedAt={updatedAt} />
      <div className="content">
        <main className="main">{children}</main>
      </div>
      <ActivityDrawer />
      <Toasts />
    </div>
  );
}

/** Left rail: wordmark, grouped navigation, then the epoch clock, theme toggle and wallet pinned to the bottom. */
function Sidebar({ page, updatedAt }: { page: Page; updatedAt: number | null }) {
  const { config, theme, toggleTheme } = useApp();
  return (
    <aside className="sidebar">
      <a className="wordmark" href={href('stake')}>
        ANTS<span>staking</span>
      </a>
      <nav className="sidenav" aria-label="Main">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="sidenav-group">
            <div className="sidenav-label">{group.label}</div>
            {group.items.map((item) => (
              <a key={item.id} href={href(item.id)} className={item.id === page ? 'sidenav-item active' : 'sidenav-item'} aria-current={item.id === page ? 'page' : undefined}>
                <NavIcon page={item.id} />
                <span>{item.label}</span>
              </a>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-foot">
        <EpochChip updatedAt={updatedAt} />
        {config.selectedAddress && <div className="small">Selected account <AddressLink value={config.selectedAddress} copy /></div>}
        <div className="sidebar-foot-row">
          {config.browserWallet ? <WalletControls config={config} /> : <span className="wallet-chip">
            <AddressLink value={config.address} copy className="wallet-chip-addr" />
          </span>}
          <IconButton label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} className="theme-toggle" onClick={toggleTheme}>
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </IconButton>
        </div>
      </div>
    </aside>
  );
}

/** "Epoch 23 · 2d 4h left" pill linking to the network page. */
export function EpochChip({ updatedAt }: { updatedAt: number | null }) {
  const { overview } = useApp();
  const now = useNow(30_000);
  if (!overview) return null;
  const epoch = overview.epoch;
  const boundaryAt = updatedAt !== null ? updatedAt + epoch.secondsToBoundary * 1000 : epoch.nextBoundaryAt * 1000;
  const secondsLeft = Math.max(0, Math.floor((boundaryAt - now) / 1000));
  return (
    <a className="epoch-chip" href={href('network')} title="Current epoch and time until the next boundary">
      <i aria-hidden="true" />
      <span>epoch <strong>{epoch.current}</strong></span>
      <span>· <strong>{formatDuration(secondsLeft)}</strong> left</span>
    </a>
  );
}

function NavIcon({ page }: { page: Page }) {
  const common = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  switch (page) {
    case 'stake':
      return <svg {...common}><path d="M2 13h12M3.5 10.5v-3M7 10.5V4M10.5 10.5V6.5M14 10.5V2.5" /></svg>;
    case 'positions':
      return <svg {...common}><path d="M8 2.5 14 5.5 8 8.5 2 5.5Z" /><path d="m2 8.5 6 3 6-3M2 11.5l6 3 6-3" /></svg>;
    case 'rewards':
      return <svg {...common}><circle cx="8" cy="8" r="5.5" /><path d="M8 5v6M6.2 6.6c0-.9.8-1.4 1.8-1.4s1.8.5 1.8 1.2c0 1.6-3.6.9-3.6 2.5 0 .8.8 1.3 1.8 1.3s1.8-.5 1.8-1.3" /></svg>;
    case 'seller':
      return <svg {...common}><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><circle cx="6" cy="7" r="1.5" /><path d="M4 11c.5-1 1.2-1.5 2-1.5s1.5.5 2 1.5M9.5 6.5h2.5M9.5 9h2.5" /></svg>;
    case 'network':
      return <svg {...common}><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.8 1.8 1.8 9.2 0 11M8 2.5c-1.8 1.8-1.8 9.2 0 11" /></svg>;
    case 'addresses':
      return <svg {...common}><path d="M6.5 9.5a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-.8.8" /><path d="M9.5 6.5a2.5 2.5 0 0 0-3.5 0l-2 2a2.5 2.5 0 0 0 3.5 3.5l.8-.8" /></svg>;
    default:
      return null;
  }
}

function SunIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M13.5 9.5A6 6 0 0 1 6.5 2.5a6 6 0 1 0 7 7z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
