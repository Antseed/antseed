import {useRef, type JSX} from 'react';
import clsx from 'clsx';
import {Duo, Wash} from '../../components';
import type {Feature} from '../../parts/FeatureList';
import {ProductCopy} from './products/ProductCopy';
import {DesktopApp} from './desktop/DesktopApp';
import {usePlayOnView} from '../../lib/usePlayOnView';
import styles from './desktop/Desktop.module.css';
import {PAINTINGS} from '../../lib/paintings';

const FEATURES: readonly Feature[] = [
  {icon: 'blocks', text: <>Pick any model at the best available price,<br /> or start free</>},
  {icon: 'plug', text: <>Connect Claude Code, Codex, OpenCode<br /> and your other apps</>},
  {icon: 'lock', text: <>Go Private and providers can&apos;t read your chats</>},
  {icon: 'analytics', text: <>Stake ANTS and manage your rewards, right in the app.</>},
];

/** Antseed Desktop: the app playing its loop over a painting, beside the pitch. */
export default function Desktop(): JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  const pending = usePlayOnView(stageRef);   // the window rises in once a third of the panel is seen
  return (
    <Duo
      cmp="home/desktop"
      id="desktop"
      labelledBy="desktop-title"
      flip
      className={styles.desktop}
      railClassName={styles.rail}
      textClassName={styles.text}
      text={
        <ProductCopy
          eyebrow={{label: 'Antseed Desktop', href: '/docs/desktop/'}}
          titleId="desktop-title"
          title={['Ask anything,', 'on any model.']}
          sub="Antseed runs on your computer. Your chat, your agents and your apps all go through it."
          subWidth={404}
          features={FEATURES}
          primary={{label: 'Get Antseed Desktop', href: 'https://github.com/Antseed/antseed/releases/latest'}}
          secondary={{label: 'Learn more', href: '/docs/desktop/'}}
        />
      }
      panel={
        <Wash unveil reveal="panel" {...PAINTINGS.clover}>
          <div ref={stageRef} className={clsx(styles.stage, pending && styles.pending)}>
            <DesktopApp className={styles.window} />
          </div>
        </Wash>
      }
    />
  );
}
