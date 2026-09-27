import type {CSSProperties, JSX} from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import styles from './ecosystem.module.css';
import {ArrowRight, Button, FinalCta, PageHero, Section, SectionHeader} from '../components/ui';

type EcosystemProject = {
  name: string;
  href: string;
  category: string;
  oneLiner: string;
  description: string;
  glyph: string;
  status: string;
  color: string;
  colorSoft: string;
  logo?: string;
  theme: 'stats' | 'scan' | 'diem' | 'market';
};

type Resource = {
  title: string;
  href: string;
  body: string;
  cta: string;
};

const resources: Resource[] = [
  {
    title: 'Network Explorer',
    href: 'https://antseedstats.com/network',
    body: 'Watch live providers, market prices, usage, and routing activity across the Antseed network.',
    cta: 'Explore network',
  },
  {
    title: 'Developer Docs',
    href: '/docs',
    body: 'Use Antseed as peer-to-peer AI infrastructure from apps, agents, routers, and existing tools.',
    cta: 'Read docs',
  },
  {
    title: 'Provider Hub',
    href: '/providers',
    body: 'Launch a differentiated AI service, managed product, agent, router, or inference provider.',
    cta: 'Become a provider',
  },
];

const projects: EcosystemProject[] = [
  {
    name: 'Diem Antseed',
    href: 'https://diemantseed.com',
    category: 'Capacity program',
    oneLiner: 'A DIEM provider capacity program built around Antseed.',
    description:
      'Lock DIEM to participate in provider capacity on Antseed, with allocations and incentives governed by program rules.',
    glyph: 'DA',
    status: 'Live',
    color: '#e8a33d',
    colorSoft: 'rgba(232, 163, 61, 0.2)',
    theme: 'diem',
  },
  {
    name: 'AntSeedStats',
    href: 'https://antseedstats.com',
    category: 'Analytics',
    oneLiner: 'The metrics and intelligence layer of the Antseed ecosystem.',
    description:
      'Real-time onchain data for active users, network revenue, providers, buyers, models, staking, DIEM, $ANTS, channels, and transactions.',
    glyph: '🐜',
    status: 'Live',
    color: '#84cc16',
    colorSoft: 'rgba(132, 204, 22, 0.18)',
    logo: 'https://antseedstats.com/icon.png?cc9996558aa48202',
    theme: 'stats',
  },
  {
    name: 'Antscan',
    href: 'https://antscan.co/',
    category: 'Explorer',
    oneLiner: 'An Antseed explorer for Base settlements, service offers, channels, and emissions.',
    description:
      'Explore daily active users, settled volume, service offers, payment channels, providers, buyers, epochs, and ANTS emissions.',
    glyph: 'AN',
    status: 'Live',
    color: '#1fd87a',
    colorSoft: 'rgba(31, 216, 122, 0.18)',
    logo: 'https://antscan.co/logos/antseed-public-ant.svg',
    theme: 'scan',
  },
  {
    name: 'lANTS Market',
    href: 'https://lants.eth.limo',
    category: 'Marketplace',
    oneLiner: 'A board and USDC market for lANTS staking positions on Antseed.',
    description:
      'Browse every lANTS position — amount, lock, provider pool, weight, exit penalty, and pending reward — then list or buy it through a non-custodial, USDC-only contract priced per locked ANTS. Community-built, not an official Antseed product.',
    glyph: 'lA',
    status: 'Live',
    color: '#c2f04a',
    colorSoft: 'rgba(194, 240, 74, 0.18)',
    theme: 'market',
  },
];

const pillars = [
  {
    title: 'Applications',
    body: 'Products that turn Antseed providers into user-facing AI workflows.',
  },
  {
    title: 'Infrastructure',
    body: 'Explorers, routers, gateways, dashboards, and services that make the network easier to use.',
  },
  {
    title: 'Providers',
    body: 'Independent operators serving differentiated AI capabilities, agents, TEE services, or managed products.',
  },
  {
    title: 'Integrations',
    body: 'Tools and frameworks that connect existing developer workflows to the local Antseed endpoint.',
  },
];

function ResourceCard({resource}: {resource: Resource}) {
  const isExternal = resource.href.startsWith('http');
  const content = (
    <>
      <h3>{resource.title}</h3>
      <p>{resource.body}</p>
      <span>{resource.cta}<ArrowRight size={16} /></span>
    </>
  );

  if (isExternal) {
    return <a href={resource.href} target="_blank" rel="noopener noreferrer" className={styles.resourceCard}>{content}</a>;
  }
  return <Link to={resource.href} className={styles.resourceCard}>{content}</Link>;
}

function ProductPreview({project}: {project: EcosystemProject}) {
  if (project.theme === 'stats') {
    return (
      <div className={`${styles.preview} ${styles.previewStats}`}>
        <div className={styles.previewTop}><span>🐜 AntSeedStats</span><i>Overview</i></div>
        <div className={styles.statsGrid}>
          <div><small>Total users</small><strong>1,084</strong></div>
          <div><small>Revenue</small><strong>$194.29k</strong></div>
          <div><small>Tokens</small><strong>94.44B</strong></div>
          <div><small>Providers</small><strong>166</strong></div>
        </div>
        <div className={styles.chartBars}><span /><span /><span /><span /><span /></div>
      </div>
    );
  }

  if (project.theme === 'scan') {
    return (
      <div className={`${styles.preview} ${styles.previewScan}`}>
        <div className={styles.previewTop}><span>Antscan</span><i>Base</i></div>
        <div className={styles.searchMock}>Search address, tx, channel…</div>
        <div className={styles.scanRows}>
          <span><b>settle</b><em>$2.32k</em></span>
          <span><b>channel</b><em>0x058a…49f6</em></span>
          <span><b>epoch</b><em>#15</em></span>
        </div>
      </div>
    );
  }

  if (project.theme === 'market') {
    return (
      <div className={`${styles.preview} ${styles.previewStats}`}>
        <div className={styles.previewTop}><span>lANTS Market</span><i>Base</i></div>
        <div className={styles.statsGrid}>
          <div><small>Settles in</small><strong>USDC</strong></div>
          <div><small>Market fee</small><strong>1%</strong></div>
          <div><small>Custody</small><strong>None</strong></div>
          <div><small>License</small><strong>MIT</strong></div>
        </div>
        <div className={styles.chartBars}><span /><span /><span /><span /><span /></div>
      </div>
    );
  }

  return (
    <div className={`${styles.preview} ${styles.previewDiem}`}>
      <div className={styles.diemBrand}><span>Antseed</span><b>DIEM</b></div>
      <div className={styles.diemPanel}>
        <small>Provider capacity</small>
        <strong>Lock DIEM</strong>
        <div><span style={{width: '72%'}} /></div>
      </div>
      <div className={styles.diemPills}><span>Capacity</span><span>$ANTS</span><span>USDC</span></div>
    </div>
  );
}

function ProjectCard({project}: {project: EcosystemProject}) {
  const projectStyle = {
    '--project-color': project.color,
    '--project-color-soft': project.colorSoft,
  } as CSSProperties;

  return (
    <a href={project.href} target="_blank" rel="noopener noreferrer" className={styles.card} style={projectStyle}>
      <div className={styles.cardVisual}>
        <ProductPreview project={project} />
      </div>
      <div className={styles.cardBody}>
        <p className={styles.cardCategory}>{project.category}</p>
        <h3 className={styles.cardTitle}>{project.name}</h3>
        <p className={styles.cardLine}>{project.oneLiner}</p>
        <p className={styles.cardDescription}>{project.description}</p>
      </div>
      <div className={styles.cardFooter}>
        <span className={styles.cardUrl}>{new URL(project.href).hostname}</span>
        <span className={styles.cardArrow}>Learn more<ArrowRight size={18} /></span>
      </div>
    </a>
  );
}

export default function Ecosystem(): JSX.Element {
  return (
    <Layout
      title="Ecosystem"
      description="Explore projects, explorers, dashboards, and applications built on top of Antseed.">
      <PageHero
        kicker="Ecosystem"
        title="Explore the Antseed ecosystem"
        lead="Connect with builders, providers, explorers, and AI-focused projects growing around peer-to-peer AI infrastructure.">
        <Button href="https://antseedstats.com/network" arrow>Explore live network</Button>
        <Button to="/docs" variant="ghost">Build on Antseed</Button>
      </PageHero>

      <Section width="xl">
        <div className={styles.sectionHead}>
          <SectionHeader
            kicker="Discover Antseed ecosystem"
            title="Live projects"
            lead="A directory of applications, tools, and infrastructure built on or around Antseed."
          />
        </div>
        <div className={styles.grid}>
          {projects.map((project) => (
            <ProjectCard key={project.href} project={project} />
          ))}
        </div>
      </Section>

      <Section tone="tinted" width="xl">
        <div className={styles.introGrid}>
          <div className={styles.introCopy}>
            <SectionHeader
              kicker="Build, explore, connect"
              title="An AI-first market for builders"
              lead="Antseed gives projects a local API surface, open provider marketplace, and onchain payments so teams can build products on top of independent AI supply."
            />
          </div>
          <div className={styles.resourceGrid}>
            {resources.map((resource) => (
              <ResourceCard key={resource.title} resource={resource} />
            ))}
          </div>
        </div>
      </Section>

      <Section tone="tinted" width="xl">
        <div className={styles.sectionHead}>
          <SectionHeader
            kicker="Ecosystem pillars"
            title="Where builders can plug in"
            lead="From dashboards to managed AI products, the network expands when each layer gets easier to discover and use."
          />
        </div>
        <div className={styles.pillarGrid}>
          {pillars.map((pillar) => (
            <div key={pillar.title} className={styles.pillarCard}>
              <h3>{pillar.title}</h3>
              <p>{pillar.body}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section>
        <div className={styles.bottomBlock}>
          <div>
            <h3>Ecosystem amplification</h3>
            <p>
              Building an app, explorer, provider, agent, router, or managed product on Antseed? Share it with the community and we can add it to this directory.
            </p>
          </div>
          <div>
            <h3>Submission guidelines</h3>
            <p>
              Projects should add value on top of Antseed infrastructure. Raw API-key resale and subscription credential sharing do not belong in the ecosystem.
            </p>
          </div>
        </div>
        <div className={styles.disclosure}>
          <p>
            * Ecosystem listings are for discovery only and do not represent endorsement, sponsorship, verification, or approval by Antseed. Review each project independently before using it.
          </p>
        </div>
      </Section>

      <FinalCta
        title="Build, learn, and grow with Antseed"
        sub="Use the docs, connect your tools, or launch a provider to help expand the peer-to-peer AI network."
        note={
          <>
            <Link to="/docs">Docs</Link>
            <Link to="/integrations">Integrations</Link>
            <a href="https://t.me/antseed" target="_blank" rel="noopener noreferrer">Telegram</a>
          </>
        }>
        <Button to="/docs" variant="white" size="lg" arrow>Explore resources</Button>
        <Button to="/providers" variant="light" size="lg">Become a provider</Button>
      </FinalCta>
    </Layout>
  );
}
