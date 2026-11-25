import {useEffect, useState} from 'react';
import {JOIN_HREF} from './config';

/** The keys a visitor arrives with that the waitlist should keep: a friend's invite code or a creator's link (?ref=, ?utm_source=). */
const CARRIED = ['ref', 'utm_source'] as const;

/** The sign-up link, carrying where the visitor came from to /colony/join/ (the server render links without it). */
export function useJoinHref(): string {
  const [href, setHref] = useState(JOIN_HREF);
  useEffect(() => {
    const from = new URLSearchParams(location.search), carry = new URLSearchParams();
    for (const key of CARRIED) { const v = from.get(key); if (v) carry.set(key, v.slice(0, 80)); }
    if ([...carry].length) setHref(`${JOIN_HREF}?${carry}`);
  }, []);
  return href;
}
