import {isValidElement, type ReactNode} from 'react';

/** The text of a React node, tags dropped (structured data built from rich copy). */
export function plainText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(plainText).join('');
  if (isValidElement<{children?: ReactNode}>(node)) return plainText(node.props.children);
  return '';
}
