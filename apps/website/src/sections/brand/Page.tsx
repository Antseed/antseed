import type {JSX} from 'react';
import {SitePage} from '../../components';
import Top from './Top';
import Logo from './Logo';
import Colour from './Colour';
import Type from './Type';
import Ant from './Ant';
import Examples from './Examples';
import Backgrounds from './Backgrounds';
import Prompt from './Prompt';
import End from './End';

const TITLE = 'Brand';
const DESCRIPTION = 'Antseed brand assets: the logo, the colours, the type, the ant, backgrounds and a watercolour prompt, ready to download.';

/** /brand/: the assets partners and press can use, one big asset per section. */
export default function Page(): JSX.Element {
  return (
    <SitePage title={TITLE} description={DESCRIPTION} cta={false}>
      <Top />
      <Logo />
      <Colour />
      <Type />
      <Ant />
      <Examples />
      <Backgrounds />
      <Prompt />
      <End />
    </SitePage>
  );
}
