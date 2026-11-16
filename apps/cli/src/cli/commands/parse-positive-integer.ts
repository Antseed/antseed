import { InvalidArgumentError } from 'commander';

export function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('Must be a positive safe integer.');
  }
  return parsed;
}
