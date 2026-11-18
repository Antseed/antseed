import type {JSX} from 'react';
import {CodeBlock} from '../../../parts/CodeBlock';
import {Ticks} from '../../../parts/Ticks';
import type {ConfigBlock, Step} from '../../../integrations/integrations';
import styles from './Guide.module.css';

const toExports = (vars: Record<string, string>) => Object.entries(vars).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join('\n');

/** The paragraph under a step or a config block. */
export function Note({text}: {text?: string}): JSX.Element | null {
  return text ? <p className={styles.note}><Ticks>{text}</Ticks></p> : null;
}

export function StepList({steps}: {steps: readonly Step[]}): JSX.Element {
  return (
    <ol className={styles.steps}>
      {steps.map((s, i) => (
        <li key={i} className={styles.step}>
          <p className={styles.stepLabel}><Ticks>{s.label}</Ticks></p>
          {s.command && <CodeBlock code={s.command} />}
          {s.output && <CodeBlock output label={s.outputLabel ?? 'Example output'} code={s.output} />}
          <Note text={s.note} />
        </li>
      ))}
    </ol>
  );
}

function ConfigBody({block}: {block: ConfigBlock}): JSX.Element {
  switch (block.kind) {
    case 'env':
      return (
        <>
          <dl className={styles.env}>
            {Object.entries(block.vars).map(([k, v]) => (
              <div key={k} className={styles.envRow}><dt>{k}</dt><dd>{v}</dd></div>
            ))}
          </dl>
          <details className={styles.exports}>
            <summary>Show as shell exports</summary>
            <CodeBlock code={toExports(block.vars)} />
          </details>
        </>
      );
    case 'file':
      return <CodeBlock label={block.path} code={block.snippet} />;
    case 'code':
      return <CodeBlock code={block.snippet} />;
    case 'gui':
      return <p className={styles.gui}><Ticks>{block.instructions}</Ticks></p>;
  }
}

export function ConfigList({blocks}: {blocks: readonly ConfigBlock[]}): JSX.Element {
  return (
    <div className={styles.configs}>
      {blocks.map((b, i) => (
        <div key={i} className={styles.config}>
          {b.title && <p className={styles.stepLabel}>{b.title}</p>}
          <ConfigBody block={b} />
          <Note text={b.note} />
        </div>
      ))}
    </div>
  );
}
