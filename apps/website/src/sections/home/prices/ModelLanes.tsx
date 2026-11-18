import type {CSSProperties, JSX} from 'react';
import clsx from 'clsx';
import {CarryingAnt} from './CarryingAnt';
import {ModelCard} from '../../../parts/ModelCard';
import {CARRY_GAP, LANE_SPEED, PACE} from './carriers';
import {carriedWidth, castLane, fitsFor, laneBelow, walksAhead} from './carryGeometry';
import type {Medium, Model} from './models';
import styles from './ModelLanes.module.css';

const CARD_GAP = 12;
/** Each lane repeats its cards until a copy is wider than any screen, so the loop never shows its end. */
const MIN_LOOP_WIDTH = 2400;
/** A medium with fewer models fills one lane. */
const TWO_LANES_FROM = 4;

type Props = {
  medium: Medium;
  models: readonly Model[];
  /** Cards carried by ants (useCarriers walks them); otherwise the lanes slide (CSS). */
  carried: boolean;
  /** Card side in px (176, 152 on phones). */
  side: number;
  /** The flow's width, to size the loop. */
  width: number;
};

const repeat = (models: readonly Model[], times: number) => Array.from({length: times}, (_, r) => models.map((m, i) => ({m, r, i}))).flat();

/** The medium's models in two lanes of cards, the second going the other way. */
export function ModelLanes({medium, models: rows, carried, side, width}: Props): JSX.Element {
  const laneCount = rows.length >= TWO_LANES_FROM ? 2 : 1;
  const slot = (carried ? carriedWidth(side) + CARRY_GAP : side + CARD_GAP);
  const loopWidth = Math.max(MIN_LOOP_WIDTH, width + 3 * slot);
  let above: number[] | null = null;

  return (
    <>
      {Array.from({length: laneCount}, (_, k) => {
        const mine = rows.filter((_, i) => i % laneCount === k);
        const times = Math.ceil(loopWidth / (mine.length * slot));
        const cards = repeat(mine, times);
        if (carried) {
          const fits = fitsFor(side, k > 0);
          const cast = castLane(k, cards.length, above);
          above = cast;
          return (
            <div key={k} className={clsx(styles.lane, styles.carryLane)} data-carry-lane="" style={{'--below': `${laneBelow(side).toFixed(2)}px`} as CSSProperties}>
              <ul className={styles.track}>
                {cards.map(({m, r, i}, n) => (
                  <ModelCard key={`${r}-${i}`} model={m} medium={medium} repeat={r > 0} carried className={styles.carried}
                    style={{...fits[cast[n]].vars, '--below': `${fits[cast[n]].below.toFixed(2)}px`} as CSSProperties} data-carrier={String(cast[n])}>
                    <CarryingAnt mirrored={k > 0} ahead={walksAhead(k, n)} />
                  </ModelCard>
                ))}
              </ul>
            </div>
          );
        }
        const duration = (cards.length * slot / PACE / LANE_SPEED[k]).toFixed(1);
        return (
          <div key={k} className={clsx(styles.lane, styles.slideLane, k > 0 && styles.reverse)} style={{'--duration': `${duration}s`} as CSSProperties}>
            <ul className={styles.track}>{cards.map(({m, r, i}) => <ModelCard key={`${r}-${i}`} model={m} medium={medium} repeat={r > 0} />)}</ul>
            <ul className={clsx(styles.track, styles.copy)} aria-hidden="true">{cards.map(({m, r, i}) => <ModelCard key={`${r}-${i}`} model={m} medium={medium} repeat />)}</ul>
          </div>
        );
      })}
    </>
  );
}
