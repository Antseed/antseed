import type {JSX} from 'react';
import {Button} from '../../../components';
import {FirstScreen} from '../../../parts/FirstScreen';
import {PAINTINGS} from '../../../lib/paintings';

/** The offer beside a quiet shore in watercolour. */
export default function Top(): JSX.Element {
  return (
    <FirstScreen
      cmp="integrations/top"
      titleId="integrations-title"
      eyebrow="Integrations"
      title={['One endpoint.', 'Every tool you already use']}
      titleSize="tight"
      sub="Your Antseed gateway gives each tool its own API key, from your computer, a server or a tunnel. It is OpenAI and Anthropic compatible and translates between the two on the fly. Pick your tool below."
      actions={<>
        <Button href="/docs/quickstart/" size="page">Run a gateway</Button>
        {/* pathname:// keeps the router out of it: the skill is a static file */}
        <Button href="pathname:///skill.md" variant="ghost" size="page">Read the skill</Button>
      </>}
      fillActions
      painting={{
        ...PAINTINGS.shore,
        label: 'A watercolour shore: pale dunes and grasses before a calm sea',
      }}
    />
  );
}
