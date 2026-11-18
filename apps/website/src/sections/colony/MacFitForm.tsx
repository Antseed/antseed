import {useState, type JSX} from 'react';
import clsx from 'clsx';
import {Button} from '../../components';
import {MACS, MEMORY, macFit} from './fitRules';
import {FORM_URL, SIGN_UP_HREF} from './signUpLinks';
import styles from './Join.module.css';

function Choice({id, label, options, value, onChange}: {id: string; label: string; options: readonly string[]; value: string; onChange: (v: string) => void}): JSX.Element {
  return (
    <label className={styles.field} htmlFor={id}>
      <span>{label}</span>
      <select id={id} className={styles.select} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose</option>
        {options.map((o) => <option key={o}>{o}</option>)}
      </select>
    </label>
  );
}

/** Where does your Mac fit? Two choices and the answer, then the sign-up button. */
export default function MacFitForm(): JSX.Element {
  const [mac, setMac] = useState('');
  const [memory, setMemory] = useState('');
  const fit = macFit(mac, memory);
  return (
    <div className={styles.fit}>
      <div>
        <p className={styles.fitTitle}>Where does your Mac fit?</p>
        <div className={styles.fields}>
          <Choice id="colony-mac" label="Mac" options={MACS} value={mac} onChange={setMac} />
          <Choice id="colony-memory" label="Memory" options={MEMORY} value={memory} onChange={setMemory} />
        </div>
        <p className={clsx(styles.answer, fit.tier === 'first' && styles.first, fit.tier === 'later' && styles.later)} aria-live="polite">
          <i className={styles.answerDot} />
          <span>{fit.message}</span>
        </p>
      </div>
      <div className={styles.cta}>
        <Button href={SIGN_UP_HREF} size="page">Sign up for early access</Button>
        {!FORM_URL && <p className={styles.note}>The sign-up form opens on launch day.</p>}
      </div>
    </div>
  );
}
