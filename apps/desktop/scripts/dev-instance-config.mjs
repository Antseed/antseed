const INSTANCE_SLOT_COUNT = 999;

export function resolveInstanceSlot(instanceName) {
  if (typeof instanceName !== 'string' || instanceName.trim().length === 0) {
    throw new Error('Desktop instance name must not be empty');
  }

  const hash = [...instanceName].reduce(
    (currentHash, character) => Math.imul(currentHash ^ character.charCodeAt(0), 16777619) >>> 0,
    2166136261,
  );
  return (hash % INSTANCE_SLOT_COUNT) + 1;
}

export function resolveInstancePorts(instanceName) {
  const slot = resolveInstanceSlot(instanceName);
  return {
    renderer: 5174 + slot,
    payments: 3118 + slot,
    systemProxy: 8378 + slot,
  };
}
