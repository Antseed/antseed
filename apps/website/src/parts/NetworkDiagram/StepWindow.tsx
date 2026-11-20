import type {CSSProperties, JSX} from 'react';
import clsx from 'clsx';
import type {Block, Cell, Coin, LegendItem, NetworkStep, Row} from './steps';
import styles from './StepWindow.module.css';

const COIN_ICON: Record<Coin, string> = {
  usdc: '/site/assets/home/icons/usdc.svg',
  ants: '/site/assets/network/diagram/ants-coin.webp',
};
const LEGEND_BOX = {x: 36, width: 28, height: 16};

function CellText({cell, at}: {cell: Cell; at?: number}): JSX.Element {
  const style = at === undefined ? undefined : {left: `${at}%`};
  if (cell.coin) {
    return <span className={styles.pill} style={style}><img src={COIN_ICON[cell.coin]} alt="" width={14} height={14} loading="lazy" />{cell.text}</span>;
  }
  return <span className={styles[cell.tone]} style={style}>{cell.text}</span>;
}

function WindowRow({row}: {row: Row}): JSX.Element {
  if (row.kind === 'columns') return <div className={styles.columns}>{row.cells.map((c, i) => <CellText key={i} cell={c} at={c.at} />)}</div>;
  return <div className={styles.row}>{row.cells.map((c, i) => <CellText key={i} cell={c} />)}</div>;
}

function WindowBlock({block, state}: {block: Block; state: 'hidden' | 'lit' | 'quiet'}): JSX.Element {
  return (
    <div className={styles.block} data-state={state}>
      <div className={styles.blockTitle}><span className={styles.value}>{block.title}</span></div>
      {block.rows.map((row, i) => <WindowRow key={i} row={row} />)}
    </div>
  );
}

function Legend({items}: {items: readonly LegendItem[]}): JSX.Element {
  return (
    <div className={styles.legend}>
      {items.map((item) => (
        <span key={item.label} className={styles.legendItem}>
          <svg viewBox={`${LEGEND_BOX.x} ${item.y - LEGEND_BOX.height / 2} ${LEGEND_BOX.width} ${LEGEND_BOX.height}`} width={LEGEND_BOX.width} height={LEGEND_BOX.height} fill="none" aria-hidden="true">
            {item.mark}
          </svg>
          {item.label}
        </span>
      ))}
    </div>
  );
}

type Props = {
  step: NetworkStep;
  active: boolean;
  /** Blocks up to this one show, this one lit (-1: none). */
  beat: number;
  /** Change the blocks without their fade (the window is hidden). */
  instant: boolean;
};

/** A step's data window: its name and layer, one block per beat of the drawing, and the legend. */
export function StepWindow({step, active, beat, instant}: Props): JSX.Element {
  const lit = Math.min(beat, step.blocks.length - 1);
  return (
    <div className={clsx(styles.window, active && styles.active, instant && styles.instant)} style={{'--accent': step.accent} as CSSProperties}>
      <div className={styles.head}><b>{step.name}</b><span>{step.layer}</span></div>
      {step.blocks.map((block, i) => <WindowBlock key={block.title} block={block} state={i > lit ? 'hidden' : i === lit ? 'lit' : 'quiet'} />)}
      <Legend items={step.legend} />
    </div>
  );
}
