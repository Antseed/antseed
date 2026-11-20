import type {JSX} from 'react';
import {SitePage} from '../../components';
import Top from './Top';
import Projects from './Projects';
import Build from './Build';
import Pillars from './Pillars';
import Close from './Close';
import styles from './Page.module.css';

const TITLE = 'Ecosystem';
const DESCRIPTION = 'Explore projects, explorers, dashboards, and applications built on top of Antseed.';

/** /ecosystem/: the directory of projects built on Antseed, and where builders start. */
export default function Page(): JSX.Element {
  return (
    <SitePage
      title={TITLE}
      description={DESCRIPTION}
      className={styles.page}>
      <Top />
      <Projects />
      <Build />
      <Pillars />
      <Close />
    </SitePage>
  );
}
