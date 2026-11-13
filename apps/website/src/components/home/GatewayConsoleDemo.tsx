import {useEffect, useRef, useState} from 'react';
import styles from './GatewayConsoleDemo.module.css';

/**
 * GATEWAY CONSOLE DEMO — the gateway console's create-key flow on a 13 s
 * loop: create a key, name it, set a spend limit, pick a model and a seller,
 * copy the key, and the new row lands in the list.
 *
 * Field names and dialog copy follow apps/gateway-console (Keys.tsx,
 * PolicyEditor.tsx, KeySecretModal.tsx); rows, prices and the key are demo
 * data. The whole timeline is CSS keyframes (GatewayConsoleDemo.module.css),
 * so there is no per-frame JavaScript: the only script scales the 760×500
 * stage to its column and pauses the animation while it is off-screen.
 * Reduced motion shows a still frame mid-flow. Decorative (aria-hidden):
 * the product copy next to it carries the meaning.
 */

const STAGE_W = 760;
const NAME = 'Support agent';
const LIMIT = '50.00';

const KEYS = [
  {name: 'Production backend', key: 'antseed_…prod', limit: '$400.00/month', routing: 'Inherits', spent: '$142.51'},
  {name: 'CI evals', key: 'antseed_…y_ci', limit: 'No limits', routing: 'price caps · lowest price', spent: '$18.20'},
  {name: 'Sam laptop', key: 'antseed_…_sam', limit: '$1.00/day', routing: '2 allowed · price caps', spent: '$3.04', until: 'Until Oct 31'},
];

const MODELS = ['claude-fable-5', 'kimi-k2.7-code', 'qwen3.7-plus', 'minimax-m3'];

const SELLERS = [
  {name: 'Venice.ai Proxy', tee: true, score: '9.9', price: '$0.45/M'},
  {name: 'Apex Ant', score: '9.8', price: '$0.52/M'},
  {name: 'Chutes', score: '9.7', price: '$0.58/M'},
];

/** Typed text: one span per character, each revealed by its own keyframe. */
function Typed({text, prefix}: {text: string; prefix: 'name' | 'limit'}) {
  return (
    <span className={styles.typed}>
      {[...text].map((ch, i) => (
        <span key={i} className={`${styles.a} ${styles[`${prefix}${i}`]}`}>
          {ch === ' ' ? ' ' : ch}
        </span>
      ))}
    </span>
  );
}

export function GatewayConsoleDemo() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return undefined;
    const resize = new ResizeObserver(([entry]) => setScale(entry.contentRect.width / STAGE_W));
    resize.observe(el);
    let visibility: IntersectionObserver | undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setPlaying(true);
    } else {
      visibility = new IntersectionObserver(([entry]) => setPlaying(entry.isIntersecting));
      visibility.observe(el);
    }
    return () => {
      resize.disconnect();
      visibility?.disconnect();
    };
  }, []);

  return (
    <div ref={viewportRef} className={styles.viewport} data-playing={playing || undefined} aria-hidden="true">
      <div className={styles.stage} style={scale ? {transform: `scale(${scale})`} : {visibility: 'hidden'}}>
        <div className={styles.topbar}>
          <img src="/logo-white.svg" alt="" width={64} height={22} />
          <span className={styles.slash}>/</span>
          <span>Default (admin)</span>
          <span className={styles.topDocs}>Docs</span>
          <span className={styles.avatar}>DO</span>
        </div>

        <div className={styles.sidebar}>
          <span className={styles.navLabel}>Workspace</span>
          <span>Overview</span>
          <span>Activity</span>
          <span>Logs</span>
          <span className={styles.navActive}>Keys</span>
          <span>Presets</span>
          <span className={styles.navLabel}>Routing</span>
          <span>Network</span>
          <span>Routing</span>
        </div>

        <div className={styles.main}>
          <div className={styles.mainHead}>
            <div>
              <div className={styles.h1}>API keys</div>
              <div className={styles.muted}>Keys for the Default workspace. Each key spends from this workspace's wallet.</div>
            </div>
            <span className={`${styles.pill} ${styles.a} ${styles.createBtn}`}>+ Create key</span>
          </div>
          <div className={styles.table}>
            <div className={`${styles.row} ${styles.rowHead}`}>
              <span>Name</span><span>Limits</span><span>Routing</span><span>This month</span><span>Status</span>
            </div>
            <div className={`${styles.row} ${styles.a} ${styles.newRow}`}>
              <span><b>Support agent</b><br /><code>antseed_…_sup</code></span>
              <span className={styles.dim}>$50.00/month</span>
              <span className={styles.dim}>1 model · 1 seller</span>
              <span>$0.00</span>
              <span><span className={styles.badge}>Active</span></span>
            </div>
            {KEYS.map((k) => (
              <div key={k.name} className={styles.row}>
                <span><b>{k.name}</b><br /><code>{k.key}</code></span>
                <span className={styles.dim}>{k.limit}</span>
                <span className={styles.dim}>{k.routing}</span>
                <span>{k.spent}</span>
                <span><span className={k.until ? styles.badgeMuted : styles.badge}>{k.until ?? 'Active'}</span></span>
              </div>
            ))}
          </div>
        </div>

        {/* Create API key dialog */}
        <div className={`${styles.layer} ${styles.a} ${styles.createLayer}`}>
          <div className={styles.scrim} />
          <div className={`${styles.dialog} ${styles.createDialog}`}>
            <div className={styles.dialogTitle}>Create API key</div>
            <div className={styles.label}>Name</div>
            <div className={`${styles.field} ${styles.a} ${styles.nameField}`}>
              <span className={`${styles.ph} ${styles.a} ${styles.namePh}`}>e.g. Production backend</span>
              <Typed text={NAME} prefix="name" />
            </div>
            <div className={styles.label}>Spend limits (USD)</div>
            <div className={styles.fieldRow}>
              <div className={`${styles.field} ${styles.a} ${styles.limitField}`}>
                <span className={`${styles.ph} ${styles.a} ${styles.limitPh}`}>No limit</span>
                <Typed text={LIMIT} prefix="limit" />
              </div>
              <div className={`${styles.field} ${styles.period}`}>per month</div>
            </div>
            <div className={styles.groupTitle}>Routing policy</div>
            <div className={styles.labelTight}>Allowed models</div>
            <div className={`${styles.field} ${styles.a} ${styles.modelsField}`}>
              <span className={`${styles.ph} ${styles.a} ${styles.modelsPh}`}>Model id</span>
              <span className={`${styles.chip} ${styles.a} ${styles.modelChip}`}>kimi-k2.7-code ×</span>
            </div>
            <div className={styles.label}>Allowed sellers</div>
            <div className={styles.sellers}>
              {SELLERS.map((s, i) => (
                <div key={s.name} className={`${styles.seller} ${i === 0 ? `${styles.a} ${styles.sellerRow}` : ''}`}>
                  <span className={`${styles.box} ${i === 0 ? `${styles.a} ${styles.sellerBox}` : ''}`}>{i === 0 ? '✓' : ''}</span>
                  <span className={i === 0 ? styles.sellerName : styles.sellerNameDim}>
                    {s.name} {s.tee && <span className={styles.tee}>TEE</span>}
                  </span>
                  <span className={styles.score}>★ {s.score}</span>
                  <span className={i === 0 ? styles.price : styles.priceDim}>{s.price}</span>
                </div>
              ))}
            </div>
            <div className={styles.actions}>
              <span className={styles.ghostPill}>Cancel</span>
              <span className={`${styles.pill} ${styles.a} ${styles.submitBtn}`}>Create key</span>
            </div>
            <div className={`${styles.dropdown} ${styles.a} ${styles.dropdownAnim}`}>
              {MODELS.map((m, i) => (
                <div key={m} className={i < 2 ? `${styles.a} ${styles[`opt${i}`]}` : undefined}>{m}</div>
              ))}
            </div>
          </div>
        </div>

        {/* Key ready dialog */}
        <div className={`${styles.layer} ${styles.a} ${styles.readyLayer}`}>
          <div className={styles.scrim} />
          <div className={`${styles.dialog} ${styles.readyDialog}`}>
            <div className={styles.eyebrow}>API key</div>
            <div className={styles.dialogTitle}>Support agent is ready</div>
            <div className={styles.secret}>
              <code>antseed_sk_7Hq2wZ…f9Lk_sup</code>
              <span className={`${styles.copyBtn} ${styles.a} ${styles.copied}`}>
                <span className={`${styles.a} ${styles.copyLabel}`}>Copy</span>
                <span className={`${styles.a} ${styles.copiedLabel}`}>Copied</span>
              </span>
            </div>
            <div className={styles.label}>Use it</div>
            <div className={styles.baseUrl}>Base URL <code>https://llm.example.com/v1</code></div>
            <pre className={styles.snippet}>{`curl https://llm.example.com/v1/chat/completions \\
  -H "Authorization: Bearer $ANTSEED_KEY" \\
  -d '{"model": "kimi-k2.7-code",
       "messages": [{"role": "user", "content": "Hi"}]}'`}</pre>
            <span className={`${styles.pill} ${styles.a} ${styles.doneBtn}`}>Done</span>
          </div>
        </div>

        <span className={`${styles.cursor} ${styles.a}`}>
          <svg width="18" height="22" viewBox="0 0 18 22" className={styles.a}>
            <path d="M2 2 L2 17 L6 13 L9 20 L12 19 L9 12 L15 12 Z" fill="#FFFFFF" stroke="#000000" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
        </span>
      </div>
    </div>
  );
}
