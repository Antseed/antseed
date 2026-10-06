import {useHistory} from '@docusaurus/router';

/* The viewport where AI VPN CTAs read "Get Started" and reroute — must stay in
   sync with the 640px breakpoint that swaps the label in custom.css. */
const MOBILE_GET_STARTED_QUERY = '(max-width: 640px)';

/* Primary input is a touchscreen that can't hover — true on phones and
   tablets, and unaffected by "Desktop site" mode, which fakes the UA string
   and the layout viewport but not the hardware. Touchscreen laptops keep a
   fine primary pointer with hover, so they stay on the download path. */
const TOUCH_ONLY_QUERY = '(pointer: coarse) and (hover: none)';

/**
 * True when the visitor should get the /get-started flow instead of a
 * desktop installer. The 640px viewport check alone misses phones browsing
 * in "Desktop site" mode: they report a desktop-sized layout viewport and a
 * spoofed desktop UA (Samsung Internet uses X11/Linux), which used to hand
 * them an AppImage they can't run. The extra signals — touch-only hardware,
 * the UA-CH mobile bit, and mobile UA tokens — close that hole. Also used by
 * click tracking (Root.tsx) to classify taps on download links.
 */
export function isMobileGetStartedVisitor(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia(MOBILE_GET_STARTED_QUERY).matches) return true;
  if (window.matchMedia(TOUCH_ONLY_QUERY).matches) return true;
  const nav = navigator as Navigator & {userAgentData?: {mobile?: boolean}};
  if (nav.userAgentData?.mobile) return true;
  return /Android|iPhone|iPad|Mobi/i.test(navigator.userAgent);
}

/* On phones (where AI VPN CTAs read "Get Started") download buttons route to
   the /get-started Telegram flow instead of downloading an installer the
   device can't run. Desktop keeps the direct download. */
export function useMobileGetStarted() {
  const history = useHistory();
  return (e: {preventDefault: () => void}) => {
    if (isMobileGetStartedVisitor()) {
      e.preventDefault();
      history.push('/get-started');
    }
  };
}
