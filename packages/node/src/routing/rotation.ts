const MAX_ROTATION_POOLS = 4096;

/** Read the next turn, optionally consuming it, with bounded least-recently-used state. */
export function nextRotationOffset(
  rotations: Map<string, number>,
  key: string,
  group: number,
  advance: boolean,
  initialStep = 1,
): number {
  // Existing price and composite-score routing start one place ahead; reputation
  // routing starts at zero to preserve peer id order on a pool's first request.
  const step = rotations.get(key) ?? initialStep;
  if (advance) {
    rotations.delete(key);
    rotations.set(key, (step + 1) >>> 0);
    while (rotations.size > MAX_ROTATION_POOLS) {
      const oldest = rotations.keys().next().value;
      if (oldest === undefined) break;
      rotations.delete(oldest);
    }
  }
  return step % group;
}

/** Rotate the first `group` items left by `offset`, in place. */
export function rotateHead<T>(items: T[], group: number, offset: number): T[] {
  if (offset === 0) return items;
  const head = items.slice(0, group);
  for (let index = 0; index < group; index += 1) {
    const next = head[(index + offset) % group];
    if (next) items[index] = next;
  }
  return items;
}

/** Sorted, newline-joined ids of the first `group` sellers, so a tied pool keeps one counter in any order. */
export function tiedSellerSignature<T>(
  items: T[],
  group: number,
  peerIdOf: (item: T) => string | undefined,
  normalize: (peerId: string) => string = (peerId) => peerId,
): string {
  const ids: string[] = [];
  for (let index = 0; index < group; index += 1) {
    const item = items[index];
    const peerId = item === undefined ? undefined : peerIdOf(item);
    if (peerId) ids.push(normalize(peerId));
  }
  ids.sort();
  return ids.join('\n');
}
