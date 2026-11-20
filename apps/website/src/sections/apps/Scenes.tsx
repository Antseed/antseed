import type {CSSProperties, JSX} from 'react';
import clsx from 'clsx';
import {Glass} from '../../parts/Glass/Glass';
import {PixelIcon} from '../../parts/PixelIcon';
import styles from './Scenes.module.css';

const LABS = [
  {name: 'Anthropic', src: 'labs-color/anthropic.svg'},
  {name: 'OpenAI', src: 'labs/openai.svg', mono: true},
  {name: 'Google', src: 'labs-color/google.svg'},
  {name: 'DeepSeek', src: 'labs-color/deepseek.svg'},
  {name: 'Qwen', src: 'labs-color/qwen.svg'},
  {name: 'Moonshot', src: 'labs/moonshot.svg', mono: true},
] as const;

const KEYS = [
  {name: 'Production', key: 'antseed_…prod', budget: '$100 /mo'},
  {name: 'Staging', key: 'antseed_…test', budget: '$20 /mo'},
  {name: 'Support', key: 'antseed_…help', budget: '$50 /mo'},
] as const;

const ROUTES = [
  {name: 'Provider A', state: 'on'},
  {name: 'Provider B', state: 'idle'},
  {name: 'Offline', state: 'off'},
] as const;

/** The labs whose models the gateway reaches, on a glass tray. */
export function ModelsScene(): JSX.Element {
  return (
    <Glass className={clsx(styles.tray, styles.labs)}>
      {LABS.map((l) => (
        <i key={l.name} className={clsx(styles.lab, 'mono' in l && styles.mono)} style={{'--lab': `url(/site/assets/home/icons/${l.src})`} as CSSProperties} />
      ))}
    </Glass>
  );
}

/** A key for every app, each with its budget. */
export function KeysScene(): JSX.Element {
  return (
    <Glass as="dl" className={clsx(styles.tray, styles.keys)}>
      {KEYS.map((k) => (
        <div key={k.name} className={styles.key}>
          <dt><b>{k.name}</b><small>{k.key}</small></dt>
          <dd>{k.budget}</dd>
        </div>
      ))}
    </Glass>
  );
}

/** Requests only to secure enclaves. */
export function PrivacyScene(): JSX.Element {
  return <Glass as="span" className={clsx(styles.tray, styles.lock)}><PixelIcon name="lock" /></Glass>;
}

/** Your model, routed to the provider your rules pick, never to one that is offline. */
export function RoutingScene(): JSX.Element {
  return (
    <Glass className={clsx(styles.tray, styles.routes)}>
      <p className={styles.model}>Your model</p>
      <ul>
        {ROUTES.map((r) => <li key={r.name}><i className={styles[r.state]} />{r.name}</li>)}
      </ul>
    </Glass>
  );
}
