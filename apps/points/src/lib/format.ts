export const fmt = (n: number | null | undefined, digits = 0) =>
  Number(n ?? 0).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });

export const fmtK = (n: number) => (n >= 1e6 ? `${fmt(n / 1e6, 2)}M` : n >= 1e4 ? `${fmt(n / 1e3, 1)}K` : fmt(n));

export const fmtBoost = (b: number | null | undefined) => {
  if (b === null || b === undefined || Number.isNaN(b)) return '—';
  if (b === 0) return '0×';
  if (b < 0.1) return '<0.1×';
  return `${fmt(b, b < 10 ? 1 : 0)}×`;
};

export const fmtUsd = (n: number) => `$${fmt(n, n < 100 ? 2 : 0)}`;

export const fmtPerUsd = (n: number) => fmt(n, n < 10 ? 1 : 0);

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export const isAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s.trim());

/** Stable soft colour for a provider avatar, picked from the palette's greens and golds. */
export function avatarColor(seed: string): string {
  const palette = ['#C6F0E2', '#E2FFF0', '#F2C46D', '#3DC799', '#DCF7EE', '#F8DDA5'];
  let h = 7;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length]!;
}

/** Dollars for single payments, which can be fractions of a cent. */
export const fmtCents = (n: number) => (n > 0 && n < 0.01 ? 'under $0.01' : `$${fmt(n, 2)}`);
