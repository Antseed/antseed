import type { KeyboardEvent } from 'react';

/**
 * Arrow-key navigation for a row of buttons (tabs, segmented controls):
 * Left/Right (and Up/Down) wrap, Home/End jump. Returns the new index, or
 * null when the key is not a navigation key.
 */
export function rovingIndex(event: KeyboardEvent, index: number, count: number): number | null {
  if (count === 0) return null;
  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (index + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

export function focusSibling(event: KeyboardEvent<HTMLElement>, index: number, selector: string): void {
  const container = event.currentTarget.parentElement;
  const target = container?.querySelectorAll<HTMLElement>(selector)[index];
  target?.focus();
}
