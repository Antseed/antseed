import type {JSX} from 'react';
import {Button} from '../../components';
import {AUDIENCE_OFFER, FirstScreen} from '../../parts/FirstScreen';
import {DownloadButton} from '../../parts/DownloadButton/DownloadButton';
import {GlassCard} from '../../parts/Glass/GlassCard';
import {SEES_ROWS} from './seesRows';
import styles from './Top.module.css';
import {PAINTINGS} from '../../lib/paintings';

const TEE_ROWS = SEES_ROWS.map((r) => ({term: r.label, value: r.tee}));

/** The first screen: no account, no email; on the painting, what a TEE-verified provider sees. */
export default function Top(): JSX.Element {
  return (
    <FirstScreen
      cmp="privacy/top"
      titleId="privacy-title"
      {...AUDIENCE_OFFER}
      eyebrow="For privacy"
      title={['So private, we have', 'no idea who you are.']}
      sub="No account. No email. Your identity stays private and with a TEE-verified provider, so does your prompt."
      actions={<>
        <DownloadButton />
        <Button href="/docs/install/" variant="ghost">Install the CLI&nbsp;→</Button>
      </>}
      note="Free models to start. Install, point your tool at it, done."
      painting={{
        ...PAINTINGS.shore,
        focus: '70% 50%',
        label: 'A quiet shore with dune grass under a pale sky.',
      }}>
      <GlassCard title="TEE-verified provider" rows={TEE_ROWS} center className={styles.card} />
    </FirstScreen>
  );
}
