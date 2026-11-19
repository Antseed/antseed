// Imported by macs.test.ts under plain Node, so this file must not import anything.

/**
 * Apple silicon Macs, newest chip first: chip -> every unified memory size (GB) Apple ever sold that chip with in that Mac, across all
 * core counts, including sizes Apple later dropped (M3 Ultra 512, M4 Max 128, M4 Pro 64), since owners still have them. Checked
 * 18 Nov 2026 against Apple's tech specs (Mac Studio 122211 and M5, Mac mini M6, iMac M6, MacBook Air M5 and M4, MacBook Neo), the Apple
 * newsroom (M5 Pro/Max, M5 Ultra, M6), EveryMac and Wikipedia for the older models. Check again when Apple ships a new Mac.
 */
export const MACS: Readonly<Record<string, Readonly<Record<string, readonly number[]>>>> = {
  'MacBook Air': {'M5': [16, 24, 32], 'M4': [16, 24, 32], 'M3': [8, 16, 24], 'M2': [8, 16, 24], 'M1': [8, 16]},
  'MacBook Pro': {
    'M6': [16, 24, 32], 'M5 Max': [36, 48, 64, 128], 'M5 Pro': [24, 48, 64], 'M5': [16, 24, 32],
    'M4 Max': [36, 48, 64, 128], 'M4 Pro': [24, 48], 'M4': [16, 24, 32], 'M3 Max': [36, 48, 64, 96, 128], 'M3 Pro': [18, 36], 'M3': [8, 16, 24],
    'M2 Max': [32, 64, 96], 'M2 Pro': [16, 32], 'M2': [8, 16, 24], 'M1 Max': [32, 64], 'M1 Pro': [16, 32], 'M1': [8, 16],
  },
  'MacBook Neo': {'A18 Pro': [8]},
  'iMac': {'M6': [16, 24, 32], 'M4': [16, 24, 32], 'M3': [8, 16, 24], 'M1': [8, 16]},
  'Mac mini': {'M6': [16, 24, 32], 'M5 Pro': [24, 48, 64], 'M4 Pro': [24, 48, 64], 'M4': [16, 24, 32], 'M2 Pro': [16, 32], 'M2': [8, 16, 24], 'M1': [8, 16]},
  'Mac Studio': {
    'M5 Ultra': [96, 256, 512], 'M5 Max': [36, 48, 64, 128], 'M3 Ultra': [96, 256, 512], 'M4 Max': [36, 48, 64, 128],
    'M2 Ultra': [64, 128, 192], 'M2 Max': [32, 64, 96], 'M1 Ultra': [64, 128], 'M1 Max': [32, 64],
  },
  'Mac Pro': {'M2 Ultra': [64, 128, 192]},
};

export type Answers = {mac: string; chip: string; memory: string; name: string};
export type Step = 'mac' | 'chip' | 'memory' | 'name' | 'email' | 'done';

/** The chips Apple put in that Mac. */
export const chipsFor = (mac: string): string[] => Object.keys(MACS[mac] ?? {});

/** The memory sizes that chip came with in that Mac ("16 GB"…), smallest first; every size the Mac came with before the chip is picked. */
export function memsFor(mac: string, chip: string): string[] {
  const chips = MACS[mac] ?? {};
  const sizes = chip && chips[chip] ? [...chips[chip]] : [...new Set(Object.values(chips).flat())];
  return sizes.sort((a, b) => a - b).map((gb) => `${gb} GB`);
}

/** The steps this Mac needs: no chip step for a Mac with one chip, no memory step for a chip with one size. */
export function stepsFor(a: Answers): Step[] {
  const steps: Step[] = ['mac'];
  if (!a.mac || chipsFor(a.mac).length > 1) steps.push('chip');
  if (!a.mac || memsFor(a.mac, a.chip).length > 1) steps.push('memory');
  return [...steps, 'name', 'email', 'done'];
}

/** The answers with the only option picked wherever there is just one (the MacBook Neo's chip and memory). */
export function settle(a: Answers): Answers {
  const chips = chipsFor(a.mac);
  const chip = chips.length === 1 ? chips[0] : a.chip;
  const mems = memsFor(a.mac, chip);
  return {...a, chip, memory: mems.length === 1 ? mems[0] : a.memory};
}

/** The memory picked, in GB; the smallest the answers allow if none is picked yet. */
export function memoryGb(a: Answers): number | null {
  const picked = parseInt(a.memory, 10);
  if (Number.isFinite(picked)) return picked;
  const sizes = memsFor(a.mac, a.chip).map((m) => parseInt(m, 10));
  return sizes.length ? Math.min(...sizes) : null;
}
