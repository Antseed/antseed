import { suppressOthers } from 'aria-hidden';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

let dialogStack: HTMLElement[] = [];
const stackListeners = new Set<() => void>();

function notifyStackListeners() {
  stackListeners.forEach((listener) => listener());
}

function addDialog(panel: HTMLElement) {
  dialogStack = dialogStack.filter((entry) => entry !== panel);
  dialogStack.push(panel);
  notifyStackListeners();
}

function removeDialog(panel: HTMLElement) {
  dialogStack = dialogStack.filter((entry) => entry !== panel);
  notifyStackListeners();
}

function isTopDialog(panel: HTMLElement) {
  return dialogStack[dialogStack.length - 1] === panel;
}

export function useDialogBehavior(
  isOpen: boolean,
  panelRef: RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  const onCloseRef = useRef(onClose);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [isTop, setIsTop] = useState(false);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const restoreFocus = useCallback(() => {
    const previousFocus = previousFocusRef.current;
    previousFocusRef.current = null;

    if (previousFocus && document.contains(previousFocus)) {
      previousFocus.focus({ preventScroll: true });
    }
  }, []);

  const closeDialog = useCallback(() => {
    onCloseRef.current();
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const panel = panelRef.current;
    if (!panel) return;
    const activePanel: HTMLElement = panel;

    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    addDialog(activePanel);
    setIsTop(isTopDialog(activePanel));

    function onStackChange() {
      setIsTop(isTopDialog(activePanel));
    }

    function onKeyDown(event: KeyboardEvent) {
      if (!isTopDialog(activePanel)) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        closeDialog();
      }
    }

    stackListeners.add(onStackChange);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      stackListeners.delete(onStackChange);
      removeDialog(activePanel);
      restoreFocus();
    };
  }, [closeDialog, isOpen, panelRef, restoreFocus]);

  useEffect(() => {
    if (!isOpen || !isTop) return;

    const panel = panelRef.current;
    if (!panel) return;

    const focusGuards = panel.parentElement?.parentElement?.querySelectorAll<HTMLElement>('[data-focus-guard]') ?? [];
    return suppressOthers([panel, ...focusGuards]);
  }, [isOpen, isTop, panelRef]);

  return { closeDialog, isTopDialog: isTop };
}
