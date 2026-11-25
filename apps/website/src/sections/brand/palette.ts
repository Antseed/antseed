/** The colour tokens of src/styles/tokens.css, as the brand page lists them. Keep the values in step with that file. */

export type Swatch = {
  name: string;
  token: string;
  day: string;
  night: string;
  role: string;
};

export type SwatchGroup = {title: string; swatches: readonly Swatch[]};

export const PALETTE: readonly SwatchGroup[] = [
  {
    title: 'Paper',
    swatches: [
      {name: 'Page', token: '--site-bg', day: '#fcfcfc', night: '#0f1312', role: 'The margins, under a dot every 8px.'},
      {name: 'Rail', token: '--site-surface', day: '#ffffff', night: '#181d1b', role: 'The sheet every section sits on.'},
      {name: 'Band', token: '--site-surface-dark', day: '#181d1b', night: '#181d1b', role: 'The one dark place on the day page.'},
      {name: 'Dot', token: '--site-dot', day: '#e2e2e2', night: '#3d4340', role: 'The margin matrix and dotted outlines.'},
    ],
  },
  {
    title: 'Ink',
    swatches: [
      {name: 'Text', token: '--site-text', day: '#30382c', night: '#eceee9', role: 'Titles and running copy.'},
      {name: 'Title grey', token: '--site-text-muted', day: '#929292', night: '#9ba49e', role: 'The second half of a title.'},
      {name: 'Body', token: '--site-text-body', day: '#56656f', night: '#9ba49e', role: 'Sub lines and captions.'},
      {name: 'Small', token: '--site-text-small', day: '#66746b', night: '#9ba49e', role: 'Small print and labels.'},
    ],
  },
  {
    title: 'Green',
    swatches: [
      {name: 'Meadow', token: '--site-fill', day: '#4f7a24', night: '#4f7a24', role: 'The one filled button, in both themes.'},
      {name: 'Green text', token: '--site-accent', day: '#4f7a24', night: '#98c463', role: 'Eyebrows, links, a selected line.'},
      {name: 'Hover', token: '--site-fill-hover', day: '#436a1e', night: '#5b8a2b', role: 'Darker by day, lighter at night.'},
      {name: 'Acid', token: '--site-lime', day: '#c8f53c', night: '#c8f53c', role: 'Light, not paint: walking dots and trails.'},
    ],
  },
];
