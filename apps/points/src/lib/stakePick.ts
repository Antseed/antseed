// "Stake here" on a provider picks it in the Stake section further down the page.
type Listener = (agentId: string) => void;
const listeners = new Set<Listener>();

export function pickStakeProvider(agentId: string) {
  listeners.forEach((l) => l(agentId));
}

export function onStakeProviderPicked(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
