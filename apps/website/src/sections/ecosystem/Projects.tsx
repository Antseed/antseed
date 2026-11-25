import type {JSX} from 'react';
import {Section, SectionHead} from '../../components';
import ListingCard from './ListingCard';
import YourProjectPanel from './YourProjectPanel';
import {PROJECTS} from './directory';
import styles from './Ecosystem.module.css';

/** The directory of live projects, an open card for the visitor's own, and the listing rules. */
export default function Projects(): JSX.Element {
  return (
    <Section cmp="ecosystem/projects" id="projects" labelledBy="projects-title" className={styles.section} railClassName={styles.rail} pad="y">
      <SectionHead
        padX
        className={styles.head}
        titleClassName={styles.title}
        subClassName={styles.sub}
        eyebrow="Discover Antseed ecosystem"
        title={['Live', 'projects.']}
        id="projects-title"
        sub="A directory of applications, tools, and infrastructure built on or around Antseed."
      />
      <div className={styles.grid}>
        {PROJECTS.map((p) => <ListingCard key={p.href} href={p.href} name={p.name} line={p.line} shot={{src: p.shot, alt: p.alt}} />)}
        <ListingCard
          href="https://t.me/antseed"
          name="Ecosystem amplification."
          line="Building on Antseed? Share it with the community and we can add it to this directory."
          panel={<YourProjectPanel />}
        />
      </div>
      <div className={styles.notes}>
        <p className={styles.note}><b>Submission guidelines.</b> Projects should add value on top of Antseed infrastructure. Raw API-key resale and subscription credential sharing do not belong in the ecosystem.</p>
        <p className={styles.note}>* Ecosystem listings are for discovery only and do not represent endorsement, sponsorship, verification, or approval by Antseed. Review each project independently before using it.</p>
      </div>
    </Section>
  );
}
