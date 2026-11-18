/** The Gateway film's chapters: label and start time in seconds. */
export type Chapter = {label: string; start: number};

export const CHAPTERS: readonly Chapter[] = [
  {label: 'Ask', start: 0},
  {label: 'Models', start: 14.2},
  {label: 'Providers', start: 17.7},
  {label: 'Keys & budgets', start: 22},
  {label: 'Usage', start: 31.4},
];

/** Used for the last chapter's progress until the film reports its duration. */
export const FALLBACK_DURATION = 35;
