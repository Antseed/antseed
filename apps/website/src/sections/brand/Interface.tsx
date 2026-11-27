import type {JSX} from 'react';
import {Actions, Button, Section, SectionHead} from '../../components';
import {Point, PointCaption, PointsRow} from '../../parts/PointsRow';
import styles from './Interface.module.css';

/** Radii nest from the outside in, each a step smaller (DESIGN.md). */
const RADII = [
  {name: 'Card', px: 11},
  {name: 'Button', px: 10},
  {name: 'Window', px: 8},
  {name: 'Control', px: 5},
] as const;

/** The interface's three constants: the buttons, the dot grid, the nested round corners. */
export default function Interface(): JSX.Element {
  return (
    <Section cmp="brand/interface" id="interface" labelledBy="interface-title" railClassName={styles.rail}>
      <SectionHead
        padX
        className={styles.head}
        eyebrow="Interface"
        id="interface-title"
        title={['Flat paper,', 'round dots.']}
        sub="A serious developer page: one white rail, generous space, numbers in monospace. Depth exists only where glass floats over a painting."
      />
      <PointsRow className={styles.row}>
        <Point className={styles.point}>
          <Actions className={styles.demo}>
            <Button href="/#desktop" size="page">Get Antseed Desktop</Button>
            <Button href="/docs/" variant="ghost" size="page">Learn more</Button>
          </Actions>
          <PointCaption name="One green button.">Everything else in the row is a ghost or a link. A verb and two or three words.</PointCaption>
        </Point>
        <Point className={styles.point}>
          <div className={styles.grid} aria-hidden="true" />
          <PointCaption name="Dots, never dashes.">A round 2px dot every 8px: the margins, the outlines, the paintings’ arrival. The dot is the ant.</PointCaption>
        </Point>
        <Point className={styles.point}>
          <ul className={styles.radii} aria-label="Corner radii">
            {RADII.map((r) => (
              <li key={r.name} className={styles.radius}>
                <span className={styles.corner} style={{borderTopLeftRadius: r.px}} aria-hidden="true" />
                {r.name} <code>{r.px}px</code>
              </li>
            ))}
          </ul>
          <PointCaption name="Round and nested.">Each corner a step smaller than the one around it. No sharp corners, no square pixels.</PointCaption>
        </Point>
      </PointsRow>
    </Section>
  );
}
