import type {JSX} from 'react';
import {Button} from '../../components';
import {AUDIENCE_OFFER, FirstScreen} from '../../parts/FirstScreen';
import {DownloadButton} from '../../parts/DownloadButton/DownloadButton';

/** The first screen: keep your coding app, lose the limits. */
export default function Top(): JSX.Element {
  return (
    <FirstScreen
      cmp="coding/top"
      titleId="coding-title"
      {...AUDIENCE_OFFER}
      eyebrow="For coding apps"
      title={['Coding,', 'without the usage limits.']}
      sub="Keep Claude Code, Codex, Cursor, or OpenCode. Point it at your local endpoint and pay a fraction of the plan price, with no hourly, weekly, or monthly limits."
      actions={<>
        <DownloadButton />
        <Button href="/docs/install/" variant="ghost">Install the CLI&nbsp;→</Button>
      </>}
      note="Free models to start. No account either way."
      painting={{
        day: '/site/assets/colony/join-day.webp',
        night: '/site/assets/colony/join-night.webp',
        focus: '30% 50%',
        label: 'Ants sit in a row at laptops on a bench in a meadow while another carries in one more.',
      }}
    />
  );
}
