import type {JSX, ReactNode} from 'react';
import styles from './products/Products.module.css';

/** The product sections (Gateway, Desktop) stacked 120px apart, the rail's surface running on between them and under the last. */
export default function Products({children}: {children: ReactNode}): JSX.Element {
  return <div className={styles.products}>{children}</div>;
}
