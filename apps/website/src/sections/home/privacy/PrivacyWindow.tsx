import type {JSX} from 'react';
import Link from '@docusaurus/Link';
import {PixelIcon} from '../../../parts/PixelIcon';
import type {PrivacyPoint, Screen} from './points';
import styles from './PrivacyWindow.module.css';

const BARS = 12;

/** A point's screen: one window of smoked glass over its painting: a title, a picture of the idea, its result, a line and a link. */
export function PrivacyWindow({window: w}: {window: PrivacyPoint['window']}): JSX.Element {
  return (
    <div className={styles.frame}>
      <div className={styles.window} data-window="">
        <h3 className={styles.title}>{w.title[0]}<br />{w.title[1]}</h3>
        <ScreenPicture screen={w.screen} />
        {w.result && <p className={styles.result}>{w.result}</p>}
        <p className={styles.body}>{w.body}</p>
        {w.link && <Link className={styles.link} to={w.link.href}>{w.link.label}</Link>}
      </div>
    </div>
  );
}

function ScreenPicture({screen}: {screen: Screen}): JSX.Element {
  switch (screen.kind) {
    case 'route': return <Route />;
    case 'fingerprint': return <Fingerprint series={screen.series} />;
    case 'enclave': return <Enclave />;
    case 'ledger': return <Ledger rows={screen.rows} />;
  }
}

/** Your device, the dotted thread with a green dot running it, your provider. */
function Route(): JSX.Element {
  return (
    <div className={styles.route}>
      <figure className={styles.end}><PixelIcon name="laptop" className={styles.endIcon} /><figcaption>Your device</figcaption></figure>
      <i className={styles.thread} aria-hidden="true"><b /></i>
      <figure className={styles.end}><PixelIcon name="server" className={styles.endIcon} /><figcaption>Your provider</figcaption></figure>
    </div>
  );
}

/** The genuine model's answer pattern beside the provider's, bar for bar the same. */
function Fingerprint({series}: {series: readonly [string, string]}): JSX.Element {
  return (
    <div className={styles.fingerprint}>
      {series.map((name) => (
        <div key={name} className={styles.series}>
          <p className={styles.seriesName}>{name}</p>
          <div className={styles.bars} aria-hidden="true">{Array.from({length: BARS}, (_, i) => <i key={i} />)}</div>
        </div>
      ))}
    </div>
  );
}

/** The provider's server, the verified enclave inside it, the operator kept out. */
function Enclave(): JSX.Element {
  return (
    <div className={styles.server}>
      <p>Provider’s server</p>
      <div className={styles.enclave}>
        <p className={styles.enclaveTitle}><PixelIcon name="check" className={styles.check} />Verified enclave</p>
        <p className={styles.enclaveFlow}>Your prompt → Model → Answer</p>
        <p className={styles.small}>Data is decrypted only inside</p>
      </div>
      <p className={styles.small}>Server operator: no access to data inside</p>
    </div>
  );
}

/** What backs the provider, row by row. */
function Ledger({rows}: {rows: Extract<Screen, {kind: 'ledger'}>['rows']}): JSX.Element {
  return (
    <dl className={styles.ledger}>
      {rows.map((r) => (
        <div key={r.term} className={styles.ledgerRow}>
          <dt>{r.term}</dt>
          <dd>{r.checked && <PixelIcon name="check" className={styles.check} />}{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}
