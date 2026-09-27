import {useEffect, useRef, useState, type JSX} from 'react';
import Layout from '@theme/Layout';
import styles from './ants-token.module.css';
import {Button, FinalCta, Reveal, Section, SectionHeader, StatTile} from '../components/ui';
import {TokenHeroArt} from '../components/TokenHeroArt';
import {useAntsSupply} from '../lib/useAntsSupply';
import {ANTS_BASESCAN_URL, INITIAL_EMISSION, MAX_SUPPLY, useEpochCountdown} from '../lib/useEpochCountdown';

const STATS_URL = 'https://antseedstats.com/network';

const fmtM = (n: number) => `${(n / 1e6).toLocaleString('en-US', {maximumFractionDigits: 1})}M`;

/* ── SUPPLY BAR ────────────────────────────────────────────────── */
function SupplyBar({totalSupply}: {totalSupply: number}) {
  const ratio = (totalSupply / MAX_SUPPLY) * 100;
  return (
    <div className={styles.supplyBar}>
      <div className={styles.supplyBarTrack}>
        <div className={styles.supplyBarFill} style={{width: `${Math.max(ratio, 0.3)}%`}} />
      </div>
      <div className={styles.supplyBarLabels}>
        <span>{totalSupply === 0 ? '0' : fmtM(totalSupply)} current supply</span>
        <span>{(MAX_SUPPLY / 1e6).toFixed(0)}M max</span>
      </div>
    </div>
  );
}

/* ── in-view trigger for the section visuals ───────────────────── */
function useInView(threshold = 0.35) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          observer.disconnect();
          setInView(true);
        }
      },
      {threshold}
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [threshold]);

  return {ref, inView};
}

/* ── PROVIDER POOLS — how recognition is weighted ──────────────── */
function PoolWeightCard() {
  return (
    <div className={styles.poolCard}>
      <img className={styles.poolAnt} src="/img/home/antdots-b.png" alt="" aria-hidden="true" />
      <div className={styles.poolHead}>
        <span>Recognized usage</span>
        <span className={styles.poolTag}>Stake-weighted</span>
      </div>
      <div className={styles.poolEq}>
        <div className={styles.poolTerm}>
          <strong>Settled volume</strong>
          <em>buyer-authorized payments through channels</em>
        </div>
        <span className={styles.poolOp} aria-hidden="true">×</span>
        <div className={styles.poolTerm}>
          <strong>Stake weight</strong>
          <em>ANTS locked behind the provider&apos;s identity</em>
        </div>
        <span className={styles.poolOp} aria-hidden="true">=</span>
        <div className={`${styles.poolTerm} ${styles.poolTermResult}`}>
          <strong>Recognized usage</strong>
          <em>what reputation and rewards follow</em>
        </div>
      </div>
    </div>
  );
}

/* ── VERIFICATIONS — ResponseAuth receipt visual ───────────────── */
const RECEIPT_CHECKS = [
  {label: 'signature', value: 'provider key'},
  {label: 'request hash', value: 'committed'},
  {label: 'response hash', value: 'committed'},
  {label: 'fingerprint', value: 'matches label'},
];

function VerifyReceipt() {
  const {ref, inView} = useInView();
  return (
    <div className={`${styles.receipt} ${inView ? styles.receiptIn : ''}`} ref={ref}>
      <div className={styles.receiptBar}>
        <span className={styles.receiptDots}>
          <i style={{background: '#EF4444'}} />
          <i style={{background: '#F59E0B'}} />
          <i style={{background: '#676663'}} />
        </span>
        <span className={styles.receiptTitle}>ResponseAuth</span>
        <span className={styles.receiptTagline}>EVIDENCE · PER RESPONSE</span>
      </div>
      <div className={styles.receiptMeta}>
        <span>provider</span>
        <span>0x3fA4…9c2b</span>
      </div>
      <div className={styles.receiptMeta}>
        <span>response</span>
        <span>#48219 · deepseek-v3</span>
      </div>
      {RECEIPT_CHECKS.map((row, i) => (
        <div key={row.label} className={styles.receiptCheck} style={{transitionDelay: `${250 + i * 180}ms`}}>
          <span className={styles.receiptLabel}>{row.label}</span>
          <span className={styles.receiptValue}>{row.value}</span>
          <span className={styles.receiptOk} aria-hidden="true">✓</span>
        </div>
      ))}
      <div className={styles.receiptResult} style={{transitionDelay: '1000ms'}}>
        <span>recognized usage</span>
        <span className={styles.receiptResultValue}>weighted by verification</span>
      </div>
    </div>
  );
}

/* ── MAIN PAGE ─────────────────────────────────────────────────── */
export default function AntsToken(): JSX.Element {
  const {epoch, timeLeft, started} = useEpochCountdown();
  const live = useAntsSupply();

  // Real supply from the token contract on Base; the emission schedule until it loads.
  const totalSupply = live ? live.total : epoch * INITIAL_EMISSION;
  const supplyReady = started || live !== null;

  return (
    <Layout
      title="ANTS Token"
      description="ANTS is the native token of the Antseed network and its trust and reputation layer."
    >
      {/* ── HERO: copy left, live supply panel right ── */}
      <header className={styles.hero}>
        <div className={styles.heroInner}>
          <div className={styles.heroCopy}>
            <a href={ANTS_BASESCAN_URL} target="_blank" rel="noopener noreferrer" className={styles.heroKicker}>
              $ANTS
            </a>
            <h1 className={styles.heroTitle}>
              The native token of<br />
              <em>the Antseed network.</em>
            </h1>
            <span className={styles.statusPill}>
              <span className={styles.statusDot} aria-hidden="true" />
              Tokens restricted
            </span>
            <p className={styles.heroSub}>
              ANTS is the native token of Antseed and the trust and reputation layer of the network:
              real, payment-backed usage and locked ANTS behind provider identities turn open
              participation into reputation buyers can verify.
            </p>
            <div className={styles.heroCtas}>
              <Button to="/docs/lightpaper" arrow>Read the lightpaper</Button>
              <Button to="/network" variant="ghost">How the network works</Button>
            </div>
          </div>
          <div className={styles.heroDemo}>
            <TokenHeroArt />
          </div>
        </div>
      </header>

      {/* ── TOKEN OVERVIEW ── */}
      <Section tone="tinted">
        <Reveal>
          <SectionHeader
            title="Token supply"
            lead="1.04 billion hard cap. No minting beyond emissions. No admin mint function."
          />
        </Reveal>
        <Reveal>
          <SupplyBar totalSupply={totalSupply} />
        </Reveal>
        <Reveal className={styles.statsGrid} delay={80}>
          <StatTile value={supplyReady ? fmtM(totalSupply) : '–'} label="Current supply" />
          <StatTile value={supplyReady ? `${Math.round((totalSupply / MAX_SUPPLY) * 10000) / 100}%` : '–'} label="Available" />
          <StatTile value={started ? `Epoch ${epoch}` : '–'} label="Current epoch" />
          <StatTile value={timeLeft} label="Until next epoch" />
        </Reveal>
      </Section>

      {/* ── PROVIDER POOLS ── */}
      <Section>
        <div className={styles.poolGrid}>
          <Reveal className={styles.splitCopy}>
            <p className={styles.splitKicker}>Provider pools</p>
            <h2 className={styles.splitTitle}>
              Not all volume<br />
              <em>counts the same.</em>
            </h2>
            <p className={styles.splitLead}>
              Provider pools are the reputation layer of the network. Settled, buyer-authorized
              volume becomes recognized usage - and how much of it is recognized depends on the
              ANTS locked behind the provider&apos;s identity.
            </p>
            <ul className={styles.splitPoints}>
              <li>
                <span className={styles.splitMark} aria-hidden="true" />
                <span><strong>Payment-backed.</strong> Only settled, buyer-authorized volume counts, never self-reported claims.</span>
              </li>
              <li>
                <span className={styles.splitMark} aria-hidden="true" />
                <span><strong>Stake-weighted.</strong> Locked ANTS is durable backing that routers and buyers can inspect.</span>
              </li>
              <li>
                <span className={styles.splitMark} aria-hidden="true" />
                <span><strong>Capped rewards.</strong> Emissions follow recognized usage inside capped ranges; unused budget can be burned.</span>
              </li>
            </ul>
            <div className={styles.splitCta}>
              <Button to="/blog/seller-pools-reputation-tokenomics" variant="ghost" arrow>
                How provider pools work
              </Button>
            </div>
          </Reveal>
          <Reveal delay={140}>
            <PoolWeightCard />
          </Reveal>
        </div>
      </Section>

      {/* ── VERIFICATIONS ── */}
      <Section tone="ink" className={styles.verifySection}>
        <div className={styles.verifyGrid}>
          <Reveal className={`${styles.splitCopy} ${styles.verifyCopy}`}>
            <p className={`${styles.splitKicker} ${styles.verifyKicker}`}>Verifications</p>
            <h2 className={`${styles.splitTitle} ${styles.verifyTitle}`}>
              Evidence,<br />not labels.
            </h2>
            <p className={`${styles.splitLead} ${styles.verifyLead}`}>
              A model name on an endpoint proves nothing. On Antseed, evidence travels with every
              response - and verification decides how much a provider&apos;s usage is worth.
            </p>
            <ul className={`${styles.splitPoints} ${styles.verifyPoints}`}>
              <li>
                <span className={styles.verifyMark} aria-hidden="true">✓</span>
                <span><strong>Signed responses</strong> prove who served which bytes - no trust in a brand required.</span>
              </li>
              <li>
                <span className={styles.verifyMark} aria-hidden="true">✓</span>
                <span><strong>Model fingerprints</strong>, shared in a public torrent-style swarm, check the model behind an endpoint against its label.</span>
              </li>
              <li>
                <span className={styles.verifyMark} aria-hidden="true">✓</span>
                <span><strong>Verification feeds policy:</strong> how much of a provider&apos;s settled volume is recognized can depend on how it verifies.</span>
              </li>
            </ul>
            <div className={styles.splitCta}>
              <Button to="/blog/model-verification-fingerprint-swarm" variant="light" arrow>
                How verification works
              </Button>
            </div>
          </Reveal>
          <Reveal className={styles.verifyCardCol} delay={140}>
            <VerifyReceipt />
          </Reveal>
        </div>
      </Section>

      {/* ── CLOSING CTA ── */}
      <FinalCta
        title="Help build the network"
        sub="Use the network for real AI work, run a provider, and help improve the open-source protocol."
        note={
          <>
            <a href="/docs/lightpaper">Read the lightpaper</a>
            <a href="/docs/payments">Read the payment protocol</a>
            <a href={STATS_URL} target="_blank" rel="noopener noreferrer">Live prices</a>
          </>
        }>
        <Button to="/providers" variant="white" size="lg" arrow>Become a provider</Button>
      </FinalCta>
    </Layout>
  );
}
