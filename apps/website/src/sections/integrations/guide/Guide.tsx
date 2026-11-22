import type {JSX} from 'react';
import {Section} from '../../../components';
import {Ticks} from '../../../parts/Ticks';
import {CodeBlock} from '../../../parts/CodeBlock';
import {JOIN_BUYER_SKILL_COMMAND} from '../../../parts/CommandChip';
import type {Integration} from '../../../integrations/integrations';
import {RunFirst} from './runFirst/RunFirst';
import {GuideSection} from './GuideSection';
import {ConfigList, StepList} from './Steps';
import {WireFormat} from './WireFormat';
import styles from './Guide.module.css';

const LIVE_NETWORK = 'https://antseedstats.com/network';

function ModelPick({integration: i}: {integration: Integration}): JSX.Element | null {
  if (!i.modelHints) return null;
  return (
    <GuideSection id="model" eyebrow="Step 3" title="Pick a model">
      <ul className={styles.models}>
        {i.modelHints.suggested.map((m) => <li key={m}><code>{m}</code></li>)}
      </ul>
      {i.modelHints.note && <p className={styles.para}><Ticks>{i.modelHints.note}</Ticks></p>}
      <p className={styles.para}>
        The full list is every model on the network. Run <code>GET /v1/models</code> on your endpoint, <code>antseed network browse</code>,
        or open the <a href={LIVE_NETWORK} target="_blank" rel="noopener noreferrer">live network page</a> to see what's available right
        now.
      </p>
    </GuideSection>
  );
}

/** The guide itself: the shared setup, then this tool's steps, its wire format, fixes and references. */
export function Guide({integration: i}: {integration: Integration}): JSX.Element {
  const hasInstall = i.install.length > 0;
  return (
    <Section cmp="integration/guide" label={`${i.name} setup guide`} railClassName={styles.rail} pad="x">
      <div className={styles.column}>
        <RunFirst />
        {i.prereqs && i.prereqs.length > 0 && (
          <GuideSection id="prerequisites" eyebrow="Before you start" title="Prerequisites">
            <ul className={styles.bullets}>{i.prereqs.map((p, idx) => <li key={idx}><Ticks>{p}</Ticks></li>)}</ul>
          </GuideSection>
        )}
        {hasInstall && (
          <GuideSection id="install" eyebrow="Step 1" title={`Install ${i.name}`}>
            <StepList steps={i.install} />
          </GuideSection>
        )}
        <GuideSection id="configure" eyebrow={hasInstall ? 'Step 2' : 'Step 1'} title={`Point ${i.name} at Antseed`}>
          <ConfigList blocks={i.configure} />
        </GuideSection>
        <ModelPick integration={i} />
        {i.test && i.test.length > 0 && (
          <GuideSection id="test" eyebrow="Verify" title="Test it">
            <StepList steps={i.test} />
          </GuideSection>
        )}
        <WireFormat integration={i} />
        {i.troubleshooting && i.troubleshooting.length > 0 && (
          <GuideSection id="troubleshooting" eyebrow="If it goes wrong" title="Troubleshooting">
            <dl className={styles.fixes}>
              {i.troubleshooting.map((t, idx) => (
                <div key={idx} className={styles.fix}>
                  <dt><Ticks>{t.problem}</Ticks></dt>
                  <dd><Ticks>{t.fix}</Ticks></dd>
                </div>
              ))}
            </dl>
          </GuideSection>
        )}
        {i.caveats && i.caveats.length > 0 && (
          <GuideSection id="caveats" eyebrow="Heads up" title="Caveats">
            <ul className={styles.bullets}>{i.caveats.map((c, idx) => <li key={idx}><Ticks>{c}</Ticks></li>)}</ul>
          </GuideSection>
        )}
        {i.links && i.links.length > 0 && (
          <GuideSection id="links" eyebrow="Reference" title="Links">
            <ul className={styles.links}>
              {i.links.map((l) => <li key={l.href}><a href={l.href} target="_blank" rel="noopener noreferrer">{l.label} ↗</a></li>)}
            </ul>
          </GuideSection>
        )}
        {i.agentSummary && (
          <GuideSection id="for-agents" eyebrow="For agents" title="Give your agent the skill">
            <p className={styles.para}><Ticks>{i.agentSummary}</Ticks></p>
            <CodeBlock code={i.agentSkill ?? JOIN_BUYER_SKILL_COMMAND} />
          </GuideSection>
        )}
      </div>
    </Section>
  );
}
