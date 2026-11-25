export type Typeface = {
  name: string;
  /** The CSS token that sets it. */
  token: string;
  use: string;
  weights: string;
  sample: string;
  /** The specimen's style, a class of Type.module.css. */
  specimen: 'pixel' | 'text' | 'ui' | 'mono';
};

export const TYPEFACES: readonly Typeface[] = [
  {
    name: 'Geist Pixel',
    token: '--site-font-pixel',
    use: 'The H1, section titles, eyebrows and live figures',
    weights: '400, variable on its ELSH axis',
    sample: 'The open intelligence network',
    specimen: 'pixel',
  },
  {
    name: 'Geist',
    token: '--site-font',
    use: 'Everything people read: ledes, sub lines, body, buttons',
    weights: '400 and 500',
    sample: 'Run your agents on your terms. Save on every AI model. No usage limits, no middleman, always anonymous.',
    specimen: 'text',
  },
  {
    name: 'Instrument Sans',
    token: '--site-font-ui',
    use: 'Controls: the nav, its buttons, tabs',
    weights: '500',
    sample: 'Set Up Gateway · Download Desktop',
    specimen: 'ui',
  },
  {
    name: 'Geist Mono',
    token: '--site-font-mono',
    use: 'Code, commands, prices and hashes',
    weights: '400 and 500',
    sample: '$ antseed gateway start',
    specimen: 'mono',
  },
];

/** The ELSH values the site uses, from a square pixel (1) to a fine grid of dots (100). */
export const ELSH_STOPS = [
  {value: 11, use: 'The H1'},
  {value: 20, use: 'Eyebrows and figures'},
  {value: 40, use: 'Section titles'},
] as const;
