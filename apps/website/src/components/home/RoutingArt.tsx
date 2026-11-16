import styles from './WhatYouGet.module.css';

export function RoutingArt({model = 'kimi-k2.7-code'}: {model?: string} = {}) {
  return (
    <div className={styles.routing}>
      <span className={styles.routeModel}>{model}</span>
      <svg viewBox="0 0 280 180" preserveAspectRatio="none" className={styles.routeLines}>
        <path d="M140 52 V122" className={styles.routeOn} />
        <path d="M140 52 C140 90 56 84 56 122" className={styles.routeOn} />
        <path d="M140 52 C140 90 224 84 224 122" className={styles.routeOff} />
      </svg>
      <div className={styles.routeNodes}>
        <span>
          <i className={styles.nodeOk}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-10" /></svg>
          </i>
          Provider A
        </span>
        <span><i className={styles.nodeIdle} />Provider B</span>
        <span className={styles.nodeOffLabel}>
          <i className={styles.nodeOff}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </i>
          Offline
        </span>
      </div>
    </div>
  );
}
