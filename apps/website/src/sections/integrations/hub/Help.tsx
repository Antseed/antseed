import type {JSX} from 'react';
import Link from '@docusaurus/Link';
import {Section} from '../../../components';
import {Point, PointCaption, PointsRow} from '../../../parts/PointsRow';
import styles from './Help.module.css';

const CATALOG_SOURCE = 'https://github.com/Antseed/antseed/blob/main/apps/website/src/integrations/integrations.ts';

/** For a tool that isn't listed, and for builders. */
export default function Help(): JSX.Element {
  return (
    <Section cmp="integrations/help" label="More tools" className={styles.help}>
      <PointsRow className={styles.row}>
        <Point className={styles.point}>
          <PointCaption name="Don’t see your tool?" className={styles.caption}>
            If it accepts an Anthropic or OpenAI base URL, Antseed already works with it: the{' '}
            <Link to="/integrations/curl/">raw HTTP guide</Link> has the contract. To list it here, open a PR on{' '}
            <a href={CATALOG_SOURCE} target="_blank" rel="noopener noreferrer">integrations.ts</a>.
          </PointCaption>
        </Point>
        <Point className={styles.point}>
          <PointCaption name="Building an integration?" className={styles.caption}>
            Read the <Link to="/docs/api/">API guide</Link>, give your agent{' '}
            <a href="/skill.md">the skill</a>, and ping us on{' '}
            <a href="https://t.me/antseed" target="_blank" rel="noopener noreferrer">Telegram</a> for partner verification.
          </PointCaption>
        </Point>
      </PointsRow>
    </Section>
  );
}
