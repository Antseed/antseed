import type {JSX} from 'react';
import {Duo, DuoHead, Eyebrow, Heading, Sub, Wash} from '../../components';
import {FeatureList} from '../../parts/FeatureList';
import type {ArtPoint} from './art';
import styles from './ArtSection.module.css';

/** One part of the brand's friendly half, its rules beside a painting. */
export function ArtSection({point}: {point: ArtPoint}): JSX.Element {
  const titleId = `brand-${point.id}-title`;
  return (
    <Duo
      cmp={point.cmp}
      id={point.id}
      flip={point.flip}
      labelledBy={titleId}
      className={styles.section}
      panel={<Wash unveil reveal="panel" className={styles.panel} {...point.painting} />}
      text={
        <>
          <div data-rv="">
            <DuoHead>
              <Eyebrow>{point.eyebrow}</Eyebrow>
              <Heading id={titleId} secondLine="break" title={point.title} />
              <Sub>{point.sub}</Sub>
            </DuoHead>
          </div>
          <FeatureList items={point.features} />
        </>
      }
    />
  );
}
