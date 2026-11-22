import type {Medium} from '../../../lib/antscan';

export type {LaneModel as Model, Medium} from '../../../lib/antscan';

export const MEDIA: ReadonlyArray<{id: Medium; label: string}> = [
  {id: 'text', label: 'Text'},
  {id: 'image', label: 'Image'},
  {id: 'video', label: 'Video'},
  {id: 'voice', label: 'Voice'},
];
