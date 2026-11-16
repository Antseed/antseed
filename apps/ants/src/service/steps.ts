/** Progress callback used by every multi-transaction action. */
export type StepReporter = (label: string, hash?: string) => void | Promise<void>;

export const silentReporter: StepReporter = () => {};

export function assertPositiveIds(ids: unknown): number[] {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('At least one position ID is required.');
  const parsed = ids.map((value) => Number(value));
  if (parsed.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Position IDs must be positive integers.');
  if (new Set(parsed).size !== parsed.length) throw new Error('Position IDs must not repeat.');
  return parsed;
}

export function assertEpochs(epochs: unknown, min: number, max: number): number {
  const value = Number(epochs);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Lock length must be a whole number of epochs between ${min} and ${max}.`);
  return value;
}

export function assertAgentId(agentId: unknown): number {
  const value = Number(agentId);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Agent ID must be a positive integer.');
  return value;
}
