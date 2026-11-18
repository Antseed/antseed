import type {JSX} from 'react';
import {Section, SectionHead} from '../../components';
import {PathCard} from './running/PathCard';
import {ModelsWindow} from './running/ModelsWindow';
import {RequestWindow} from './running/RequestWindow';
import styles from './Running.module.css';
import {PAINTINGS, type Painting} from '../../lib/paintings';


type Path = {title: string; text: string; painting: Painting; Scene: () => JSX.Element};

const PATHS: readonly Path[] = [
  {
    title: 'Set your own price.',
    text: 'You choose what to serve and the terms on which you offer it.',
    painting: PAINTINGS.birches,
    Scene: ModelsWindow,
  },
  {
    title: 'Serve incoming requests.',
    text: 'Requests that match your models and prices arrive and are served automatically.',
    painting: PAINTINGS.shore,
    Scene: RequestWindow,
  },
];

/** Running a provider: setting prices, then serving what the network routes in. */
export function Running(): JSX.Element {
  return (
    <Section cmp="providers/run" railClassName={styles.rail} labelledBy="providers-running-title">
      <SectionHead
        padX
        secondLine="inline"
        className={styles.head}
        titleClassName={styles.title}
        size="compact"
        eyebrow="Running your provider"
        id="providers-running-title"
        title={['You set the terms.', <span className={styles.second}>The network brings the requests.</span>]}
        sub="Choose what you serve and at what price. Requests that match your terms are routed to you and served automatically."
        subClassName={styles.sub}
      />
      <div className={styles.cards}>
        {PATHS.map(({title, text, painting, Scene}, i) => (
          <PathCard key={title} title={title} text={text} painting={painting} index={i}>
            <Scene />
          </PathCard>
        ))}
      </div>
    </Section>
  );
}
