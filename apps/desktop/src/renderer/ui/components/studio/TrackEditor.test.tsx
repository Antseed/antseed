import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseStudioTrack } from '../../../../shared/studio-track.js';
import { STUDIO_MEDIA_TOOLS_MISSING, type StudioProjectDetail } from '../../../../shared/studio.js';
import { TrackEditor } from './TrackEditor';

function detail(canSend = true, mediaTools = true) {
  // Every clip was made from an image since replaced; the agent was just asked for c2 again.
  const track = parseStudioTrack({ aspectRatio: '16:9', anchors: [
    { id: 'a1', image: 'stills/a.png', earlier: ['stills/old-a.png'], clip: { id: 'c1', then: 'cut', use: 'clips/one.mp4', versions: [{ file: 'clips/one.mp4', from: 'stills/old-a.png', seconds: 4 }] } },
    { id: 'a2', image: 'stills/b.png', earlier: ['stills/old-b.png'], clip: { id: 'c2', then: 'cut', use: 'clips/two.mp4', requestedAt: Date.now(), versions: [{ file: 'clips/two.mp4', from: 'stills/old-b.png', seconds: 4 }] } },
    { id: 'a3', image: 'stills/c.png', earlier: ['stills/old-c.png'], clip: { id: 'c3', then: 'cut', use: 'clips/three.mp4', versions: [{ file: 'clips/three.mp4', from: 'stills/old-c.png', seconds: 4 }] } },
    { id: 'a4', image: 'stills/d.png' },
  ] });
  const value = { project: { id: 'p1', name: 'Test' }, track, trackError: null, notices: [], library: [], canUndo: false, files: {}, mediaTools } as unknown as StudioProjectDetail & { track: typeof track };
  return renderToStaticMarkup(<TrackEditor detail={value} canSend={canSend} onSend={() => {}} onContext={() => {}} onChanged={() => {}} />);
}

test('out-of-date clips each get an Update button, with Update all in the toolbar', () => {
  const markup = detail();
  assert.match(markup, /2 clips out of date/);
  assert.match(markup, />Update all</);
  assert.ok(markup.includes('aria-label="Update Clip 1→2"'));
  assert.ok(markup.includes('aria-label="Update Clip 3→4"'));
  // The clip already asked for shows as updating, without a second Update button.
  assert.ok(!markup.includes('aria-label="Update Clip 2→3"'));
  assert.match(markup, /Updating…/);
});

test('Update is disabled while the project chat cannot send', () => {
  const markup = detail(false);
  assert.match(markup, /<button[^>]*disabled=""[^>]*aria-label="Update Clip 1→2"/);
});

test('Export is off, and says why, when ffmpeg and ffprobe cannot run', () => {
  const exportButton = (markup: string) => markup.match(/<button[^>]*><span[^>]*>Export<\/span><\/button>/)?.[0] ?? '';
  const off = exportButton(detail(true, false));
  assert.match(off, /disabled=""/);
  assert.ok(off.includes(`title="${STUDIO_MEDIA_TOOLS_MISSING}"`));
  const on = exportButton(detail(true, true));
  assert.ok(!on.includes('disabled=""'));
});
