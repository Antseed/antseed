import {useMemo, useRef, type JSX} from 'react';
import {useInView} from '../../../lib/useInView';
import {usePageVisible} from '../../../lib/usePageVisible';
import {useStill} from '../../../lib/useStill';
import {HeroText} from './HeroText';
import {Painting} from './painting/Painting';
import {useMascot} from './mascot/useMascot';
import {newHand, UI_ATTR, type HandClasses} from './seed/hand';
import {useSeedCursor} from './seed/useSeedCursor';
import {useSeedInk} from './seed/useSeedInk';
import styles from './HeroCard.module.css';

const HAND_CLASSES: HandClasses = {seeding: styles.seeding, overUi: styles.overUi, empty: styles.empty, fed: styles.fed};
const SCENE_CLASSES = {...HAND_CLASSES, groundOn: styles.groundOn, groundTaken: styles.groundTaken, lifting: styles.lifting};

/** The first screen's card under the nav: the meadow, the mascot at its bottom right, the text over them and the seed cursor. */
export function HeroCard(): JSX.Element {
  const card = useRef<HTMLElement>(null);
  const paint = useRef<HTMLDivElement>(null);
  const night = useRef<HTMLDivElement>(null);
  const film = useRef<HTMLVideoElement>(null);
  const puppet = useRef<HTMLCanvasElement>(null);
  const fore = useRef<HTMLCanvasElement>(null);
  const groundSeed = useRef<HTMLButtonElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const install = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const refs = useMemo(() => ({card, paint, night, film, puppet, fore, groundSeed, cursor, install, title}), []);
  const hand = useMemo(newHand, []);

  const still = useStill();
  const onScreen = useInView(card);
  const visible = usePageVisible();
  const active = onScreen && visible;
  const seed = useSeedInk();
  useSeedCursor({hero: card, cursor, hand, classes: HAND_CLASSES, active, still});
  useMascot({refs, hand, classes: SCENE_CLASSES, active, still});

  return (
    <section ref={card} className={styles.card} id="hero" data-cmp="home/hero" aria-labelledby="hero-title">
      <Painting paintRef={paint} nightRef={night} dayFilmRef={film} />
      <canvas ref={puppet} className={styles.puppet} aria-hidden="true" />
      <canvas ref={fore} className={styles.fore} aria-hidden="true" />
      <button ref={groundSeed} className={styles.groundSeed} type="button" aria-label="Pick up the seed" {...{[UI_ATTR]: ''}}>
        <img src={seed} alt="" />
      </button>
      <HeroText installRef={install} titleRef={title} />
      <div ref={cursor} className={styles.cursor} aria-hidden="true"><img src={seed} alt="" /></div>
    </section>
  );
}
