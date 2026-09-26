import {useEffect, useRef, useState, type CSSProperties, type ReactNode} from 'react';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import {ArrowRight, Button, Reveal} from '../components/ui';
import styles from './network.module.css';

/**
 * /network — what the network side of Antseed is and why it matters to a
 * buyer or a provider. Six short sections, one visual each. Everything
 * deeper (subnets, ranking tie-breaks, channel mechanics, fee percentages,
 * emission caps) lives in /docs and is linked, not repeated.
 */

const SOURCE = 'https://github.com/AntSeed/antseed/tree/main';

const STAGES = [
  {name: 'Find', label: '01 / FIND', title: 'Your device finds providers itself.', detail: 'It asks Mainline DHT, the same network BitTorrent uses, for provider addresses, then reads each provider’s signed listing: which models, at what price.'},
  {name: 'Choose', label: '02 / CHOOSE', title: 'Your machine picks the route.', detail: 'Price and trust decide, on your device. There is no Antseed server making that call for you.'},
  {name: 'Connect', label: '03 / CONNECT', title: 'Direct and encrypted.', detail: 'Your device talks to the provider over an encrypted connection. Antseed never sees the request or the response.'},
  {name: 'Pay', label: '04 / PAY', title: 'Per request, in USDC on Base.', detail: 'You sign a running total after each response. The provider settles it on Base and gets paid in USDC.'},
];

const TRACE_MESSAGES = [
  ['FINDING PROVIDERS', 'Asking the network for provider addresses'],
  ['ROUTE CHOSEN LOCALLY', 'Peer 02 fits your settings and price'],
  ['DIRECT CONNECTION', 'Encrypted · response streaming'],
  ['SETTLED ON BASE', 'Example: 0.047 USDC paid to the provider'],
];

function Eyebrow({children}: {children: ReactNode}) {
  return <p className={styles.eyebrow}>{children}</p>;
}

function Chapter({id, title, intro, children, dark = false}: {
  id: string; title: string; intro: string; children: ReactNode; dark?: boolean;
}) {
  return (
    <section id={id} className={`${styles.chapter} ${dark ? styles.dark : ''}`}>
      <div className={styles.inner}>
        <Reveal className={styles.chapterHeading}>
          <h2>{title}</h2>
          <p className={styles.lead}>{intro}</p>
        </Reveal>
        {children}
      </div>
    </section>
  );
}

function DocLink({to, children}: {to: string; children: ReactNode}) {
  return <Link className={styles.docLink} to={to}>{children}<ArrowRight size={16} /></Link>;
}

const SWARM_NODES = [
  [28, 138], [56, 72], [60, 205], [94, 32], [105, 113], [108, 170],
  [114, 247], [152, 65], [157, 139], [165, 211], [190, 23], [201, 99],
  [211, 174], [211, 269], [247, 51], [261, 125], [269, 223], [298, 82],
  [315, 170], [325, 267], [348, 34], [367, 117], [376, 219], [407, 70],
  [413, 167], [435, 236], [455, 112], [456, 189],
];

const SWARM_EDGES = SWARM_NODES.flatMap(([startX, startY], startIndex) =>
  SWARM_NODES.flatMap(([endX, endY], endIndex) =>
    endIndex > startIndex && Math.hypot(endX - startX, endY - startY) < 100
      ? [{startX, startY, endX, endY, id: `${startIndex}-${endIndex}`}]
      : [],
  ),
);

const LOOKUP_PATHS = [
  'M28 138L105 113L152 65L247 51L348 34L407 70L455 112',
  'M28 138L108 170L157 139L201 99L261 125L315 170L413 167L456 189',
  'M28 138L60 205L114 247L165 211L269 223L325 267L376 219L435 236',
];
const MATCHED_NODES = new Set([23, 26, 27]);
const QUERY_NODES = new Set([0, 4, 7, 8, 11, 14, 15, 18, 24]);

function DiscoverySwarm() {
  return (
    <div className={styles.discoveryCloud} aria-hidden="true">
      <div className={styles.swarmCaption}><span className={styles.swarmDot} /> MAINLINE DHT <span>same as BitTorrent</span></div>
      <svg viewBox="0 0 490 300" preserveAspectRatio="none" className={styles.swarmGraph}>
        <g className={styles.swarmMesh}>
          {SWARM_EDGES.map(({startX, startY, endX, endY, id}) => <line key={id} x1={startX} y1={startY} x2={endX} y2={endY} />)}
        </g>
        {LOOKUP_PATHS.map((path, index) => (
          <g key={path} style={{'--delay': `${index * -.9}s`} as CSSProperties}>
            <path className={styles.swarmRoute} d={path} />
            <path className={styles.swarmPacket} d={path} />
          </g>
        ))}
        {SWARM_NODES.map(([nodeX, nodeY], index) => {
          const matched = MATCHED_NODES.has(index);
          const queried = QUERY_NODES.has(index);
          return (
            <g key={index} className={matched ? styles.swarmMatch : queried ? styles.swarmQuery : styles.swarmPeer} style={{'--delay': `${index * -.27}s`} as CSSProperties}>
              {(matched || queried) && <circle className={styles.swarmHalo} cx={nodeX} cy={nodeY} r={matched ? 14 : 11} />}
              <circle className={styles.swarmNode} cx={nodeX} cy={nodeY} r={matched ? 6 : queried ? 4.5 : 3} />
              {(matched || index % 4 === 0) && <text x={nodeX + 9} y={nodeY - 10}>{((index + 1) * 1973).toString(16).padStart(4, '0')}</text>}
            </g>
          );
        })}
      </svg>
      <div className={styles.swarmLegend}><span><i /> DHT node</span><span><i /> Queried node</span><span><i /> Returns addresses</span></div>
    </div>
  );
}

function RequestTrace({motionPaused}: {motionPaused: boolean}) {
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [visible, setVisible] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(true);
  const traceRef = useRef<HTMLDivElement>(null);
  const running = playing && visible && !motionPaused && !reducedMotion;

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const syncMotion = () => setReducedMotion(preference.matches);
    syncMotion();
    preference.addEventListener('change', syncMotion);
    const element = traceRef.current;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {threshold: 0.25});
    if (element) observer.observe(element);
    return () => {
      preference.removeEventListener('change', syncMotion);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => {
      if (!document.hidden) setActive(current => (current + 1) % STAGES.length);
    }, 4400);
    return () => window.clearInterval(timer);
  }, [running, active]);

  const stage = STAGES[active];
  const selected = active >= 1;
  const direct = active >= 2;
  const clientStatus = ['Finding providers…', 'Route selected locally', 'Receiving response…', 'Request complete'][active];
  return (
    <div ref={traceRef} className={`${styles.trace} ${!running ? styles.traceStill : ''}`}>
      <div className={styles.panelBar}><span><i className={styles.statusDot} /> ONE REQUEST / THROUGH THE NETWORK</span><span>Illustrative · not live traffic</span></div>
      <div className={styles.networkScene} data-stage={active} data-direct={direct} data-selected={selected} role="img" aria-label={`${stage.name}: ${stage.detail}`}>
        <div className={styles.sceneLabels} aria-hidden="true"><span>YOUR DEVICE</span><span>OPEN DISCOVERY</span><span>INDEPENDENT PROVIDERS</span></div>
        <svg viewBox="0 0 1000 500" preserveAspectRatio="none" aria-hidden="true" className={styles.sceneWires}>
          <g className={styles.lookupWires}><path d="M250 218L304 189M670 169L710 90M671 227L710 218M653 262L710 345" /></g>
          <path className={styles.directWire} d="M250 218L710 218" />
          <path className={styles.settleWire} d="M840 250L975 250L975 436L840 436" />
          <path className={styles.requestPacket} d="M250 209L710 209" />
          <path className={styles.responsePacket} d="M710 227L250 227" />
        </svg>
        <svg viewBox="0 0 400 700" preserveAspectRatio="none" aria-hidden="true" className={styles.mobileWires}>
          <g className={styles.lookupWires}><path d="M200 125L44 239M351 226L70 410M351 265L200 410M336 289L330 410" /></g>
          <path className={styles.directWire} d="M200 125L200 410" />
          <path className={styles.settleWire} d="M200 490L200 610" />
          <path className={styles.requestPacket} d="M193 125L193 410" />
          <path className={styles.responsePacket} d="M207 410L207 125" />
        </svg>
        <div className={styles.clientCard} aria-hidden="true">
          <div className={styles.clientHeading}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4M7 9l3 2-3 2M13 13h4" /></svg><strong>Your agent</strong><span>LOCAL</span></div>
          <code>POST /v1/chat/completions</code>
          <div className={styles.clientStatus}><i />{clientStatus}</div>
        </div>
        <DiscoverySwarm />
        {[['01', '0.80', 'Higher price'], ['02', '0.40', 'Selected route'], ['03', '0.65', 'Lower trust']].map(([peer, price, reason], index) => (
          <div key={peer} className={`${styles.offerCard} ${index === 1 ? styles.chosenOffer : ''}`} style={{'--offer': index} as CSSProperties} aria-hidden="true">
            <div><span className={styles.serverGlyph}>▤</span><strong>Peer {peer}</strong><span className={styles.offerBadge}>{selected ? index === 1 ? 'SELECTED' : 'SKIPPED' : 'FOUND'}</span></div>
            <p><span>${price}<small> / 1M input</small></span><span>{selected ? reason : 'Model available'}</span></p>
          </div>
        ))}
        <div key={active} className={styles.sceneMessage} aria-hidden="true"><span>{TRACE_MESSAGES[active][0]}</span><strong>{TRACE_MESSAGES[active][1]}</strong>{active === 2 && <div className={styles.tokenStream}><i /><i /><i /><i /><i /><i /><i /></div>}</div>
        <div className={styles.baseCard} aria-hidden="true"><span className={styles.baseMark} /><strong>Base</strong><span>{active === 3 ? '0.047 USDC · settled ✓' : 'USDC settlement'}</span></div>
        <span className={styles.sceneFootnote}>{direct ? 'Once connected, the request skips the discovery layer entirely.' : 'The network finds addresses. Listings describe services. You choose.'}</span>
      </div>
      <div className={styles.playbackBar}><span>0{active + 1} / 04 <span>{direct ? 'DIRECT PEER SESSION' : 'FIND & CHOOSE'}</span></span><button type="button" disabled={motionPaused || reducedMotion} onClick={() => setPlaying(current => !current)}>{motionPaused || reducedMotion ? 'Manual mode' : playing ? 'Ⅱ Pause walkthrough' : '▶ Play walkthrough'}</button></div>
      <div className={styles.traceControls} role="group" aria-label="Explore the request lifecycle">
        {STAGES.map((item, index) => <button key={item.name} type="button" aria-pressed={active === index} aria-controls="trace-detail" onClick={() => {setActive(index); setPlaying(false);}}><span>0{index + 1}</span>{item.name}{active === index && running && <i key={`${index}-${running}`} className={styles.stageProgress} />}</button>)}
      </div>
      <div id="trace-detail" className={styles.traceDetail} aria-live={running ? 'off' : 'polite'} aria-atomic="true">
        <Eyebrow>{stage.label}</Eyebrow><h3>{stage.title}</h3><p>{stage.detail}</p>
      </div>
    </div>
  );
}

const JOURNEY = [
  ['Find', 'Providers are found over Mainline DHT, the same network BitTorrent uses. It holds only addresses, never model names or prompts.', '/docs/discovery'],
  ['Choose', 'Your device picks the provider by price and trust. There is no Antseed server making that call.', '/docs/router-api'],
  ['Connect', 'The connection is direct and encrypted. Antseed never sees the request.', '/docs/transport'],
  ['Pay', 'You sign a running total per request, and the provider settles it in USDC on Base.', '/docs/payments'],
];

const BOUNDARIES = [
  ['On your machine', 'Routing preferences, local history, and your allow/block rules.'],
  ['Between the peers', 'Requests and responses. The provider you chose can read the request it serves.'],
  ['On Base', 'Deposits, payment authorizations, usage totals, stake, and rewards. Prompts and outputs never go onchain.'],
];

const TRUST = [
  ['History', 'Completed channels and settled USDC volume.'],
  ['Usage', 'Share of recognized usage in the last epoch.'],
  ['Backing', 'ANTS locked behind the provider’s identity.'],
  ['Identity', 'A verified GitHub account or domain.'],
];

const FAILURES = [
  ['A provider disappears.', 'Your device moves on to another eligible provider. The money reserved for that channel returns to your deposit after a short grace period.'],
  ['A provider keeps failing.', 'Your device cools it down and prefers others. No central operator has to step in.'],
  ['Infrastructure goes down.', 'Other bootstrap servers can still get you into the network. Settlement still needs Base, so peer-to-peer does not mean zero dependencies.'],
];

const STACK = [
  ['05', 'Reputation', 'Trust scoring and identity signals', 'reputation', 'reputation'],
  ['04', 'Payments', 'USDC channels and settlement', 'payments', 'payments'],
  ['03', 'Metering', 'Counting usage and signing receipts', 'metering', 'metering'],
  ['02', 'Transport', 'Verified peers and encrypted traffic', 'transport', 'p2p'],
  ['01', 'Discovery', 'Finding peers and signed listings', 'discovery', 'discovery'],
];

export default function NetworkPage() {
  const [motionPaused, setMotionPaused] = useState(false);
  return (
    <Layout title="How the Antseed network works" description="Your device finds providers over Mainline DHT, the same network BitTorrent uses, picks the route itself, talks to the provider directly, and pays per request in USDC on Base. Nobody sits in the middle.">
      <Head><link rel="canonical" href="https://antseed.com/network/" /></Head>
      <main className={`${styles.page} ${motionPaused ? styles.paused : ''}`}>
        <header className={styles.hero}>
          <div className={styles.inner}>
            <div className={styles.heroTop}><Eyebrow>ANTSEED / NETWORK</Eyebrow><button type="button" className={styles.motionToggle} aria-pressed={motionPaused} onClick={() => setMotionPaused(!motionPaused)}>{motionPaused ? 'Resume motion' : 'Pause motion'}</button></div>
            <Reveal><h1>Antseed Network.<br /><span>Not another API gateway.</span></h1><p className={styles.heroLead}>Your device finds providers itself, talks to them directly, and pays per request. Nobody sits in the middle: no account, no server that sees your prompts, no company that can shut you off.</p></Reveal>
            <div className={styles.ctas}><Button href="#how" size="lg" arrow>Follow a request</Button><Button to="/docs/overview" variant="ghost" size="lg">Read the protocol</Button></div>
            <RequestTrace motionPaused={motionPaused} />
            <div className={styles.heroFooter}><span>Discovery is distributed.</span><span>Routing is local.</span><span>Delivery is direct.</span><span>Settlement is onchain.</span></div>
          </div>
        </header>

        <Chapter id="how" title="How a request travels." intro="Four steps, all of them either on your device, between you and the provider, or on Base. None of them on an Antseed server.">
          <div className={styles.fourCards}>
            {JOURNEY.map(([title, text, doc], index) => (
              <Reveal key={title} className={styles.journeyCard} delay={index * 80}>
                <span>0{index + 1}</span>
                <h3>{title}</h3>
                <p>{text}</p>
                <Link to={doc}>Read the spec <ArrowRight size={14} /></Link>
              </Reveal>
            ))}
          </div>
        </Chapter>

        <Chapter id="where" dark title="What lives where." intro="Three places, and nothing else. Once you know which is which, you know what Antseed can and cannot see.">
          <div className={styles.boundaries}>{BOUNDARIES.map(([title, text]) => <div key={title}><h3>{title}</h3><p>{text}</p></div>)}</div>
          <p className={styles.transportNote}>Encryption protects traffic in transit. It does not hide anything from the provider you chose.</p>
          <DocLink to="/docs/security">Where the security boundaries are</DocLink>
        </Chapter>

        <Chapter id="trust" title="Trust you can check." intro="Anyone can join, so a name is not enough. Your device scores every provider from public signals and skips the ones below your bar. Proven wash trading sets the score to zero.">
          <Reveal className={styles.trustGrid}>{TRUST.map(([title, text]) => <div key={title}><h3>{title}</h3><p>{text}</p></div>)}</Reveal>
          <DocLink to="/docs/reputation">How trust is computed</DocLink>
        </Chapter>

        <Chapter id="money" title="USDC pays. ANTS rewards." intro="Two separate systems with two separate jobs.">
          <div className={styles.twoCols}>
            <Reveal className={styles.moneyCol}>
              <h3>USDC pays for the work.</h3>
              <ul>
                <li>You top up by card in the AI VPN, or with USDC from the CLI.</li>
                <li>Before the first request, a budget is reserved. After each response, you sign the running total.</li>
                <li>The provider settles on Base and the unused budget returns to you.</li>
              </ul>
              <DocLink to="/docs/payments">How payments work</DocLink>
            </Reveal>
            <Reveal className={styles.moneyCol} delay={100}>
              <h3>ANTS rewards real usage.</h3>
              <ul>
                <li>Providers lock ANTS behind their service as long-term backing.</li>
                <li>Settled, buyer-authorized usage that passes the eligibility rules earns rewards.</li>
                <li>Rewards are capped and never guaranteed. Losing a reward never reverses a payment.</li>
              </ul>
              <DocLink to="/ants-token">About the ANTS token</DocLink>
            </Reveal>
          </div>
        </Chapter>

        <Chapter id="resilience" title="When things go wrong." intro="Independent providers go offline and fail requests. The network is built for that.">
          <div className={styles.failureList}>{FAILURES.map(([title, text], index) => <Reveal key={title} className={styles.failure}><span>0{index + 1}</span><h3>{title}</h3><p>{text}</p></Reveal>)}</div>
        </Chapter>

        <Chapter id="protocol" dark title="Every layer is open." intro="Discovery, encrypted transport, metering, settlement, and reputation, all open source. Read the spec, inspect the code, and build on the same pieces.">
          <div className={styles.stack}>{STACK.map(([number, title, description, doc, directory]) => <div key={number}><span>{number}</span><h3>{title}</h3><p>{description}</p><Link to={`/docs/${doc}`}>Spec ↗</Link><a href={`${SOURCE}/packages/node/src/${directory}`}>Source ↗</a></div>)}</div>
          <div className={styles.closing}><h3>Run a node. Build a provider.<br />Make the network your own.</h3><div className={styles.ctas}><Button to="/docs/overview" variant="white" size="lg" arrow>Read the protocol</Button><Button to="/providers" variant="light" size="lg">Become a provider</Button></div><p>Open source · Independent peers · USDC settlement on Base</p></div>
        </Chapter>
      </main>
    </Layout>
  );
}
