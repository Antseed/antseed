/** The Gateway film's chapters: label and start time in seconds. */
export type Chapter = {label: string; start: number};

export const CHAPTERS: readonly Chapter[] = [
  {label: 'API keys', start: 0},
  {label: 'Models', start: 10.4},
  {label: 'Providers', start: 13.2},
  {label: 'Usage', start: 15.6},
  {label: 'Chat', start: 596 / 30},
];

/** Used for the last chapter's progress until the film reports its duration. */
export const FALLBACK_DURATION = 32.7;
