import type {JSX} from 'react';
import clsx from 'clsx';
import NavLink from './NavLink';
import {GATEWAY} from './links';
import styles from './NavCta.module.css';

export function GatewayCta({className, onClick}: {className?: string; onClick?: () => void}): JSX.Element {
  return <NavLink item={GATEWAY} onClick={onClick} className={clsx(styles.gateway, className)} />;
}
