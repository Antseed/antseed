import { expect, it } from 'vitest';
import { emptyStudioTrack, parseStudioTrack } from '../../../shared/studio-track.js';
import type { StudioProjectDetail } from '../../../shared/studio.js';
import { keepReadable } from './resources';

const detail = (fields: Partial<StudioProjectDetail>) => ({ boardError: null, trackError: null, ...fields }) as StudioProjectDetail;

it('keeps the last film read whole when a poll cannot read the track, and shows the error', () => {
  const film = detail({ track: parseStudioTrack({ anchors: [{ id: 'a1', image: 'stills/a.png' }] }) });
  const unreadable = detail({ track: emptyStudioTrack(), trackError: 'track.json could not be read' });
  const shown = keepReadable(film, unreadable);
  expect(shown.track?.anchors.map((anchor) => anchor.id)).toEqual(['a1']);
  expect(shown.trackError).toBe('track.json could not be read');
  // Once the track reads again, the poll shows it as read.
  const fixed = detail({ track: parseStudioTrack({ anchors: [{ id: 'a2' }] }) });
  expect(keepReadable(film, fixed)).toBe(fixed);
});

it('shows a project with an unreadable track as read when nothing was read before', () => {
  const unreadable = detail({ track: emptyStudioTrack(), trackError: 'track.json could not be read' });
  expect(keepReadable(null, unreadable)).toBe(unreadable);
});
