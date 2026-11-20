import type {JSX} from 'react';
import {Intro, SitePage} from '../../components';
import Top from './Top';
import Logo from './Logo';
import Colour from './Colour';
import Type from './Type';
import {ArtSection} from './ArtSection';
import Interface from './Interface';
import Voice from './Voice';
import {ART} from './art';

const TITLE = 'Brand';
const DESCRIPTION = 'The Antseed brand: the logo and its files, the colours by day and night, the type, the watercolour paintings and the ant.';

/** /brand/: the media kit and the brand at a glance. */
export default function Page(): JSX.Element {
  return (
    <SitePage
      title={TITLE}
      description={DESCRIPTION}>
      <Top />
      <Intro
        cmp="brand/intro"
        label="The brand"
        eyebrow="Two halves"
        lede="Picture the spec sheet of a peer-to-peer network printed on watercolour paper."
        more={['One white rail, titles in a face made of dots, numbers in monospace and one green button. The pictures are small, sparse watercolour landscapes, and a single round ant lives in them, a little lost, carrying things.']}
      />
      <Logo />
      <Colour />
      <Type />
      {ART.map((point) => <ArtSection key={point.id} point={point} />)}
      <Interface />
      <Voice />
    </SitePage>
  );
}
