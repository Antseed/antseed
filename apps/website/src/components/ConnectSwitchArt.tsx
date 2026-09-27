import {useEffect, useState} from 'react';
import {OpenAI} from '@lobehub/icons';
import styles from './ConnectSwitchArt.module.css';

/**
 * "Connect your favorite coding app" animation. Left: the AI VPN's
 * Connected apps list, where the Codex toggle flips on. Right: the Codex
 * window, whose provider footer switches from OpenAI to Antseed as the
 * AI VPN connects it (apps/desktop connected-apps, kind: config-patch). Loops.
 */

type Phase = 'native' | 'patching' | 'connected';

const TIMINGS: Record<Phase, number> = {native: 2200, patching: 1400, connected: 3800};
const NEXT: Record<Phase, Phase> = {native: 'patching', patching: 'connected', connected: 'native'};

export function ConnectSwitchArt({layout = 'row'}: {layout?: 'row' | 'stack'}) {
  const [phase, setPhase] = useState<Phase>('native');
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mq.matches) {
      setReduced(true);
      setPhase('connected');
      return undefined;
    }
    const t = window.setTimeout(() => setPhase((p) => NEXT[p]), TIMINGS[phase]);
    return () => window.clearTimeout(t);
  }, [phase]);

  const on = phase !== 'native';
  const connected = phase === 'connected';

  return (
    <div className={`${styles.wrap} ${layout === 'stack' ? styles.stack : ''} ${reduced ? styles.reduced : ''} ${on ? styles.on : ''} ${connected ? styles.connected : ''}`} role="img" aria-label="Turning on Codex in the AI VPN switches its model provider to Antseed">
      {/* AI VPN — Connected apps */}
      <div className={styles.vpn}>
        <div className={styles.vpnHead}>
          <img src="/logo.svg" alt="" />
          <span>Connected apps</span>
        </div>
        <ul className={styles.list}>
          <li className={`${styles.item} ${styles.itemActive}`}>
            <span className={styles.appIcon}><OpenAI size={16} /></span>
            <span className={styles.appName}>Codex</span>
            <span className={styles.appStatus}><i />Connected</span>
            <span className={styles.toggle}><i /></span>
          </li>
          <li className={styles.item}>
            <span className={`${styles.appIcon} ${styles.appIconSquare}`}><i /></span>
            <span className={styles.appName}>OpenCode</span>
            <span className={styles.connectBtn}>Connect</span>
          </li>
          <li className={styles.item}>
            <span className={`${styles.appIcon} ${styles.appIconClaude}`}>✳</span>
            <span className={styles.appName}>Claude</span>
            <span className={`${styles.toggle} ${styles.toggleOff}`}><i /></span>
          </li>
        </ul>
      </div>

      <div className={styles.link} aria-hidden="true">
        <i /><i /><i /><i /><i />
      </div>

      {/* Codex */}
      <div className={styles.app}>
        <div className={styles.appBar}>
          <span className={styles.dots}><i /><i /><i /></span>
          <span className={styles.appTitle}>Codex</span>
        </div>
        <div className={styles.chat}>
          <div className={styles.user}>Add a retry with backoff to the fetch helper.</div>
          <div className={styles.reply}>
            <span className={styles.replyLine} style={{width: '92%'}} />
            <span className={styles.replyLine} style={{width: '74%'}} />
            <span className={styles.replyLine} style={{width: '58%'}} />
          </div>
        </div>
        <div className={styles.appFoot}>
          <span className={styles.provider}>
            <span className={styles.providerNative}><OpenAI size={14} /> OpenAI · gpt-5</span>
            <span className={styles.providerAntseed}><img src="/logo.svg" alt="" /> Antseed · Claude Fable 5.1</span>
          </span>
          <span className={styles.route}>via localhost:8377</span>
        </div>
      </div>
    </div>
  );
}
