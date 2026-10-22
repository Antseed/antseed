import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from 'react';

export type Route = 'home' | 'profile';

/** Sections of the one-page home, in page order. The nav scrolls to them. */
export type Section = 'me' | 'leaderboard' | 'providers' | 'stake' | 'how';
export const SECTIONS: { id: Section; label: string }[] = [
  { id: 'me', label: 'Your points' },
  { id: 'leaderboard', label: 'Leaderboard' },
  { id: 'providers', label: 'Providers' },
  { id: 'stake', label: 'Stake' },
  { id: 'how', label: 'How it works' },
];

/** Old page URLs (and the X sign-in redirects to /me) now land on their section of the home page, keeping ?agent= and the like. */
const LEGACY: Record<string, Section> = { '/me': 'me', '/leaderboard': 'leaderboard', '/providers': 'providers', '/stake': 'stake', '/how': 'how' };
{
  const legacy = LEGACY[window.location.pathname.replace(/\/$/, '')];
  if (legacy) window.history.replaceState(null, '', `/${window.location.search}#${legacy}`);
}

const routeOf = (pathname: string): Route => (pathname.startsWith('/u/') ? 'profile' : 'home');

/** The @handle in a /u/:handle profile URL. */
export const profileHandleFrom = (pathname: string) => decodeURIComponent(pathname.slice(3).split('/')[0] ?? '').replace(/^@/, '');

const listeners = new Set<() => void>();

export function navigate(to: string) {
  const [path, hash] = to.split('#');
  // A section link from the home page itself only scrolls, keeping any ?address= in the URL.
  const here = path === '/' && hash ? window.location.pathname === '/' : path === window.location.pathname + window.location.search;
  if (!here) {
    window.history.pushState(null, '', path || '/');
    listeners.forEach((l) => l());
    if (!hash) window.scrollTo({ top: 0 });
  }
  if (hash) goToSection(hash as Section, here);
}

/**
 * Scroll to a home-page section, waiting a moment if the home page is still mounting.
 * Smooth within the page; a jump when arriving from another page or an old URL, and a jump as a
 * fallback if the smooth scroll didn't happen (some browsers skip it in background tabs).
 */
export function goToSection(id: Section, smooth = true, tries = 20) {
  const el = document.getElementById(id);
  if (!el) {
    if (tries > 0) window.setTimeout(() => goToSection(id, false, tries - 1), 50);
    return;
  }
  if (window.location.hash !== `#${id}`) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${id}`);
  const settled = () => Math.abs(el.getBoundingClientRect().top - parseFloat(getComputedStyle(el).scrollMarginTop || '0')) < 4;
  el.scrollIntoView({ behavior: smooth ? 'smooth' : 'instant', block: 'start' });
  window.setTimeout(() => {
    if (!settled()) el.scrollIntoView({ behavior: 'instant', block: 'start' });
    // Make sure the nav highlight catches up even where a jump fires no scroll event.
    window.dispatchEvent(new Event('scroll'));
  }, smooth ? 900 : 250);
}

export function useRoute(): Route {
  return routeOf(usePathname());
}

/** Scroll to the section in the URL hash once the page has rendered (deep links, old page URLs). */
export function useInitialSection() {
  useEffect(() => {
    const id = window.location.hash.slice(1) as Section;
    if (!SECTIONS.some((s) => s.id === id)) return;
    goToSection(id, false);
    // Sections above keep growing as their data loads, so land again a couple of times,
    // unless the visitor has started scrolling on their own.
    let moved = false;
    const stop = () => { moved = true; };
    const events = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const;
    events.forEach((e) => window.addEventListener(e, stop, { passive: true, once: true }));
    const timers = [1200, 2500, 4000].map((ms) => window.setTimeout(() => { if (!moved) goToSection(id, false); }, ms));
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      events.forEach((e) => window.removeEventListener(e, stop));
    };
  }, []);
}

/** The home-page section currently on screen, for highlighting the nav. */
export function useActiveSection(enabled: boolean): Section | null {
  const [active, setActive] = useState<Section | null>(null);
  useEffect(() => {
    if (!enabled) return setActive(null);
    const onScroll = () => {
      // The last section whose top has passed a line a third of the way down the screen.
      const line = window.innerHeight / 3;
      let current: Section | null = null;
      for (const { id } of SECTIONS) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= line) current = id;
      }
      setActive(current);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [enabled]);
  return active;
}

/** The current path; re-renders on every navigation, including /u/a → /u/b. */
export function usePathname(): string {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    listeners.add(update);
    window.addEventListener('popstate', update);
    return () => {
      listeners.delete(update);
      window.removeEventListener('popstate', update);
    };
  }, []);
  return path;
}

export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0 || href.startsWith('http')) return;
    // '#me' style links scroll within the home page from anywhere on the site.
    e.preventDefault();
    navigate(href.startsWith('#') ? `/${href}` : href);
  };
  return <a href={href} onClick={handle} {...rest} />;
}
