import type {JSX} from 'react';
import {HeadBeside} from '../../parts/HeadBeside';
import {LinkRows, type LinkRow} from '../../parts/LinkRows';
import {PixelIcon} from '../../parts/PixelIcon';

const PLACES: readonly LinkRow[] = [
  {name: 'On your computer', text: 'Try the gateway locally while you build.', action: 'Start locally', href: '/docs/quickstart/#on-your-computer', mark: <PixelIcon name="laptop" />},
  {name: 'On a server', text: 'Run your production gateway with HTTPS.', action: 'Set up a server', href: '/docs/gateway/server/', mark: <PixelIcon name="server" />},
];

/** Where the gateway runs: on your computer while you build, or on a server. */
export default function Setup(): JSX.Element {
  return (
    <HeadBeside cmp="apps/setup" id="run" titleId="run-title" title="Set Up Gateway" sub="Start on your computer or deploy on a server.">
      <LinkRows rows={PLACES} />
    </HeadBeside>
  );
}
