import type {CSSProperties, JSX} from 'react';
import clsx from 'clsx';
import styles from './CompareTable.module.css';

export type CompareColumn = {label: string; /** Drawn in the accent: the side the page argues for. */ good?: boolean};
export type CompareRow = {label: string; cells: readonly string[]};

type Props = {
  columns: readonly CompareColumn[];
  rows: readonly CompareRow[];
  /** The header of the row labels' column (visually hidden). */
  rowsLabel: string;
  className?: string;
};

/**
 * A comparison table between dotted rules; on phones each row becomes a block with its cells labelled. Rows are laid out as grids
 * (so each can carry its dotted rule), with the table roles spelled out because a changed display drops them in some browsers.
 */
export function CompareTable({columns, rows, rowsLabel, className}: Props): JSX.Element {
  return (
    <div className={clsx(styles.wrap, className)} style={{'--columns': columns.length} as CSSProperties} data-rv="">
      <table className={styles.table} role="table">
        <thead role="rowgroup">
          <tr className={clsx(styles.row, styles.head)} role="row">
            <th scope="col" role="columnheader"><span className={styles.hidden}>{rowsLabel}</span></th>
            {columns.map((c) => <th key={c.label} scope="col" role="columnheader" className={clsx(c.good && styles.good)}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((r) => (
            <tr key={r.label} className={styles.row} role="row">
              <th scope="row" role="rowheader">{r.label}</th>
              {r.cells.map((cell, i) => (
                <td key={columns[i].label} role="cell" data-col={columns[i].label} className={clsx(columns[i].good && styles.good)}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
