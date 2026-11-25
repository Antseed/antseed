import type {JSX} from 'react';
import {Actions, Button, Duo, DuoHead, Heading, Sub, Wash} from '../../components';
import {EyebrowLink} from '../../parts/EyebrowLink';
import {FeatureList} from '../../parts/FeatureList';
import type {TokenPoint} from './points';
import styles from './PointSection.module.css';

/** One point about the token: its text and features beside a painting. */
export function PointSection({point}: {point: TokenPoint}): JSX.Element {
  const titleId = `ants-${point.id}-title`;
  const [primary, secondary] = point.actions;
  return (
    <Duo
      cmp={point.cmp}
      id={point.id}
      flip={point.flip}
      labelledBy={titleId}
      className={styles.section}
      railClassName={styles.rail}
      textClassName={styles.text}
      panel={<Wash unveil reveal="panel" className={styles.panel} day={point.painting.day} night={point.painting.night} label={point.painting.label} />}
      text={
        <>
          <EyebrowLink to={point.eyebrow.href} className={styles.eyebrow}>{point.eyebrow.label}</EyebrowLink>
          <div data-rv="">
            <DuoHead className={styles.head}>
              <Heading id={titleId} strong secondLine="break" title={point.title} />
              <Sub className={styles.sub}>{point.sub}</Sub>
            </DuoHead>
          </div>
          <FeatureList items={point.features} />
          <Actions fill reveal className={styles.actions}>
            <Button href={primary.href} size="page">{primary.label}</Button>
            <Button href={secondary.href} variant="ghost" size="page">{secondary.label}</Button>
          </Actions>
        </>
      }
    />
  );
}
