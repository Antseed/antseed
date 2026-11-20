import type {JSX, ReactNode} from 'react';
import {Actions, Button, Duo, Heading, Sub, Wash} from '../components';
import {FeatureList, type Feature} from './FeatureList';
import {Terminal, type TerminalBlock} from './Terminal/Terminal';
import styles from './EndpointDuo.module.css';
import {PAINTINGS} from '../lib/paintings';
import {sectionTitleId} from '../lib/sectionTitleId';

export type EndpointCode = {
  blocks: readonly TerminalBlock[];
  status: string;
  /** Type the commands in when first seen (single-line commands). */
  typed?: boolean;
  label?: string;
};

type Props = {
  cmp: string;
  id?: string;
  title: readonly [string, string];
  lead: ReactNode;
  points: readonly Feature[];
  action: {label: string; href: string};
  code: EndpointCode;
};

const TAGLINE = 'ONE ENDPOINT · EVERY TOOL';

/** How a tool connects: the pitch and its points beside a terminal on a painting. */
export function EndpointDuo({cmp, id, title, lead, points, action, code}: Props): JSX.Element {
  const titleId = sectionTitleId(cmp);
  return (
    <Duo
      cmp={cmp}
      id={id}
      labelledBy={titleId}
      flip
      text={
        <>
          <div data-rv="">
            <div className={styles.head}>
              <Heading id={titleId} title={title} secondLine="break" strong />
              <Sub className={styles.lead}>{lead}</Sub>
            </div>
          </div>
          <FeatureList items={points} />
          <Actions reveal><Button href={action.href}>{action.label}</Button></Actions>
        </>
      }
      panel={
        <Wash unveil reveal="panel" className={styles.panel} {...PAINTINGS.river}>
          <Terminal blocks={code.blocks} status={code.status} tagline={TAGLINE} typed={code.typed} label={code.label} className={styles.terminal} />
        </Wash>
      }
    />
  );
}
