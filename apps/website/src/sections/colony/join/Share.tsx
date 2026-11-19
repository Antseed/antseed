import {useEffect, useRef, useState, type JSX} from 'react';
import clsx from 'clsx';
import {TELEGRAM_URL} from '../config';
import {drawCard} from './card';
import {shareText, shareUrl, SHARE_URL, type CardFacts} from './cardFacts';
import styles from './JoinPage.module.css';

const FILE = 'mac-colony-waitlist.png';

/** The waitlist card to share: drawn in the browser from what they told us, with Share on X and Save image. */
export function ShareCard({name, mac, number}: CardFacts): JSX.Element {
  const [card, setCard] = useState<{blob: Blob; url: string} | null>(null);
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

  const text = shareText(mac);
  const link = shareUrl(mac);
  const model = link === SHARE_URL ? '' : mac.split(' · ')[0];
  const hint = `Your post on X shows ${model ? `a card for your ${model}` : 'the Colony waitlist card'}. Save image keeps this one${name ? ', with your name' : ''}.`;
  const save = () => {
    if (!card) return;
    const a = document.createElement('a');
    a.href = card.url; a.download = FILE; a.click();
  };
  // a phone shares their own card as the picture; a computer opens X with the words and a link whose preview is the card for their Mac
  const share = async () => {
    const file = card && new File([card.blob], FILE, {type: 'image/png'});
    if (file && navigator.canShare?.({files: [file]}) && matchMedia('(hover: none)').matches) {
      try { await navigator.share({files: [file], text: `${text} ${link}`}); return; } catch (e) { if ((e as Error).name === 'AbortError') return; }
    }
    open(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(link)}`, '_blank', 'noopener');
  };

  return (
    <figure className={styles.cardImage}>
      {card ? <img src={card.url} alt="Your Mac Colony waitlist card" width={1200} height={675} /> : <div className={styles.cardWait} />}
      <figcaption className={styles.go}>
        <button type="button" className={styles.button} disabled={!card} onClick={() => void share()}>Share on X <span aria-hidden="true">↗</span></button>
        <button type="button" className={clsx(styles.button, styles.ghost)} disabled={!card} onClick={save}>Save image</button>
      </figcaption>
      <p className={clsx(styles.hint, styles.deskNote)}>{hint}</p>
    </figure>
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
