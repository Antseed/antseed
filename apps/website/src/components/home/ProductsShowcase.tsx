import {Button, Reveal, SectionHeader} from '../ui';
import {DropTrail} from '../DropTrail';
import {LazyMount} from '../LazyMount';
import {HeroDemo} from '../HeroDemo';
import {DownloadCta} from '../HomeHero';
import {GatewayConsoleDemo} from './GatewayConsoleDemo';
import home from '../../pages/index.module.css';
import styles from './ProductsShowcase.module.css';

/**
 * PRODUCTS — the two ways to use Antseed, one after the other: the gateway
 * (the one we lead with) on an ink card with the live console demo, then
 * the AI VPN desktop app with the homepage's AI VPN demo.
 *
 * Both demos are decorative and script-heavy, so they mount only as they
 * near the viewport (LazyMount); until then a box of the same aspect ratio
 * holds their space. The copy, bullets and CTAs are plain HTML.
 */

function Check() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" className={styles.check}>
      <circle cx="8" cy="8" r="8" />
      <path d="M5 8.2l2 2 4-4.2" fill="none" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const GATEWAY_POINTS = [
  'Access to 700+ models at lower prices',
  'Choose providers, budgets and manage access',
  'Track balances and usage from one console',
];

const VPN_POINTS = [
  'Connect your coding tools and personal agents',
  'Choose models and track your usage',
  'Get started without deploying a server',
];

export function ProductsShowcase() {
  return (
    <section className={styles.section}>
      <DropTrail />
      <div className={styles.inner}>
        <Reveal>
          <SectionHeader
            title="Run AI on your terms"
            lead="Use the gateway to manage shared access, or the AI VPN to connect the tools on your computer."
          />
        </Reveal>

        <Reveal className={`${styles.card} ${styles.gatewayCard}`}>
          <div className={styles.copy}>
            <p className={styles.kicker}>Console for your agents, apps, and team</p>
            <h3 className={styles.cardTitle}>Antseed Gateway</h3>
            <p className={`${styles.cardLead} ${styles.gatewayLead}`}>
              Deploy your own endpoint and give each agent, app, or teammate their own API key.
            </p>
            <ul className={styles.points}>
              {GATEWAY_POINTS.map((p) => (
                <li key={p}><Check />{p}</li>
              ))}
            </ul>
            <div className={`${styles.ctaRow} ${styles.gatewayCta}`}>
              <Button to="/docs/gateway" size="lg" arrow className={styles.greenBtn}>Set up AI gateway</Button>
              <span className={`${home.ctaCaption} ${home.ctaCheck}`}>
                <i aria-hidden="true" />No signup required
              </span>
            </div>
          </div>
          <div className={styles.visual}>
            <div className={styles.browser}>
              <div className={styles.browserBar} aria-hidden="true">
                <span className={styles.browserDots}><i /><i /><i /></span>
                <span className={styles.browserUrl}>llm.example.com/console</span>
              </div>
              <LazyMount className={styles.consoleSlot}>
                <GatewayConsoleDemo />
              </LazyMount>
            </div>
          </div>
        </Reveal>

        <Reveal className={`${styles.card} ${styles.vpnCard}`}>
          <div className={styles.vpnVisual}>
            <LazyMount className={styles.vpnSlot}>
              <HeroDemo compact />
            </LazyMount>
          </div>
          <div className={styles.copy}>
            <p className={styles.kicker}>Desktop app to work locally</p>
            <h3 className={styles.cardTitle}>Antseed AI VPN</h3>
            <p className={styles.cardLead}>
              Access the same market through a desktop app that connects to the tools you already use.
            </p>
            <ul className={styles.points}>
              {VPN_POINTS.map((p) => (
                <li key={p}><Check />{p}</li>
              ))}
            </ul>
            <div className={styles.ctaRow}>
              <DownloadCta caption="No signup required" />
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
