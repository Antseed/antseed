import type {JSX} from 'react';
import {Section, SectionHead} from '../../components';
import {Point, PointsRow} from '../../parts/PointsRow';
import {CommandChip, JOIN_BUYER_SKILL_COMMAND} from '../../parts/CommandChip';
import styles from './Skill.module.css';

/** The four steps in skills/join-buyer/SKILL.md, which the command installs (and /skill.md serves). */
const STEPS = [
  {title: 'Install', text: 'Installs the Antseed CLI on the machine the agent runs on.'},
  {title: 'Start', text: 'Starts your local endpoint. No account, no API key.'},
  {title: 'Fund', text: 'Shows you where to top up for paid models. Free models need nothing.'},
  {title: 'Run', text: 'Points itself at the endpoint and picks a model. Every call goes to the best provider.'},
] as const;

/** What the skill does: its four steps in a row, and the command that installs it. */
export default function Skill(): JSX.Element {
  return (
    <Section cmp="agents/skill" id="skill" labelledBy="skill-title" railClassName={styles.rail}>
      <SectionHead
        id="skill-title"
        title="What the skill does."
        sub="One file your agent reads. It handles the setup and tells you when it needs you."
        padX
        className={styles.head}
      />
      <PointsRow rise className={styles.steps}>
        {STEPS.map((s, i) => (
          <Point key={s.title} className={styles.step}>
            <span className={styles.number}>{i + 1}</span>
            <h3 className={styles.name}>{s.title}</h3>
            <p className={styles.text}>{s.text}</p>
          </Point>
        ))}
      </PointsRow>
      <div className={styles.command} data-rv=""><CommandChip command={JOIN_BUYER_SKILL_COMMAND} /></div>
    </Section>
  );
}
