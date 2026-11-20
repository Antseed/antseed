import {useEffect, useRef, useState, type JSX} from 'react';
import clsx from 'clsx';
import {TELEGRAM_URL} from '../config';
import {drawCard} from './card';
import {shareText, shareUrl, type CardFacts} from './cardFacts';
import styles from './JoinPage.module.css';

const FILE = 'mac-colony-waitlist.png';

// X's post link can carry words and a link but never a picture, so on a computer the card goes on the clipboard first
const copyImage = (blob: Blob): Promise<boolean> => {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return Promise.resolve(false);
    return navigator.clipboard.write([new ClipboardItem({'image/png': blob})]).then(() => true, () => false);
  } catch {
    return Promise.resolve(false);
  }
};

/** The waitlist card to share, with the waitlist number: drawn in the browser, with Share on X and Save image. Only the welcome
 *  email's link knows the number, so the sign-up's last step shows CardByEmail instead. */
export function ShareCard({name, mac, number}: CardFacts): JSX.Element {
  const [card, setCard] = useState<{blob: Blob; url: string} | null>(null);
  const [copy, setCopy] = useState<'' | 'copied' | 'failed'>('');
  const [paste, setPaste] = useState('');   // ⌘V or Ctrl+V, known only once the page runs in a browser
  const shown = useRef<string | null>(null);

  // a new card replaces the old one only once it is drawn, so the picture never blinks
  useEffect(() => {
    let live = true;
    void drawCard({name, mac, number}).then((blob) => {
      if (!live || !blob) return;
      const url = URL.createObjectURL(blob);
      if (shown.current) URL.revokeObjectURL(shown.current);
      shown.current = url;
      setCard({blob, url});
    });
    return () => { live = false; };
  }, [name, mac, number]);
  useEffect(() => () => { if (shown.current) URL.revokeObjectURL(shown.current); }, []);
  // the keys only on a computer: a phone that ends up copying just says to paste
  useEffect(() => { if (!matchMedia('(hover: none)').matches) setPaste(/Mac/.test(navigator.platform || navigator.userAgent) ? '⌘V' : 'Ctrl+V'); }, []);

  const text = shareText(mac);
  const link = shareUrl(mac);
  const keys = paste ? ` with ${paste}` : '';
  const note = copy === 'copied' ? `Card copied. Paste it into your X post${keys}.`
    : copy === 'failed' ? 'Your browser didn’t let us copy the card. Save image, then add it to your post.'
    : `Share on X copies your card too. Paste it into the post${keys} and the picture is in.`;
  const save = () => {
    if (!card) return;
    const a = document.createElement('a');
    a.href = card.url; a.download = FILE; a.click();
  };
  // a phone shares the card itself through the share sheet. A computer copies the card, then opens X with the words and the link,
  // so one paste attaches it. The copy is started inside the click and given a moment, then X opens either way
  const share = async () => {
    if (!card) return;
    const file = new File([card.blob], FILE, {type: 'image/png'});
    if (navigator.canShare?.({files: [file]}) && matchMedia('(hover: none)').matches) {
      try { await navigator.share({files: [file], text: `${text} ${link}`}); return; } catch (e) { if ((e as Error).name === 'AbortError') return; }
    }
    const copied = copyImage(card.blob);
    const quick = await Promise.race([copied, new Promise<null>((done) => setTimeout(() => done(null), 800))]);
    open(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(link)}`, '_blank', 'noopener');
    setCopy((quick ?? await copied) ? 'copied' : 'failed');
  };

  return (
    <figure className={styles.cardImage}>
      {card ? <img src={card.url} alt="Your Mac Colony waitlist card" width={1200} height={675} /> : <div className={styles.cardWait} />}
      <figcaption className={styles.go}>
        <button type="button" className={styles.button} disabled={!card} onClick={() => void share()}>Share on X <span aria-hidden="true">↗</span></button>
        <button type="button" className={clsx(styles.button, styles.ghost)} disabled={!card} onClick={save}>Save image</button>
      </figcaption>
      <p className={clsx(styles.hint, copy ? styles.copied : styles.deskNote)} aria-live="polite" data-copy={copy || undefined}>{note}</p>
    </figure>
  );
}

/** Where the card would be before the waitlist number exists: the number, and the card with it, come in the welcome email. */
export function CardByEmail({sent}: {sent?: boolean}): JSX.Element {
  return (
    <div className={styles.mailCard} data-cta="card-email">
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5.5" width="18" height="13" rx="2.5" /><path d="M3.8 7.2l8.2 6 8.2-6" /></svg>
      <div>
        <b>Your card comes with your number</b>
        <span>{sent
          ? 'Look for the email from ants@antseed.com. It has your waitlist number and a link to your card, ready to share on X.'
          : 'Submit the form and ants@antseed.com emails you your waitlist number, with a link to your card to share on X.'}</span>
      </div>
    </div>
  );
}

/** The main call to action once someone has signed up: Local AI Colony, the Telegram group where the first Mac Colony forms. */
export function JoinGroup(): JSX.Element | null {
  if (!TELEGRAM_URL) return null;
  return (
    <div className={styles.group} data-cta="telegram">
      <div><b>Join Local AI Colony on Telegram</b><span>Our local AI group. Setups, models and the first Mac Colony, with the team.</span></div>
      <a className={styles.button} href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer">Join the group <span aria-hidden="true">↗</span></a>
    </div>
  );
}

/** X and GitHub, under the card. */
export function NextSteps(): JSX.Element {
  return (
    <>
      <p className={clsx(styles.eyebrow, styles.small)}>While you wait</p>
      <ol className={styles.next}>
        <li>
          <div><b>Follow @AntSeed on X</b><span>News lands there first.</span></div>
          <a className={clsx(styles.button, styles.sm, styles.ghost)} href="https://x.com/intent/follow?screen_name=AntSeed" target="_blank" rel="noopener noreferrer">Follow</a>
        </li>
        <li>
          <div><b>Star Antseed on GitHub</b><span>Everything we build is open.</span></div>
          <a className={clsx(styles.button, styles.sm, styles.ghost)} href="https://github.com/Antseed/antseed" target="_blank" rel="noopener noreferrer">Star</a>
        </li>
      </ol>
    </>
  );
}
