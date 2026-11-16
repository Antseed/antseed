/**
 * The staking dashboard as a component another app renders (the gateway
 * console). The pages, data hooks, jobs and wallet session are the ones the
 * standalone dashboard uses, so a page added here shows up in both.
 *
 * The host passes its API base, auth headers and links, provides wagmi +
 * RainbowKit for the dashboard's chain, and picks the pages it shows by their
 * `PAGE_AREAS`, leaving out what it already has. Dialogs mount inside the
 * dashboard's scoped root.
 */
import { useEffect, useRef, useState } from 'react';
import { Dashboard } from './App';
import type { Theme } from './app-context';
import { invalidateAll } from './data';
import { setHost, type AntsHost } from './host';
import './embed.scss';

export { NAV_GROUPS, PAGE_AREAS, PAGES, type Page, type PageArea } from './pages';
export type { AntsHost } from './host';

export interface AntsDashboardProps {
  /** API base, auth headers and routing; dialogs mount inside the dashboard's scoped root. */
  host: Omit<AntsHost, 'embedded' | 'portalTarget'>;
  /** The host's resolved theme. */
  theme: Theme;
}

const noop = () => {};

/** Mount with a `key` per account: switching accounts drops every cached read. */
export function AntsDashboard({ host, theme }: AntsDashboardProps) {
  const portal = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const target = () => portal.current ?? document.body;
    setHost({ ...host, embedded: true, portalTarget: target });
    invalidateAll({ clear: true });
    setReady(true);
    // The host is read once per mount; remount (new `key`) to change it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="ants-embed">
      {ready && <Dashboard theme={theme} toggleTheme={noop} />}
      <div ref={portal} />
    </div>
  );
}
