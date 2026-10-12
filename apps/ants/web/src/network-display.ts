export function emissionPercent(amount: string | null, emission: string | null): string {
  if (amount === null || emission === null || BigInt(emission) === 0n) return '—';
  const hundredths = BigInt(amount) * 10_000n / BigInt(emission);
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}%`;
}
