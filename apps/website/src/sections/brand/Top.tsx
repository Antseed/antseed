import type {JSX} from 'react';
import {Button} from '../../components';
import {FirstScreen} from '../../parts/FirstScreen';
import {BRAND_KIT} from './logos';
import {PAINTINGS} from '../../lib/paintings';

/** The brand page's first screen, beside a meadow in watercolour. */
export default function Top(): JSX.Element {
  return (
    <FirstScreen
      cmp="brand/top"
      titleId="brand-title"
      eyebrow="Brand"
      title={['The Antseed brand', 'at a glance']}
      sub="The logo, the colours, the type, the paintings and the ant: what they are and how to use them. The logo files are free to download."
      actions={<>
        {/* pathname:// keeps the router out of it: the kit is a static file */}
        <Button href={`pathname://${BRAND_KIT}`} size="page">Download the logo</Button>
        <Button href="#colour" variant="ghost" size="page">See the colours</Button>
      </>}
      fillActions
      painting={{
        ...PAINTINGS.poppies,
        label: 'A watercolour meadow of poppies and daisies before soft, pale hills',
      }}
    />
  );
}
