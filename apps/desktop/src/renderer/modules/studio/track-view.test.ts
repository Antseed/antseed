import { describe, expect, it } from 'vitest';
import { parseStudioTrack } from '../../../shared/studio-track.js';
import { clipRequestMessage, formatTimecode, selectionContext } from './track-view';

const track = parseStudioTrack({
  aspectRatio: '16:9',
  scenes: { a1: { name: 'Harbor', world: 'A harbor at dusk, wet stone, sodium lamps' } },
  anchors: [
    { id: 'a1', image: 'stills/a1.png', title: 'Harbor at dusk', clip: { id: 'c1', then: 'extend', plannedSeconds: 5, prompt: 'Slow push in', use: 'clips/c1-v2.mp4', versions: [{ file: 'clips/c1-v2.mp4', from: 'stills/a1.png', to: 'stills/a2.png', seconds: 5 }] } },
    { id: 'a2', image: 'stills/a2.png', clip: { id: 'c2', then: 'cut', plannedSeconds: 4 } },
    { id: 'a3', image: null },
  ],
});

describe('studio track view', () => {
  it('asks for an Extend with both frames, and for a Cut with the start frame only', () => {
    const text = clipRequestMessage(track, ['a1', 'a2']);
    expect(text).toContain('Please make these 2 clips for the track.');
    expect(text).toContain('Clip 1→2 (clip c1)\n- Start frame: stills/a1.png (Shot 1)\n- End frame: stills/a2.png (Shot 2). Extend: the clip must land exactly on this image.\n- Length: 5 s');
    expect(text).toContain('- Scene 1 "Harbor": A harbor at dusk, wet stone, sodium lamps');
    expect(text).toContain('Clip 2→3 (clip c2)');
    expect(text).toContain('End frame: none. Cut: the film cuts to Shot 3 after it');
    expect(text).toContain('Quote one total price first');
    expect(text).toContain('deliveries/');
  });

  it('names the selection for the chat chip, with the ids, files and moment the agent needs', () => {
    expect(selectionContext(track, { anchor: 'a1', clip: false })).toEqual({
      label: 'Shot 1 · Harbor at dusk',
      text: '[Studio: Shot 1 "Harbor at dusk" (anchor a1) · image stills/a1.png · aspect 16:9]',
    });
    expect(selectionContext(track, { anchor: 'a1', clip: true }, 3.24)).toEqual({
      label: 'Clip 1→2 · v1 at 0:03.2',
      text: '[Studio: Clip 1→2 (clip c1) · playing clips/c1-v2.mp4 at 0:03.2 · start stills/a1.png · then Extend: must land on stills/a2.png (Shot 2)]',
    });
    expect(selectionContext(track, { anchor: 'a2', clip: true })).toEqual({
      label: 'Clip 2→3 · empty · 4 s · Cut',
      text: '[Studio: Clip 2→3 (clip c2) · empty, planned 4 s · start stills/a2.png · then Cut to Shot 3: ends freely · aspect 16:9]',
    });
    expect(selectionContext(track, { anchor: 'a3', clip: false })?.label).toBe('Shot 3 · no image yet');
    const open = parseStudioTrack({ ...track, labels: { 'uploads/3f2a.png': 'harbor.png' }, anchors: [{ id: 'a1', image: 'uploads/3f2a.png', clip: { id: 'c1' } }, { id: 'a2', image: 'stills/a2.png' }] });
    expect(selectionContext(open, { anchor: 'a1', clip: false })?.label).toBe('Shot 1 · harbor.png');
    expect(selectionContext(open, { anchor: 'a1', clip: true })?.text).toContain('Cut or Extend not chosen yet; next is Shot 2 (anchor a2, stills/a2.png)');
    expect(formatTimecode(75.25)).toBe('1:15.3');
  });
});
