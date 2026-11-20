import type {JSX} from 'react';
import clsx from 'clsx';
import {Glass, GlassChip, GlassWindow} from '../../parts/Glass/Glass';
import {PixelIcon} from '../../parts/PixelIcon';
import styles from './PrivacyScenes.module.css';

/* The three privacy cards' glass, drawn over night paintings: smoked green glass in both themes. Decorative: each card's caption says it. */

const ICON_SIZE = 14;

const Led = ({on}: {on?: boolean}) => <i className={clsx(styles.led, on && styles.ledOn)} />;

/** The request leaves as ciphertext and is read by one Mac. */
export function EncryptedScene(): JSX.Element {
  return (
    <div className={styles.scene} aria-hidden="true">
      <GlassChip night className={clsx(styles.glass, styles.from)}><Led />Your request</GlassChip>
      <Glass as="p" night className={clsx(styles.glass, styles.cipher)}>9f3a c21e 7b04 e88d 41a0 d3f9 06bc 5e17</Glass>
      <GlassWindow night className={clsx(styles.glass, styles.to)} icon={<Led on />} title="The Mac you chose" text="Decrypted here, and only here" />
    </div>
  );
}

/** The decryption key inside the Secure Enclave. */
export function EnclaveScene(): JSX.Element {
  return (
    <div className={styles.scene} aria-hidden="true">
      <GlassWindow
        night
        className={clsx(styles.glass, styles.enclave)}
        icon={<Led on />}
        title="Secure Enclave"
        rows={[{term: 'Leaves the Mac', value: 'Never'}, {term: 'Bound to', value: 'The signed app'}]}>
        <p className={styles.key}><PixelIcon name="lock" size={ICON_SIZE} className={styles.icon} />Decryption key</p>
      </GlassWindow>
    </div>
  );
}

/** Apple's attestation: System Integrity Protection on. */
export function AttestationScene(): JSX.Element {
  return (
    <div className={styles.scene} aria-hidden="true">
      <GlassWindow
        night
        className={clsx(styles.glass, styles.attest)}
        icon={<PixelIcon name="check" size={ICON_SIZE} className={styles.icon} />}
        title="Apple attestation"
        rows={[{term: 'System Integrity Protection', value: <><Led on />On</>}, {term: 'Device', value: 'Mac Studio'}]}
      />
      <GlassChip night className={clsx(styles.glass, styles.verified)}><Led on />Verified by Apple</GlassChip>
    </div>
  );
}
