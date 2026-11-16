import { Skeleton } from './ui';
import type { ReactNode } from 'react';

export interface Column<T> {
  key: string;
  label: ReactNode;
  render: (row: T, index: number) => ReactNode;
  align?: 'left' | 'right';
  mono?: boolean;
  title?: string;
  sortDirection?: 'ascending' | 'descending' | 'none';
  className?: string;
}

interface Props<T> {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string | number;
  empty?: ReactNode;
  loading?: boolean;
  onRowClick?: (row: T) => void;
  footer?: ReactNode;
}

export function Table<T>({ columns, rows, rowKey, empty, loading, onRowClick, footer }: Props<T>) {
  const cellClass = (column: Column<T>) =>
    [column.align === 'right' ? 'num' : '', column.mono ? 'mono' : '', column.className ?? ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Data table; scroll horizontally to see all columns">
      <table className="table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} className={[column.align === 'right' ? 'num' : '', column.className ?? ''].filter(Boolean).join(' ') || undefined} title={column.title} aria-sort={column.sortDirection}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && rows.length === 0
            ? Array.from({ length: 3 }, (_, i) => (
                <tr key={`skel-${i}`}>
                  {columns.map((column) => (
                    <td key={column.key}>
                      <Skeleton width="70%" height={12} />
                    </td>
                  ))}
                </tr>
              ))
            : null}
          {!loading && rows.length === 0 ? (
            <tr>
              <td className="empty" colSpan={columns.length}>
                {empty ?? 'Nothing to show.'}
              </td>
            </tr>
          ) : null}
          {rows.map((row, index) => (
            <tr key={rowKey(row)} className={onRowClick ? 'clickable' : undefined} onClick={onRowClick ? () => onRowClick(row) : undefined}>
              {columns.map((column) => (
                <td key={column.key} className={cellClass(column)}>
                  {column.render(row, index)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer ? <tfoot>{footer}</tfoot> : null}
      </table>
    </div>
  );
}
