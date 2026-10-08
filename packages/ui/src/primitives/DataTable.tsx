import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';
import { Button } from './Button';

export interface DataTableColumn<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  /** Enables header sorting on this value. */
  sortValue?: (row: T) => number | string | null;
  align?: 'left' | 'right';
  /** Hide on narrow screens (below 860px). */
  secondary?: boolean;
  /** Hide on medium screens too (below 1280px); for nice-to-have detail. */
  optional?: boolean;
  width?: string;
}

function cellClass<T>(column: DataTableColumn<T>): string | undefined {
  return [
    column.align === 'right' ? 'as-num' : null,
    column.secondary ? 'as-secondary' : null,
    column.optional ? 'as-optional' : null,
  ].filter(Boolean).join(' ') || undefined;
}

type Sort = { key: string; direction: 'asc' | 'desc' };

function ariaSort(sort: Sort | null, key: string): 'ascending' | 'descending' | undefined {
  if (sort?.key !== key) return undefined;
  return sort.direction === 'asc' ? 'ascending' : 'descending';
}

function sortArrow(sort: Sort | null, key: string): string {
  if (sort?.key !== key) return '';
  return sort.direction === 'asc' ? '↑' : '↓';
}

export interface DataTableProps<T> {
  rows: T[];
  columns: Array<DataTableColumn<T>>;
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Accessible name for a row's open button and actions menu. */
  rowLabel?: (row: T) => string;
  actions?: (row: T) => Array<ActionMenuItem | null | false | undefined>;
  /** Shown instead of the table when there are no rows. */
  empty?: ReactNode;
  label: string;
  initialSort?: Sort;
}

/**
 * Sortable table. With `onRowClick`, the first cell becomes a button (so
 * rows are reachable by keyboard) and a click anywhere on the row opens it.
 * Row actions go in a kebab menu (`actions`) so they never widen the table.
 */
export function DataTable<T>({ rows, columns, rowKey, onRowClick, rowLabel, actions, empty, label, initialSort }: DataTableProps<T>) {
  const [sort, setSort] = useState<Sort | null>(initialSort ?? null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((entry) => entry.key === sort.key);
    if (!column?.sortValue) return rows;
    const value = column.sortValue;
    const factor = sort.direction === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const left = value(a);
      const right = value(b);
      if (left === right) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      return (left < right ? -1 : 1) * factor;
    });
  }, [rows, columns, sort]);

  if (rows.length === 0 && empty) return <>{empty}</>;

  return (
    <div className="as-table-wrap">
      <table className="as-table" aria-label={label}>
        <thead>
          <tr>
            {columns.map((column) => {
              const active = sort?.key === column.key;
              return (
                <th key={column.key} className={cellClass(column)} style={column.width ? { width: column.width } : undefined}
                  aria-sort={ariaSort(sort, column.key)}>
                  {column.sortValue ? (
                    <button type="button" className="as-table__sort" onClick={() => setSort({
                      key: column.key,
                      direction: active && sort!.direction === 'desc' ? 'asc' : 'desc',
                    })}>
                      {column.header}
                      <span aria-hidden="true" className="as-table__arrow">{sortArrow(sort, column.key)}</span>
                    </button>
                  ) : column.header}
                </th>
              );
            })}
            {actions && <th className="as-table__actions"><span className="as-sr">Actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={rowKey(row)} className={onRowClick ? 'as-table__row--click' : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}>
              {columns.map((column, index) => (
                <td key={column.key} className={cellClass(column)}>
                  {index === 0 && onRowClick ? (
                    <button type="button" className="as-table__open" aria-label={rowLabel ? `Open ${rowLabel(row)}` : undefined}
                      onClick={(event) => { event.stopPropagation(); onRowClick(row); }}>
                      {column.render(row)}
                    </button>
                  ) : column.render(row)}
                </td>
              ))}
              {actions && (
                <td className="as-table__actions" onClick={(event) => event.stopPropagation()}>
                  <ActionMenu label={rowLabel ? `Actions for ${rowLabel(row)}` : 'Actions'} items={actions(row)} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface PagerState<T> {
  items: T[];
  page: number;
  pages: number;
  total: number;
  setPage: (page: number) => void;
}

/** Client-side pages over `rows`; jumps back to page 1 when `resetKey` changes. */
export function usePager<T>(rows: readonly T[], size: number, resetKey = ''): PagerState<T> {
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [resetKey]);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(page, pages - 1);
  return { items: rows.slice(current * size, (current + 1) * size), page: current, pages, total: rows.length, setPage };
}

/** Previous/next controls under a paged table; renders nothing for a single page. */
export function Pager<T>({ pager, noun }: { pager: PagerState<T>; noun: string }) {
  if (pager.pages <= 1) return null;
  return (
    <nav className="as-pager" aria-label={`${noun} pages`}>
      <span className="as-pager__status">Page {pager.page + 1} of {pager.pages} · {pager.total} {noun}</span>
      <div className="as-pager__buttons">
        <Button variant="outline" size="sm" disabled={pager.page === 0} onClick={() => pager.setPage(pager.page - 1)}>Previous</Button>
        <Button variant="outline" size="sm" disabled={pager.page >= pager.pages - 1} onClick={() => pager.setPage(pager.page + 1)}>Next</Button>
      </div>
    </nav>
  );
}
