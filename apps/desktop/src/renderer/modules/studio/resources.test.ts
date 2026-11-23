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

it('shows the current notices and project name while the track cannot be read', () => {
  const film = detail({ project: { id: 'p1', name: 'Old name' } as StudioProjectDetail['project'], notices: ['An old note.'], track: parseStudioTrack({ anchors: [{ id: 'a1' }] }) });
  const unreadable = detail({ project: { id: 'p1', name: 'New name' } as StudioProjectDetail['project'], notices: ['A new note.'], track: emptyStudioTrack(), trackError: 'track.json could not be read' });
  const shown = keepReadable(film, unreadable);
  expect(shown.track?.anchors.map((anchor) => anchor.id)).toEqual(['a1']);
  expect(shown.notices).toEqual(['A new note.']);
  expect(shown.project.name).toBe('New name');
  // Dismissed while the track was unreadable: the old notes do not come back.
  expect(keepReadable(film, { ...unreadable, notices: [] }).notices).toEqual([]);
});
