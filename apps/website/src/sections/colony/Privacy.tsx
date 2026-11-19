import {useRef, type JSX} from 'react';
import {Eyebrow, Heading, Section, Wash} from '../../components';
import {PrivacyDots} from '../../parts/PrivacyDots/PrivacyDots';
import {AttestationScene, EnclaveScene, EncryptedScene} from './PrivacyScenes';
import {PAINTINGS, type Painting} from '../../lib/paintings';
import styles from './Privacy.module.css';

/** The band is always night: each point shows its painting's night, in both themes. */
const atNight = ({night, nightPhone}: Painting) => ({day: night, dayPhone: nightPhone});

type Point = {lead: string; text: string; painting: ReturnType<typeof atNight>; Scene: () => JSX.Element};

const POINTS: readonly Point[] = [
  {lead: 'End-to-end encrypted', text: 'The pool routes ciphertext. Only the Mac the buyer chose can read a request.', painting: atNight(PAINTINGS.river), Scene: EncryptedScene},
  {lead: 'Keys in the Secure Enclave', text: 'The app’s decryption keys never leave the Mac’s Secure Enclave and are bound to the signed app.', painting: atNight(PAINTINGS.clover), Scene: EnclaveScene},
  {lead: 'Apple-verified Macs', text: 'Pools that run an MDM can show buyers Apple’s own attestation that a Mac has System Integrity Protection on.', painting: atNight(PAINTINGS.ferns), Scene: AttestationScene},
];

/** Private by design: the night band, its dot field, and three illustrated points. */
export default function Privacy(): JSX.Element {
  const head = useRef<HTMLDivElement>(null);
  return (
    <Section cmp="colony/privacy" snap="narrow" id="privacy" labelledBy="privacy-title" className={styles.band} bare>
      <PrivacyDots quietRef={head} />
      <div className={styles.rail}>
        <div ref={head} className={styles.head} data-rv="">
          <Eyebrow className={styles.eyebrow}>Private by design</Eyebrow>
          <Heading id="privacy-title" secondLine="break" title={['The pool can’t read', 'the prompts it routes.']} className={styles.title} />
        </div>
        <div className={styles.cards}>
          {POINTS.map(({lead, text, painting, Scene}) => (
            <article key={lead} className={styles.card}>
              <Wash unveil className={styles.scene} {...painting}><Scene /></Wash>
              <p className={styles.caption}><b>{lead}</b> {text}</p>
            </article>
          ))}
        </div>
      </div>
    </Section>
  );
}
