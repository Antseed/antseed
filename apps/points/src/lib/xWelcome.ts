// Lets any part of the site (the header's account menu, Your points) reopen the X welcome
// window at its "connect your wallet" step, after someone skipped or closed it.
type Listener = () => void;
const listeners = new Set<Listener>();

export function openWalletLink() {
  listeners.forEach((l) => l());
}

export function onOpenWalletLink(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
