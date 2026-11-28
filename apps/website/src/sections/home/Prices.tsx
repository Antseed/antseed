import {useRef, useState, type JSX} from 'react';
import {Heading, Section} from '../../components';
import {mediumWithModels, useMarket} from '../../lib/antscan';
import {MediaTabs} from './prices/MediaTabs';
import {ModelLanes} from './prices/ModelLanes';
import {MEDIA, type Medium} from './prices/models';
import {useCarriers} from './prices/useCarriers';
import {useLaneSwipe} from './prices/useLaneSwipe';
import {usePricesMotion} from './prices/usePricesMotion';
import styles from './prices/Prices.module.css';

/** The model count the rest of the site states (hero figures, page descriptions), fixed so the two never disagree. */
const MODEL_COUNT = '700+';

/** Card sides in px; Prices.module.css sets the same as --card-size, so the first paint already has the phone's size. */
const CARD_SIZE = 176;
const CARD_SIZE_PHONE = 152;
const PANEL_ID = 'models';

/** The model count, then a tab per medium over its models going by in two lanes, each card carried by a little ant. */
export default function Prices(): JSX.Element {
  const flowRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Medium>('text');        // the chosen tab, at once
  const [shown, setShown] = useState<Medium>('text');    // the lanes on screen, after the swipe out
  const {lanes} = useMarket(flowRef);
  const media = MEDIA.filter((m) => lanes[m.id].length > 0);
  // a live read can empty a medium: its tab goes, and the board falls back to one with models
  const selected = mediumWithModels(lanes, tab);
  const onShow = mediumWithModels(lanes, shown);
  const motion = usePricesMotion(flowRef);
  const side = motion.phone ? CARD_SIZE_PHONE : CARD_SIZE;
  // a live read that changes the models rebuilds the lanes, as a tab change does
  const build = `${onShow}-${motion.carried}-${side}-${motion.width}-${lanes[onShow].map((m) => m.name).join()}`;
  useCarriers(flowRef, motion.carried, motion.moving, side, build);
  const swipe = useLaneSwipe(flowRef, onShow, motion.still);

  const select = (next: Medium) => {
    if (next === selected) return;
    const order = (m: Medium) => media.findIndex((x) => x.id === m);
    setTab(next);
    swipe(Math.sign(order(next) - order(selected)) || 1, next, () => setShown(next));
  };

  return (
    <Section cmp="home/prices" id="prices" labelledBy="prices-title" pad="all" className={styles.section} railClassName={styles.rail}>
      <div data-rv="">
        <Heading id="prices-title" title={[`${MODEL_COUNT} models.`, 'Best Prices.']} secondLine="break" strong />
      </div>
      <div className={styles.models}>
        <MediaTabs tabs={media} selected={selected} onSelect={select} panelId={PANEL_ID} label="Media" className={styles.tabs} />
        <div ref={flowRef} id={PANEL_ID} role="tabpanel" aria-labelledby={`${PANEL_ID}-${selected}`}
          className={motion.carried ? styles.carriedFlow : styles.flow} data-moving={motion.moving || undefined}>
          <ModelLanes key={build} medium={onShow} models={lanes[onShow]} carried={motion.carried} side={side} width={motion.width} />
        </div>
      </div>
      <a className={styles.allModels} href="https://antseedstats.com/network" data-rv="">See all available models ↗</a>
    </Section>
  );
}
