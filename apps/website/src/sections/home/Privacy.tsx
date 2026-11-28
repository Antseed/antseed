import {useMemo, useRef, type JSX} from 'react';
import clsx from 'clsx';
import {Heading, Section, Sub} from '../../components';
import {useMediaQuery} from '../../lib/useMediaQuery';
import {EyebrowLink} from '../../parts/EyebrowLink';
import {PrivacyDots} from '../../parts/PrivacyDots/PrivacyDots';
import {IncognitoAnt} from './privacy/IncognitoAnt';
import {PointList} from './privacy/PointList';
import {PointPanel} from './privacy/PointPanel';
import {PRIVACY_POINTS} from './privacy/points';
import {usePinnedPoints} from './privacy/usePinnedPoints';
import {useScenePlay} from './privacy/useScenePlay';
import styles from './privacy/Privacy.module.css';

const TITLE_ID = 'privacy-h';
/** A phone: a point's screen and its line are taller than the screen, so the four stand one under another, all shown. */
const STACKED = '(max-width: 760px)';

/**
 * Privacy and trust: a dark band framed by the dot mosaic, four points beside one panel, held on screen while the scroll goes through
 * them. On a phone the points stand one under another, each its name and line over its panel.
 */
export default function Privacy(): JSX.Element {
  const hold = useRef<HTMLDivElement>(null);
  const pin = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const ant = useRef<HTMLDivElement>(null);
  const refs = useMemo(() => ({hold, pin, list, stage, ant}), []);
  const stacked = useMediaQuery(STACKED);
  const {current, choose} = usePinnedPoints(refs, PRIVACY_POINTS.length, stacked);
  useScenePlay(stage, current, stacked);

  return (
    <Section cmp="home/privacy" id="privacy" labelledBy={TITLE_ID} bare className={styles.privacy}>
      <div ref={hold} className={styles.hold} data-privacy="">
        <div ref={pin} className={styles.pin}>
          <PrivacyDots quietRef={head} clearRef={stage} />
          <div className={clsx(styles.rail, styles.top)}>
            <header ref={head} className={styles.head}>
              <EyebrowLink to="/docs/security/" className={styles.eyebrow}>Privacy and trust</EyebrowLink>
              <Heading reveal id={TITLE_ID} title={['The privacy', 'you choose.']} className={styles.title} />
              <Sub reveal className={styles.sub}>Protect your identity, verify the model, and choose who handles your prompt.</Sub>
            </header>
          </div>
          <div className={clsx(styles.rail, styles.body)}>
            <div className={styles.points}>
              <PointList points={PRIVACY_POINTS} current={current} choose={choose} labelledBy={TITLE_ID} listRef={list} stacked={stacked} />
              {/* stacked, the stage has no box (display: contents) and never reveals, so each panel reveals itself: keyed by the layout,
                  the stacked panels mount anew and the reveal picks them up */}
              <div ref={stage} className={styles.stage} data-rv="panel">
                <div ref={ant} className={styles.antSeat}><IncognitoAnt /></div>
                {PRIVACY_POINTS.map((p, i) => (
                  <PointPanel key={`${p.id}-${stacked ? 'stacked' : 'tabs'}`} point={p} index={i} on={stacked || i === current} stacked={stacked} />
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className={styles.run} aria-hidden="true" />
      </div>
    </Section>
  );
}
