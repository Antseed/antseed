import { useEffect, useRef, useState } from 'react';
import styles from './ChatBoxAnt.module.scss';

type AntFace = 'idle' | 'listen' | 'think' | 'route' | 'happy' | 'oops';

const antUrl = (file: string) => new URL(`../../../assets/v4/ant/${file}.png`, import.meta.url).href;

const FACES: Record<AntFace, { day: string; night: string }> = {
  idle: { day: antUrl('idle'), night: antUrl('priv-night') },
  listen: { day: antUrl('listen'), night: antUrl('priv-night') },
  think: { day: antUrl('think'), night: antUrl('privThink-night') },
  route: { day: antUrl('route'), night: antUrl('privThink-night') },
  happy: { day: antUrl('happy'), night: antUrl('privHappy-night') },
  oops: { day: antUrl('oops'), night: antUrl('privOops-night') },
};

const ALT: Record<AntFace, string> = {
  idle: 'peeks over the message box',
  listen: 'is listening',
  think: 'is thinking',
  route: 'is picking a provider',
  happy: 'is happy with the answer',
  oops: 'looks worried',
};

const SPOKEN: Partial<Record<AntFace, string>> = {
  think: 'Antseed is thinking',
  route: 'Antseed is picking a provider',
  happy: 'Answer ready',
  oops: 'Something went wrong. See the note in the chat.',
};

const FACE_NAMES = Object.keys(FACES) as AntFace[];
const THINK_TO_ROUTE_MS = 1000;
const HAPPY_MS = 2000;
const OOPS_MS = 3700;

/**
 * The ant peeking over the chat box, reacting to what the chat is already
 * doing. Purely presentational: it reads state and never changes it.
 */
export function ChatBoxAnt({ typing, sending, answering, error, privateMode }: {
  typing: boolean;
  /** A request is in flight. */
  sending: boolean;
  /** Tokens have started to arrive. */
  answering: boolean;
  error: string | null;
  privateMode: boolean;
}) {
  const [routing, setRouting] = useState(false);
  const [happy, setHappy] = useState(false);
  const [oops, setOops] = useState(false);
  const wasAnswering = useRef(false);

  const waiting = sending && !answering;
  useEffect(() => {
    if (!waiting) {
      setRouting(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setRouting(true), THINK_TO_ROUTE_MS);
    return () => window.clearTimeout(timer);
  }, [waiting]);

  useEffect(() => {
    const firstToken = answering && !wasAnswering.current;
    wasAnswering.current = answering;
    if (!firstToken) return undefined;
    setHappy(true);
    const timer = window.setTimeout(() => setHappy(false), HAPPY_MS);
    return () => window.clearTimeout(timer);
  }, [answering]);

  useEffect(() => {
    if (!error) {
      setOops(false);
      return undefined;
    }
    setOops(true);
    const timer = window.setTimeout(() => setOops(false), OOPS_MS);
    return () => window.clearTimeout(timer);
  }, [error]);

  let face: AntFace = 'idle';
  if (oops) face = 'oops';
  else if (happy) face = 'happy';
  else if (waiting) face = routing ? 'route' : 'think';
  else if (typing) face = 'listen';

  const who = privateMode ? 'The Antseed ant, in sunglasses,' : 'The Antseed ant';
  const thinking = face === 'think' || face === 'route';

  return (
    <>
      <div className={styles.ant} role="img" aria-label={`${who} ${ALT[face]}`}>
        <div className={styles.rise}>
          <div className={`${styles.move} ${thinking ? styles.moveThink : styles.moveBreath}`}>
            {FACE_NAMES.map((name) => (
              <img
                key={name}
                src={privateMode ? FACES[name].night : FACES[name].day}
                alt=""
                className={`${styles.face}${name === face ? ` ${styles.faceShown}` : ''}`}
              />
            ))}
          </div>
        </div>
      </div>
      <span className={styles.spoken} aria-live="polite">{SPOKEN[face] ?? ''}</span>
    </>
  );
}
