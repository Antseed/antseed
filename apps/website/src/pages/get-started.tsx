/**
 * /get-started — the mobile onboarding flow (Figma "mobile-1" / "mobile-2").
 *
 * On phones the site's "Get Started" CTAs land here instead of the desktop
 * installer: Antseed runs on a computer, so the mobile path walks through
 * creating a Telegram bot with @BotFather now and pasting the token into
 * the AI VPN later. Two screens, hash-routed (`#instructions`) so the browser
 * back button works between them. Rendered without the site Layout — the
 * design is a bare, focused flow with its own "Back to site" affordance.
 */
import {useEffect, useRef, useState} from 'react';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import {ArrowRight, Reveal} from '../components/ui';
import styles from './get-started.module.css';

const INSTRUCTIONS_HASH = '#instructions';

/* ---------- icons — exact glyphs from the Figma file ---------- */
/* hugeicons:computer (20) */
function ComputerIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11.6666 17.5H13.3333M11.6666 17.5C11.3351 17.5 11.0172 17.3683 10.7827 17.1339C10.5483 16.8995 10.4166 16.5815 10.4166 16.25V14.1667H9.99996M11.6666 17.5H8.33329M9.99996 14.1667H9.58329V16.25C9.58329 16.5815 9.4516 16.8995 9.21718 17.1339C8.98276 17.3683 8.66481 17.5 8.33329 17.5M9.99996 14.1667V17.5M8.33329 17.5H6.66663M13.3333 2.5H6.66663C4.30996 2.5 3.13079 2.5 2.39913 3.2325C1.66663 3.96417 1.66663 5.14333 1.66663 7.5V9.16667C1.66663 11.5233 1.66663 12.7025 2.39913 13.4342C3.13079 14.1667 4.30996 14.1667 6.66663 14.1667H13.3333C15.69 14.1667 16.8691 14.1667 17.6008 13.4342C18.3333 12.7025 18.3333 11.5233 18.3333 9.16667V7.5C18.3333 5.14333 18.3333 3.96417 17.6008 3.2325C16.8691 2.5 15.69 2.5 13.3333 2.5Z" />
    </svg>
  );
}

/* hugeicons:telegram (20) */
function TelegramIcon({size = 20}: {size?: number}) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.98749 12.84L12.6892 15.9117C13.6892 17.0492 14.19 17.6183 14.7142 17.4792C15.2375 17.3408 15.4175 16.5925 15.7767 15.095L17.7683 6.78833C18.3225 4.48166 18.5992 3.32916 17.9842 2.75999C17.3692 2.19083 16.3033 2.61416 14.1717 3.45999L4.28332 7.38749C2.57832 8.06499 1.72582 8.40333 1.67165 8.98499C1.66528 9.04427 1.66528 9.10405 1.67165 9.16333C1.72415 9.74583 2.57499 10.0867 4.27832 10.7692C5.04915 11.0783 5.43499 11.2333 5.71165 11.5292C5.74277 11.5625 5.77277 11.5969 5.80165 11.6325C6.05665 11.9492 6.16499 12.3658 6.38249 13.1958L6.78999 14.7517C7.00082 15.56 7.10665 15.965 7.38415 16.02C7.66165 16.075 7.90249 15.74 8.38499 15.0692L9.98749 12.84ZM9.98749 12.84L9.72332 12.565C9.42165 12.25 9.27082 12.0933 9.27082 11.8983C9.27082 11.7033 9.42082 11.5458 9.72332 11.2317L12.7008 8.12833" />
    </svg>
  );
}

/* hugeicons:clock-01 (20) */
function ClockIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M9.99996 18.3333C14.6023 18.3333 18.3333 14.6024 18.3333 9.99999C18.3333 5.39762 14.6023 1.66666 9.99996 1.66666C5.39759 1.66666 1.66663 5.39762 1.66663 9.99999C1.66663 14.6024 5.39759 18.3333 9.99996 18.3333Z" />
      <path d="M10 6.66666V9.99999L11.6667 11.6667" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* iOS-style share glyph (arrow out of tray) */
function ShareIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 12.5V2.5M10 2.5L6.875 5.625M10 2.5L13.125 5.625" />
      <path d="M5.83333 8.33334H5C4.07953 8.33334 3.33333 9.07953 3.33333 10V15.8333C3.33333 16.7538 4.07953 17.5 5 17.5H15C15.9205 17.5 16.6667 16.7538 16.6667 15.8333V10C16.6667 9.07953 15.9205 8.33334 15 8.33334H14.1667" />
    </svg>
  );
}

function BackArrow() {
  return (
    <span className={styles.backArrow}>
      <ArrowRight />
    </span>
  );
}

/* ---------- screen 1 — "Almost there." ---------- */
const INTRO_CARDS = [
  {icon: <ComputerIcon />, text: 'For now, Antseed can only run on a server or local computer.'},
  {icon: <TelegramIcon />, text: "To use it from your mobile, you'll go through Telegram instead."},
  {icon: <ClockIcon />, text: "1 minute now. 30 seconds later on a laptop. Then you're on the network."},
];

function IntroScreen({onContinue}: {onContinue: () => void}) {
  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <Link to="/" className={styles.backLink}>
          <BackArrow />
          Back to site
        </Link>
      </header>
      <Reveal className={styles.introHero}>
        <img className={styles.introAnt} src="/img/get-started/ant-network.svg" alt="" aria-hidden="true" />
        <h1 className={styles.title}>
          Almost there.
          <br />
          Let&apos;s get you on the network.
        </h1>
      </Reveal>
      <div className={styles.introBody}>
        <div className={styles.cardList}>
          {INTRO_CARDS.map((card, i) => (
            <Reveal key={i} delay={60 + i * 60}>
              <div className={styles.infoCard}>
                <span className={styles.iconCircle}>{card.icon}</span>
                <p>{card.text}</p>
              </div>
            </Reveal>
          ))}
        </div>
        <Reveal delay={280}>
          <button type="button" className={styles.continueBtn} onClick={onContinue}>
            Continue
            <ArrowRight />
          </button>
        </Reveal>
      </div>
    </div>
  );
}

/* ---------- screen 2 — "Do this before you leave" ---------- */
function InstructionsScreen({onBack}: {onBack: () => void}) {
  const [copied, setCopied] = useState(false);

  const share = async () => {
    const url = `${window.location.origin}/get-started`;
    try {
      if (navigator.share) {
        await navigator.share({title: 'Get started with Antseed', url});
      } else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    } catch {
      /* user dismissed the share sheet */
    }
  };

  return (
    <div className={`${styles.screen} ${styles.screenTinted}`}>
      <header className={styles.header}>
        <button type="button" className={styles.backLink} onClick={onBack}>
          <BackArrow />
          Back
        </button>
        <button type="button" className={styles.shareBtn} onClick={share} aria-label="Share this page">
          {copied ? <span className={styles.copiedNote}>Copied</span> : <ShareIcon />}
        </button>
      </header>
      <Reveal>
        <h1 className={styles.title}>Do this before you leave</h1>
      </Reveal>
      <div className={styles.stepList}>
        <Reveal delay={60} className={styles.stepCard}>
          <img
            className={styles.stepImage}
            src="/img/get-started/step-botfather.png"
            alt="Telegram chat with @BotFather showing the /newbot command"
          />
          <div className={styles.stepRow}>
            <span className={styles.stepNumber}>1</span>
            <p>In Telegram, message @BotFather, send /newbot, and pick any name.</p>
          </div>
          <a
            href="https://t.me/BotFather"
            target="_blank"
            rel="noopener noreferrer"
            className={styles.telegramBtn}>
            <TelegramIcon size={16} />
            Open Telegram
          </a>
        </Reveal>
        <Reveal delay={120} className={styles.stepCard}>
          <img
            className={styles.stepImage}
            src="/img/get-started/step-token.png"
            alt="BotFather's reply with the bot token"
          />
          <div className={styles.stepRow}>
            <span className={styles.stepNumber}>2</span>
            <p>You&apos;ll get a token back, keep it, you&apos;ll paste it into the AI VPN after installing.</p>
          </div>
        </Reveal>
        <Reveal delay={180} className={styles.stepCard}>
          <img
            className={`${styles.stepImage} ${styles.stepImageFlush}`}
            src="/img/get-started/step-vpr.png"
            alt="Antseed AI VPN's Telegram Bot settings with the token field"
          />
          <div className={styles.stepRow}>
            <span className={styles.stepNumber}>3</span>
            <p>When you get to your computer, install the AI VPN and paste the token into it.</p>
          </div>
        </Reveal>
      </div>
    </div>
  );
}

/* ---------- page ---------- */
export default function GetStartedPage() {
  const [step, setStep] = useState<1 | 2>(1);
  // Whether we pushed the #instructions entry ourselves (vs. landing on it),
  // so "Back" can pop history instead of stacking a new entry.
  const pushedRef = useRef(false);

  useEffect(() => {
    const sync = () => setStep(window.location.hash === INSTRUCTIONS_HASH ? 2 : 1);
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [step]);

  const goInstructions = () => {
    pushedRef.current = true;
    window.location.hash = INSTRUCTIONS_HASH;
  };
  const goIntro = () => {
    if (pushedRef.current) {
      pushedRef.current = false;
      window.history.back();
    } else {
      window.location.hash = '';
    }
  };

  return (
    <main className={styles.page} data-step={step}>
      <Head>
        <title>Get Started — Antseed</title>
        <meta
          name="description"
          content="Get on the Antseed network from your phone: create a Telegram bot now, paste the token into the AI VPN on your computer later."
        />
      </Head>
      {step === 1 ? <IntroScreen onContinue={goInstructions} /> : <InstructionsScreen onBack={goIntro} />}
    </main>
  );
}
