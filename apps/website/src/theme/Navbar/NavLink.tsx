import type {CSSProperties, JSX, ReactNode} from 'react';
import Link from '@docusaurus/Link';
import {isExternal, type NavItem} from './links';

type Props = {
  item: NavItem;
  className?: string;
  style?: CSSProperties;
  /** Marks an external link with ↗ after its label. */
  arrow?: boolean;
  onClick?: () => void;
  children?: ReactNode;
};

/** A nav link: client-side routing inside the site, a new tab outside it. */
export default function NavLink({item, className, style, arrow = false, onClick, children}: Props): JSX.Element {
  if (isExternal(item.href)) {
    return (
      <a className={className} style={style} href={item.href} target="_blank" rel="noopener noreferrer" onClick={onClick}>
        {children ?? (arrow ? `${item.label} ↗` : item.label)}
      </a>
    );
  }
  return (
    <Link className={className} style={style} to={item.href} onClick={onClick}>
      {children ?? item.label}
    </Link>
  );
}
