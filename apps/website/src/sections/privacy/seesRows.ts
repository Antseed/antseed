/** What a provider sees, from the privacy answers in docs/faq.mdx. */
export type SeesRow = {label: string; standard: string; tee: string; antseed: string};

export const SEES_ROWS: readonly SeesRow[] = [
  {label: 'Who you are', standard: 'A peer id', tee: 'A peer id', antseed: 'Nothing'},
  {label: 'Your prompt', standard: 'Just like any API', tee: 'Nothing', antseed: 'Nothing'},
  {label: 'Your payment', standard: 'A wallet', tee: 'A wallet', antseed: 'Nothing'},
];
