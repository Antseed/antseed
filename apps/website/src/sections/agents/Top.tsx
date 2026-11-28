import type {JSX} from 'react';
import {Button} from '../../components';
import {AUDIENCE_OFFER, FirstScreen} from '../../parts/FirstScreen';
import {CommandChip, JOIN_BUYER_SKILL_COMMAND} from '../../parts/CommandChip';

/** The first screen: give your agent the skill. */
export default function Top(): JSX.Element {
  return (
    <FirstScreen
      cmp="agents/top"
      titleId="agents-title"
      {...AUDIENCE_OFFER}
      fluidPhoneTitle
      eyebrow="For agents"
      title={['Run agents freely,', 'for way less.']}
      sub="Hermes, OpenClaw, Codex, OpenCode, or your own. Your agent installs Antseed itself from one skill and runs on the open market."
      actions={<>
        <CommandChip command={JOIN_BUYER_SKILL_COMMAND} />
        <Button href="/docs/install/" variant="ghost" size="page">Install the CLI</Button>
      </>}
      note="Give your agent the skill. Free models to start, no account, no API key."
      painting={{
        day: '/site/assets/colony/many-day.webp',
        night: '/site/assets/colony/many-night.webp',
        focus: '62% 50%',
        label: 'Ants tend rows of small computers linked by cables across a meadow.',
      }}
    />
  );
}
