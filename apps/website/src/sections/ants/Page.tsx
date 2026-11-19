import type {JSX} from 'react';
import {SitePage} from '../../components';
import {Token} from './Token';
import {PointSection} from './PointSection';
import {POINTS} from './points';

/** /ants/: the ANTS token, its supply and provider pools. */
export default function Page(): JSX.Element {
  return (
    <SitePage
      title="ANTS details"
      description="Inference is the currency. ANTS makes it liquid.">
      <Token />
      {POINTS.map((p) => <PointSection key={p.id} point={p} />)}
    </SitePage>
  );
}
