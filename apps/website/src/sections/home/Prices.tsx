import {useRef, useState, type CSSProperties, type JSX} from 'react';
import {Heading, Section} from '../../components';
import {useMarket} from '../../lib/antscan';
import {MediaTabs} from './prices/MediaTabs';
import {ModelLanes} from './prices/ModelLanes';
import {MEDIA, type Medium} from './prices/models';
import {useCarriers} from './prices/useCarriers';
import {useLaneSwipe} from './prices/useLaneSwipe';
import {usePricesMotion} from './prices/usePricesMotion';
import styles from './prices/Prices.module.css';

/** The live count rounded down to the hundred ("1,000+"), so the title never overstates and doesn't flicker on small changes. */
const modelCountLabel = (count: number) => `${(Math.floor(count / 100) * 100).toLocaleString('en-US')}+`;

const CARD_SIZE = 176;
const CARD_SIZE_PHONE = 152;
const PANEL_ID = 'models';

/** The live model count, then a tab per medium over its models going by in two lanes, each card carried by a little ant. */
export default function Prices(): JSX.Element {
  const flowRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Medium>('text');        // the chosen tab, at once
  const [shown, setShown] = useState<Medium>('text');    // the lanes on screen, after the swipe out
  const {lanes, models} = useMarket(flowRef);
  const media = MEDIA.filter((m) => lanes[m.id].length > 0);
  const motion = usePricesMotion(flowRef);
  const side = motion.phone ? CARD_SIZE_PHONE : CARD_SIZE;
  // a live read that changes the models rebuilds the lanes, as a tab change does
  const build = `${shown}-${motion.carried}-${side}-${motion.width}-${lanes[shown].map((m) => m.name).join()}`;
  useCarriers(flowRef, motion.carried, motion.moving, side, build);
  const swipe = useLaneSwipe(flowRef, shown, motion.still);

  const select = (next: Medium) => {
    if (next === tab) return;
    const order = (m: Medium) => media.findIndex((x) => x.id === m);
    setTab(next);
    swipe(Math.sign(order(next) - order(tab)) || 1, () => setShown(next));
  };

  return (
    <Section cmp="home/prices" id="prices" labelledBy="prices-title" pad="all" className={styles.section} railClassName={styles.rail}>
      <div data-rv="">
        <Heading id="prices-title" title={[`${modelCountLabel(models)} models.`, 'Best Prices.']} secondLine="break" strong />
      </div>
      <div className={styles.models}>
        <MediaTabs tabs={media} selected={tab} onSelect={select} panelId={PANEL_ID} label="Media" className={styles.tabs} />
        <div ref={flowRef} id={PANEL_ID} role="tabpanel" aria-labelledby={`${PANEL_ID}-${tab}`}
          className={motion.carried ? styles.carriedFlow : styles.flow} data-moving={motion.moving || undefined}
          style={{'--card-size': `${side}px`} as CSSProperties}>
          <ModelLanes key={build} medium={shown} models={lanes[shown]} carried={motion.carried} side={side} width={motion.width} />
        </div>
      </div>
      <a className={styles.allModels} href="https://antseedstats.com/network" data-rv="">See all available models ↗</a>
    </Section>
  );
}
