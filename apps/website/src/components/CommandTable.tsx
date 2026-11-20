import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react';
import clsx from 'clsx';
import {CheckIcon, CopyIcon} from '@site/src/components/CopyIcons';
import {useCopy} from '@site/src/lib/useCopy';
import styles from './CommandTable.module.css';

/**
 * Wraps a markdown Command | Description table. Every row's first cell gets
 * a copy button that copies just the command, never the description.
 * Rows are wired up by the `tr` override in src/theme/MDXComponents.tsx.
 */
const CommandTableContext = createContext(false);

export function CommandTable({children}: {children: ReactNode}) {
  return (
    <CommandTableContext.Provider value={true}>
      <div className="command-table">{children}</div>
    </CommandTableContext.Provider>
  );
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{children?: ReactNode}>(node)) return textOf(node.props.children);
  return '';
}

function CopyCommandButton({command}: {command: string}) {
  const {copied, copy} = useCopy();
  return (
    <button
      type="button"
      className={clsx(styles.copy, copied && styles.copied)}
      onClick={() => copy(command)}
      aria-label={copied ? 'Copied' : `Copy command: ${command}`}
      title={copied ? 'Copied' : 'Copy command'}>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

/** MDX `tr`: inside a CommandTable, body rows get a copy button in cell one. */
export function CommandTableRow(props: ComponentProps<'tr'>) {
  const inCommandTable = useContext(CommandTableContext);
  const cells = Children.toArray(props.children).filter(isValidElement) as ReactElement<{
    children?: ReactNode;
  }>[];
  const first = cells[0];
  if (!inCommandTable || !first || isHeaderCell(first)) return <tr {...props} />;
  const command = textOf(first.props.children).trim();
  if (!command) return <tr {...props} />;

  return (
    <tr {...props}>
      {cloneElement(first, {
        children: (
          <span className={styles.cellInner}>
            <span className={styles.command}>{first.props.children}</span>
            <CopyCommandButton command={command} />
          </span>
        ),
      })}
      {cells.slice(1)}
    </tr>
  );
}

function isHeaderCell(el: ReactElement): boolean {
  // MDX may hand us either the intrinsic 'th' or a mapped component for it.
  const props = el.props as {mdxType?: string; originalType?: string};
  return el.type === 'th' || props.mdxType === 'th' || props.originalType === 'th';
}
