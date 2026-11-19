import {useCallback, useEffect, useMemo, useState, type RefObject} from 'react';
import {useLocation} from '@docusaurus/router';
import {useNavbarMobileSidebar, useNavbarSecondaryMenu} from '@docusaurus/theme-common/internal';
import {prefersReducedMotion} from '@site/src/lib/motion';
import {useDismiss} from './useDismiss';

/** Matches the width where the bar's links come back (the menu button's breakpoint in PhoneMenu.module.css). */
const WIDE_QUERY = '(min-width: 1080px)';
/** The sheet's fade out (PhoneMenu.module.css `fadeOut`). */
const CLOSE_MS = 140;
/** The sheet's rows never start closer than this to the screen's edge. */
const MIN_INSET = 16;

export type SheetPhase = 'closed' | 'open' | 'closing';

type Refs = {
  nav: RefObject<HTMLElement | null>;
  button: RefObject<HTMLElement | null>;
  sheet: RefObject<HTMLElement | null>;
};

type PhoneMenu = {
  /** The menu button opens Docusaurus' mobile sidebar instead (a phone on a page with a doc or blog tree). */
  usesSidebar: boolean;
  phase: SheetPhase;
  expanded: boolean;
  toggle: () => void;
  close: () => void;
};

/** Pins the sheet under the nav, its rows on the logo's line. */
function placeSheet({nav, sheet}: Refs): void {
  const el = sheet.current;
  if (!el || !nav.current) return;
  const logo = nav.current.firstElementChild;   // the nav opens with the logo
  el.style.setProperty('--sheet-top', `${Math.max(0, nav.current.getBoundingClientRect().bottom)}px`);
  el.style.setProperty('--sheet-x', `${Math.max(MIN_INSET, logo?.getBoundingClientRect().left ?? MIN_INSET)}px`);
}

/** While on, the page behind the sheet holds still. */
function useScrollLock(on: boolean): void {
  useEffect(() => {
    if (!on) return undefined;
    const {documentElement: html, body} = document;
    const prev = [html.style.overflow, body.style.overflow];
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    return () => {
      [html.style.overflow, body.style.overflow] = prev;
    };
  }, [on]);
}

/** The phone menu's state: a full-screen sheet under the nav, or the docs' own sidebar where a page has a doc or blog tree. */
export function usePhoneMenu(refs: Refs): PhoneMenu {
  const sidebar = useNavbarMobileSidebar();
  const secondary = useNavbarSecondaryMenu();
  const usesSidebar = sidebar.shouldRender && secondary.content !== undefined;
  const [phase, setPhase] = useState<SheetPhase>('closed');
  const {pathname} = useLocation();

  const close = useCallback(() => {
    setPhase((p) => (p !== 'open' ? p : prefersReducedMotion() ? 'closed' : 'closing'));
  }, []);
  const toggleSheet = useCallback(() => {
    if (phase === 'open') return close();
    placeSheet(refs);
    setPhase('open');
  }, [phase, close, refs]);

  useEffect(() => setPhase('closed'), [pathname]);
  useEffect(() => {
    if (phase !== 'closing') return undefined;
    const t = window.setTimeout(() => setPhase('closed'), CLOSE_MS);
    return () => window.clearTimeout(t);
  }, [phase]);
  useEffect(() => {
    if (phase !== 'open') return undefined;
    const wide = window.matchMedia(WIDE_QUERY);
    const onChange = (e: MediaQueryListEvent) => e.matches && close();
    wide.addEventListener('change', onChange);
    return () => wide.removeEventListener('change', onChange);
  }, [phase, close]);

  const inside = useMemo(() => [refs.sheet, refs.button], [refs.sheet, refs.button]);
  useDismiss(phase === 'open', inside, close, refs.button);
  useScrollLock(phase === 'open');

  return {
    usesSidebar,
    phase,
    expanded: usesSidebar ? sidebar.shown : phase === 'open',
    toggle: usesSidebar ? sidebar.toggle : toggleSheet,
    close,
  };
}
