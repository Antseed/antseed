/** What the app loop types and receives. */
export const PROMPT = 'Summarise this lease in three risks';
export const REPLY = 'Three risks stand out. The break clause lets the landlord end it after 12 months. The deposit is three months\' rent, above the usual. And you must give 90 days\' notice to leave.';
export const SIGNATURE = 'Kimi K3.1 · in a TEE · signed by 0x7a…3f';

/** The app is laid out at its own size and scaled to the window. */
export const APP_WIDTH = 1100;
export const APP_HEIGHT = 860;

export type Capture = 'anon' | 'menu' | 'kimi' | 'private' | 'talk';

/** One capture of the app per state, by day and by night; the first is the whole app, the others are laid over their place in it. */
export const CAPTURES: ReadonlyArray<{id: Capture; file: string}> = [
  {id: 'anon', file: '1-anon'},
  {id: 'menu', file: '2-menu'},
  {id: 'kimi', file: '3-kimi'},
  {id: 'private', file: '4-private'},
  {id: 'talk', file: '5-talk'},
];

export const captureSrc = (file: string, dark: boolean) => `/site/assets/home/desktop/${dark ? 'night' : 'day'}-${file}.webp`;

/** Cursor targets, in app px. */
export const POINTS = {
  rest: [880, 560],
  picker: [498, 806],
  kimi: [520, 732],
  privateSwitch: [724, 332],
  input: [430, 712],
  send: [984, 752],
} as const;
