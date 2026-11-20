import type {CSSProperties, JSX} from 'react';
import {Actions, Button, DuoHead, Heading, Sub, type Title} from '../../../components';
import {EyebrowLink} from '../../../parts/EyebrowLink';
import {FeatureList, type Feature} from '../../../parts/FeatureList';
import styles from './ProductCopy.module.css';

export type ProductLink = {label: string; href: string};

type Props = {
  eyebrow: ProductLink;
  titleId: string;
  title: Title;
  sub: string;
  /** Where the sub line breaks on wide screens. */
  subWidth: number;
  features: readonly Feature[];
  primary: ProductLink;
  secondary: ProductLink;
};

/** A product's text column: eyebrow link, two-line title, sub line, features and its two buttons (on a phone, Learn more only). */
export function ProductCopy({eyebrow, titleId, title, sub, subWidth, features, primary, secondary}: Props): JSX.Element {
  return (
    <>
      <EyebrowLink to={eyebrow.href}>{eyebrow.label}</EyebrowLink>
      <div data-rv="">
        <DuoHead>
          <Heading as="h2" id={titleId} title={title} secondLine="break" strong />
          <Sub style={{'--sub-max': `${subWidth}px`} as CSSProperties}>{sub}</Sub>
        </DuoHead>
      </div>
      <FeatureList items={features} />
      <Actions fill reveal className={styles.actions}>
        <Button href={primary.href} className={styles.primary}>{primary.label}</Button>
        <Button href={secondary.href} variant="ghost">{secondary.label}</Button>
      </Actions>
    </>
  );
}
