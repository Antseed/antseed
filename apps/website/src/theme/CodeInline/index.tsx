import {Fragment, type ReactNode} from 'react';
import clsx from 'clsx';
import type {Props} from '@theme/CodeInline';
import {ONE_LINE_MAX, softParts, words} from './words';
import styles from './styles.module.css';

// An inline code chip breaks only at its spaces and after a word's punctuation, so `--no-buyer` never splits at a hyphen,
// while the chip itself stays inline: a bracket or full stop written against it stays on its line (an inline-block chip left
// them alone at a line's end). A short chip stays on one line, except in a table cell; on a phone a table's long key may also
// break between its camelCase or hyphenated words. Copying the chip gives the same text.
export default function CodeInline({children, className, ...props}: Props): ReactNode {
  const text = typeof children === 'string' ? children : Array.isArray(children) && children.every((c) => typeof c === 'string') ? children.join('') : null;
  if (text === null) return <code className={className} {...props}>{children}</code>;
  return (
    <code className={clsx(className, text.trim().length <= ONE_LINE_MAX && styles.short)} {...props}>
      {words(text).map((piece, i) => (
        <Fragment key={i}>
          {piece.parts.map((part, j) => (
            <Fragment key={j}>
              {j > 0 && <wbr />}
              {softParts(part).map((word, k) => (
                <Fragment key={k}>{k > 0 && <wbr className={styles.soft} />}{piece.whole ? <span className={styles.whole}>{word}</span> : word}</Fragment>
              ))}
            </Fragment>
          ))}
        </Fragment>
      ))}
    </code>
  );
}
