import { useEffect, useState } from 'react';
import { VprMark } from './VprLogo';
import { BrandIcon, type BrandKey } from './brand/BrandIcon';
import { SetupAppPreview } from './SetupAppPreview';
import { canonicalModelKey } from '../../modules/catalog/model-identity';
import { shallowEqual, useUiSelector } from '../hooks/useUiSelector';
import styles from './SetupScreen.module.scss';

/** The long tail of first-run setup — catalog build plus the trust-gate wait
 *  — told a piece at a time: rotated every few seconds so it reads as work in
 *  progress, not a stall. The work messages lead, then live discovery facts
 *  and network truths carry the tail. The sequence holds on its last line
 *  instead of looping — repeats would give the stall away. */
function longTailMessages(counts: {
  dhtNodeCount: number;
  peerCount: number;
  metadataPeerCount: number;
  modelCount: number;
  freeModelCount: number;
}): string[] {
  return [
    'Building your model catalog…',
    'Checking free sellers’ on-chain reputation…',
    'Reading seller track records from the blockchain…',
    'Ranking free sellers by settled volume and stake…',
    'Picking the best free model for your first chat…',
    `Found ${counts.modelCount} models across ${counts.peerCount} sellers so far…`,
    `${counts.freeModelCount} of them are served completely free…`,
    `Connected to ${counts.dhtNodeCount} network nodes…`,
    `Fetched service catalogs from ${counts.metadataPeerCount} sellers…`,
    'Reputation is built from settled payment volume…',
    'Free means free - cached tokens included…',
    'Auto-routing picks the most proven seller…',
    'You can star models to build your own lineup…',
    'Almost there - finalizing your model catalog…',
  ];
}
/** How long each long-tail message shows before the next takes over. */
const LONG_TAIL_ROTATE_MS = 3_000;

/** Marquee logos: recognizable labs whose model families are served on the
 *  network. Hard-coded — this plays before discovery has found anything. */
const MARQUEE_BRANDS: BrandKey[] = [
  'openai', 'anthropic', 'deepseek', 'qwen', 'gemini', 'mistral', 'llama', 'grok',
];

/** One compact live tally for the bottom strip. */
function StatItem({ value, label }: { value: number; label: string }) {
  return (
    <span className={`${styles.statItem}${value > 0 ? ` ${styles.statItemLive}` : ''}`}>
      <span className={styles.statValue} key={value}>{value > 0 ? value.toLocaleString('en-US') : '–'}</span> {label}
    </span>
  );
}

export function SetupScreen() {
  const snap = useUiSelector((state) => {
    // Live discovery tallies from the dashboard poll — these move while the
    // service catalog is still loading, so the wait shows real progress. A
    // peer's services come from its fetched pricing matrix, so a non-empty
    // list means its metadata actually resolved, and freeServices are offers
    // it really serves for $0 — not headline prices that default to zero
    // when unknown. Both tallies count unified models: serviceId variants of
    // the same model collapse via canonical identity, matching how the
    // Models catalog counts them.
    const models = new Set<string>();
    const freeModels = new Set<string>();
    let metadataPeerCount = 0;
    for (const peer of state.lastPeers) {
      if (peer.services.length > 0) metadataPeerCount += 1;
      for (const service of peer.services) {
        const id = service.trim();
        if (id) models.add(canonicalModelKey(id) || id.toLowerCase());
      }
      for (const service of peer.freeServices) {
        const id = service.trim();
        if (id) freeModels.add(canonicalModelKey(id) || id.toLowerCase());
      }
    }
    return {
      // Catalog reference for the preview's Models scene (rows derived below).
      appSetupComplete: state.appSetupComplete,
      appSetupStep: state.appSetupStep,
      chatServiceCount: state.chatServiceOptions.length,
      networkAlert: state.networkAlert,
      dhtNodeCount: state.dhtNodeCount,
      peerCount: state.lastPeers.length,
      metadataPeerCount,
      modelCount: models.size,
      freeModelCount: freeModels.size,
      routeModelLabel: state.vprRouteSelection.model?.label ?? null,
      defaultProvisional: state.vprDefaultModelProvisional,
    };
  }, shallowEqual);

  const hasServices = snap.chatServiceCount > 0;
  // The whole point of first-run setup: a model the user can chat with for
  // free, confirmed by routing (a trusted free seller backs the default —
  // the provisional flag has cleared). Only then does the screen call it done.
  const freeReady = hasServices && snap.routeModelLabel !== null && !snap.defaultProvisional;

  // The long tail of first-run setup: discovery counts are all real, but the
  // catalog is still loading and/or no free route has cleared the on-chain
  // reputation threshold yet. A single sentence parked there reads as
  // stalled, so past the first few seconds the line rotates through what
  // that wait actually consists of.
  const longTailPhase = snap.appSetupComplete
    && snap.dhtNodeCount > 0
    && snap.peerCount > 0
    && snap.metadataPeerCount > 0
    && snap.freeModelCount > 0
    && !freeReady;
  const [longTailTick, setLongTailTick] = useState(0);
  useEffect(() => {
    if (!longTailPhase) {
      setLongTailTick(0);
      return;
    }
    const timer = setInterval(() => setLongTailTick((tick) => tick + 1), LONG_TAIL_ROTATE_MS);
    return () => clearInterval(timer);
  }, [longTailPhase]);

  // One sentence describing what the buyer node is doing right now, derived
  // from how far discovery has actually come — each phase hands off to the
  // next as its number becomes real.
  let activity: string;
  if (!snap.appSetupComplete) {
    activity = snap.appSetupStep || 'Installing the router plugin…';
  } else if (snap.dhtNodeCount === 0) {
    activity = 'Connecting to the peer-to-peer network…';
  } else if (snap.peerCount === 0) {
    activity = 'Searching the network for AI sellers…';
  } else if (snap.metadataPeerCount === 0) {
    activity = 'Fetching seller catalogs…';
  } else if (snap.freeModelCount === 0) {
    activity = 'Looking for models served for free…';
  } else {
    const messages = longTailMessages(snap);
    activity = messages[Math.min(longTailTick, messages.length - 1)];
  }

  return (
    <>
      {/* Frameless window: keep the top strip draggable but visually empty —
          the setup screen carries its branding in the body. */}
      <div className={styles.dragStrip} />
      <div className={styles.container}>
        <div className={styles.content}>
          <div className={styles.brand}>
            <VprMark size={64} color="var(--accent-green)" />
          </div>
          <SetupAppPreview />

          {/* Logo marquee: the families of models on the network, drifting by
              while discovery runs — the wait has something alive to look at. */}
          <div className={styles.marquee} aria-hidden="true">
            <div className={styles.marqueeTrack}>
              {[...MARQUEE_BRANDS, ...MARQUEE_BRANDS].map((brand, index) => (
                <span key={`${brand}-${index}`} className={styles.marqueeLogo}>
                  <BrandIcon name={brand} brand={brand} size={22} />
                </span>
              ))}
            </div>
          </div>

          {/* The app itself as the loader: a miniature AI VPN window cycling
              Home → Models → Chat, filling in with real discovered models. */}

          {/* networkAlert carries a startup grace period, so this only appears
              once the network — not slow bootstrap — is the problem. */}
          {!hasServices && snap.networkAlert !== 'none' && (
            <p className={styles.networkHint} role="alert">
              {snap.networkAlert === 'no-internet'
                ? 'No internet connection detected. Connect to the internet to finish setup.'
                : 'Having trouble reaching the peer-to-peer network. A firewall or VPN on this network may be blocking it - try disconnecting the VPN or switching networks.'}
            </p>
          )}
        </div>

        <div className={styles.footer}>
          {freeReady ? (
            <div className={styles.ready}>
              <span className={styles.readyDot} />
              {snap.routeModelLabel
                ? `Free model ready - ${snap.routeModelLabel}`
                : 'Free model ready'}
            </div>
          ) : (
            // key swaps replay the entrance animation, so phase changes read
            // as progress instead of a silent repaint.
            <div className={styles.activity} key={activity} role="status">
              <div className={styles.thinkingDots}>
                <span />
                <span />
                <span />
              </div>
              <span>{activity}</span>
            </div>
          )}
          {/* The raw discovery tallies, small — proof of progress, not the pitch. */}
          <p className={styles.statStrip}>
            <StatItem value={snap.dhtNodeCount} label="nodes" />
            <span className={styles.statSep} aria-hidden="true">·</span>
            <StatItem value={snap.peerCount} label="sellers" />
            <span className={styles.statSep} aria-hidden="true">·</span>
            <StatItem value={snap.modelCount} label="models" />
            <span className={styles.statSep} aria-hidden="true">·</span>
            <StatItem value={snap.freeModelCount} label="free" />
          </p>
          <p className={styles.firstRunNote}>
            Setting up — only on first run, takes 2 minutes max.
          </p>
        </div>
      </div>
    </>
  );
}
