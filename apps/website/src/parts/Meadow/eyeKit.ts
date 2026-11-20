/* The ants' eyes kit (assets/home/footer/eyes): per theme a sprite sheet and, per eye, its box in the 1920×1080 film, its cells in the
   sheet (white, pupil, then the lid's blink frames), where the painted pupil rests and how far it may travel. */

export type Phase = 'day' | 'night';

export type KitEye = {
  box: [number, number, number, number];
  size: [number, number];
  cells: [number, number][];
  center: [number, number];
  rest: [number, number];
  travel: [number, number];
  /** film frame → lid cell (1-based) */
  blink: Record<string, number>;
};
export type KitSheet = {sheet: string; sheetSize: [number, number]; eyes: Record<string, KitEye>};
export type EyeKit = {video: [number, number]; fps: number; frames: number} & Record<Phase, KitSheet>;

export const KIT_DIR = '/site/assets/home/footer/eyes/';
/** Which eyes belong to which ant: the two of one ant move together. */
export const ANTS: readonly (readonly string[])[] = [['ant1-left', 'ant1-right'], ['ant3-left', 'ant3-right']];

let kit: Promise<EyeKit> | null = null;
export function loadEyeKit(): Promise<EyeKit> {
  kit ??= fetch(`${KIT_DIR}eyes.json`).then((r) => (r.ok ? (r.json() as Promise<EyeKit>) : Promise.reject(new Error(`eyes.json: ${r.status}`))));
  kit.catch(() => { kit = null; });
  return kit;
}

/** Each ant's point between its two eyes, in film pixels. */
export function antCentres(sheet: KitSheet): [number, number][] {
  return ANTS.map((names) => names.reduce<[number, number]>((acc, name) => {
    const {box: [x, y, w, h], center} = sheet.eyes[name];
    return [acc[0] + (x + w * center[0]) / names.length, acc[1] + (y + h * center[1]) / names.length];
  }, [0, 0]));
}

/** A sheet cell as a background-position, for the cell scaled to the eye's box. */
export function cellPosition(sheet: KitSheet, eye: KitEye, [cx, cy]: [number, number]): string {
  const [sw, sh] = sheet.sheetSize;
  const [iw, ih] = eye.size;
  return `${(cx / (sw - iw)) * 100}% ${(cy / (sh - ih)) * 100}%`;
}
