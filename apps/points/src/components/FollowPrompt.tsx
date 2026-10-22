import { useEffect, useState } from 'react';
import { useMe } from '../lib/social';
import { XLogo } from './Social';

export const FOLLOW_URL = 'https://x.com/intent/follow?screen_name=antseed';
/**
 * The post we ask people to like and reply to (the launch announcement). Set it to the post's ID,
 * the number at the end of its x.com link; while it's empty the card only asks for a follow.
 */
export const PROMO_POST_ID = '';
const LIKE_URL = `https://x.com/intent/like?tweet_id=${PROMO_POST_ID}`;
const REPLY_URL = `https://x.com/intent/post?in_reply_to=${PROMO_POST_ID}`;
const KEY = 'antseed-points.follow-asked';

const asked = (id: string) => {
  try {
    return (localStorage.getItem(KEY) ?? '').split(',').includes(id);
  } catch {
    return false;
  }
};
const remember = (id: string) => {
  try {
    const all = new Set((localStorage.getItem(KEY) ?? '').split(',').filter(Boolean));
    all.add(id);
    localStorage.setItem(KEY, [...all].join(','));
  } catch {
    /* private window: the card just shows again next time */
  }
};

/**
 * Once someone signs in with X, ask them (once per X account) to follow @antseed. We can't see
 * whether they already follow without extra X permissions, so the answer is remembered locally.
 */
export function FollowPrompt() {
  const me = useMe().data;
  const id = me?.signedIn ? me.xId ?? me.handle ?? null : null;
  const [show, setShow] = useState(false);
  useEffect(() => setShow(Boolean(id && !asked(id))), [id]);
  if (!show || !id) return null;
  const close = () => {
    remember(id);
    setShow(false);
  };
  return (
    <aside className="follow" role="dialog" aria-label="Follow Antseed on X">
      <span className="follow-mark"><XLogo size={18} /></span>
      <div className="stack" style={{ gap: 4 }}>
        <b>You're in{me?.handle ? `, @${me.handle}` : ''}.</b>
        <span>{PROMO_POST_ID ? 'Follow @antseed, and like and reply to the launch post to spread the word.' : 'Follow @antseed for weekly rewards and new providers.'}</span>
      </div>
      <div className="follow-act">
        <a className="btn btn-ink btn-sm" href={FOLLOW_URL} target="_blank" rel="noopener noreferrer" onClick={PROMO_POST_ID ? undefined : close}>Follow @antseed</a>
        {PROMO_POST_ID && (
          <>
            <a className="btn btn-line btn-sm" href={LIKE_URL} target="_blank" rel="noopener noreferrer">Like the post</a>
            <a className="btn btn-line btn-sm" href={REPLY_URL} target="_blank" rel="noopener noreferrer">Reply</a>
          </>
        )}
        <button type="button" className="linkish" onClick={close}>{PROMO_POST_ID ? 'Done' : 'Not now'}</button>
      </div>
    </aside>
  );
}
