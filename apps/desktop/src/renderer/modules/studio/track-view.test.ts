import { describe, expect, it } from 'vitest';
import { parseStudioTrack } from '../../../shared/studio-track.js';
import { clipPlayerKey, clipRequestMessage, composerContext, filmClipKey, filmIndex, filmPlayers, formatTimecode, liveSelection, playFailed, selectionContext, splitStudioContext, splitStudioMessage } from './track-view';

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

  it('reads the chip back from a sent message, so the tag stays in the chat', () => {
    const sent = (anchor: string, clip: boolean, time: number | null = null) => `${selectionContext(track, { anchor, clip }, time)!.text}\nok please do`;
    expect(splitStudioContext(sent('a1', false))).toEqual({
      label: 'Shot 1 · Harbor at dusk',
      context: '[Studio: Shot 1 "Harbor at dusk" (anchor a1) · image stills/a1.png · aspect 16:9]',
      rest: 'ok please do',
    });
    expect(splitStudioContext(sent('a1', true, 3.24))?.label).toBe('Clip 1→2 · at 0:03.2');
    expect(splitStudioContext(sent('a2', true))?.label).toBe('Clip 2→3 · empty');
    expect(splitStudioContext(sent('a3', false))?.label).toBe('Shot 3');
    expect(splitStudioContext('[Studio: Shot 1 (anchor a1) · image stills/a1.png]')?.rest).toBe('');
    const line = selectionContext(track, { anchor: 'a1', clip: false })!.text;
    expect(splitStudioContext(`${line}\n${line}\nok please do`)?.rest).toBe('ok please do');
    expect(splitStudioContext('[Studio is great]\nhi')).toBeNull();
    expect(splitStudioContext('hello')).toBeNull();
  });
});

it('shows a clip request from Update as one chip naming its clips', () => {
  const one = 'Please make this clip for the track.\n\nClip 1→2 (clip c3)\n- Start frame: uploads/a.png (Shot 1)\n\nQuote one total price first.';
  expect(splitStudioMessage(one)).toEqual({ label: 'Make Clip 1→2', context: one, rest: '' });
  const two = 'Please make these 2 clips for the track.\n\nClip 1→2 (clip c3)\n- Length: 5 s\n\nClip 2→3 (clip c5)\n- Length: 5 s\n\nQuote one total price first.';
  expect(splitStudioMessage(two)?.label).toBe('Make 2 clips · 1→2, 2→3');
  // Sent with a selection line first, the request still names the chip.
  expect(splitStudioMessage(`[Studio: Clip 1→2 (clip c3) · empty]\n${one}`)?.label).toBe('Make Clip 1→2');
  expect(splitStudioMessage('Please make this clip nicer')).toBeNull();
  // The editor's own request parses back to the clips it names.
  const asked = clipRequestMessage(track, [track.anchors[0]!.id]);
  expect(splitStudioMessage(asked)?.label).toMatch(/^Make Clip 1→2$/);
});

it('names the last clip in a clip request chip, alone or with others', () => {
  const ending = parseStudioTrack({ anchors: [...track.anchors, { id: 'a4', image: 'stills/a4.png', clip: { id: 'c4' } }].map((anchor, index) => index === 2 ? { ...anchor, clip: { id: 'c3', then: 'cut' } } : anchor) });
  const last = ending.anchors[3]!.id;
  expect(splitStudioMessage(clipRequestMessage(ending, [last]))?.label).toBe('Make Clip after 4');
  expect(splitStudioMessage(clipRequestMessage(ending, [ending.anchors[0]!.id, last]))?.label).toBe('Make 2 clips · 1→2, after 4');
});

it('follows the clip playing when the film changes under it, and stops when that clip leaves', () => {
  const film = parseStudioTrack({ anchors: [
    { id: 'a1', clip: { id: 'c1', then: 'cut', use: 'clips/one.mp4', versions: [{ file: 'clips/one.mp4' }] } },
    { id: 'a2', clip: { id: 'c2', then: 'cut', use: 'clips/two.mp4', versions: [{ file: 'clips/two.mp4' }, { file: 'clips/two-b.mp4' }] } },
    { id: 'a3', clip: { id: 'c3', then: 'cut', use: 'clips/three.mp4', versions: [{ file: 'clips/three.mp4' }] } },
    { id: 'a4' },
  ] }).anchors.slice(0, 3);
  const third = filmClipKey(film[2]!);
  expect(filmIndex(film, third)).toBe(2);
  // Undo empties the third clip while it plays: the film is two clips long and playback stops.
  expect(filmIndex(film.slice(0, 2), third)).toBeNull();
  // A clip before it leaves: the one playing goes on where it now is.
  expect(filmIndex([film[1]!, film[2]!], third)).toBe(1);
  // Another version or a trim of the clip playing is another clip.
  const second = filmClipKey(film[1]!);
  expect(filmIndex([film[0]!, { ...film[1]!, clip: { ...film[1]!.clip!, use: 'clips/two-b.mp4' } }], second)).toBeNull();
  expect(filmIndex([film[0]!, { ...film[1]!, clip: { ...film[1]!.clip!, end: 1.5 } }], second)).toBeNull();
});

it('keeps the clip playing in its own player when a shot is moved during playback', () => {
  const film = parseStudioTrack({ anchors: [
    { id: 'a1', clip: { id: 'c1', then: 'cut', use: 'clips/one.mp4', versions: [{ file: 'clips/one.mp4' }] } },
    { id: 'a2', clip: { id: 'c2', then: 'cut', use: 'clips/two.mp4', versions: [{ file: 'clips/two.mp4' }] } },
    { id: 'a3', clip: { id: 'c3', then: 'cut', use: 'clips/three.mp4', versions: [{ file: 'clips/three.mp4' }] } },
    { id: 'a4' },
  ] }).anchors.slice(0, 3);
  const [one, two, three] = film as [typeof film[0], typeof film[0], typeof film[0]];
  const playing = { key: filmClipKey(one), slot: 0 as const };
  expect(filmPlayers(film, playing)).toEqual({ index: 0, players: [one, two] });
  // The first shot moves one later while it plays: it stays in player 0, and player 1 loads what now follows it.
  expect(filmPlayers([two, one, three], playing)).toEqual({ index: 1, players: [one, three] });
  // After a hand-over the second player plays, wherever its clip is.
  const handedOver = { key: filmClipKey(two), slot: 1 as const };
  expect(filmPlayers(film, handedOver)).toEqual({ index: 1, players: [three, two] });
  expect(filmPlayers([two, one, three], handedOver)).toEqual({ index: 0, players: [one, two] });
  // The last clip has nothing after it; a clip gone from the film leaves both players empty.
  expect(filmPlayers([two, one], playing)).toEqual({ index: 1, players: [one, null] });
  expect(filmPlayers([two, three], playing)).toEqual({ index: null, players: [null, null] });
});

it('keeps a removed chip off when a poll hands the editor the same selection with a fresh track, until the user selects again', () => {
  const selection = { anchor: 'a1', clip: false };
  const offer = (from: typeof track, picked: typeof selection) => ({ context: selectionContext(from, picked), selection: picked });
  expect(composerContext(offer(track, selection), null)?.label).toBe('Shot 1 · Harbor at dusk');
  // The user removes the chip; the next poll reads the same track afresh, so the editor offers it again.
  const dismissed = selection;
  expect(composerContext(offer(parseStudioTrack(JSON.parse(JSON.stringify(track))), selection), dismissed)).toBeNull();
  // Selecting the same shot again is a new selection, and its chip comes back.
  expect(composerContext(offer(track, { anchor: 'a1', clip: false }), dismissed)?.label).toBe('Shot 1 · Harbor at dusk');
});

it('gives two clips that play the same file their own players', () => {
  const one = { id: 'c1', use: 'clips/shared.mp4' };
  const two = { id: 'c2', use: 'clips/shared.mp4' };
  expect(clipPlayerKey(one)).not.toBe(clipPlayerKey(two));
  // Another version of the same clip is a new player too.
  expect(clipPlayerKey(one)).not.toBe(clipPlayerKey({ id: 'c1', use: 'clips/other.mp4' }));
});

it('carries a timecode that rounds up to the next minute', () => {
  expect(formatTimecode(59.96)).toBe('1:00.0');
  expect(formatTimecode(119.96)).toBe('2:00.0');
  expect(formatTimecode(59.94)).toBe('0:59.9');
  expect(formatTimecode(0)).toBe('0:00.0');
});

it('drops a selection once its shot leaves the track, as an Undo of the shot does', () => {
  const track = parseStudioTrack({ anchors: [{ id: 'a1', image: 'stills/a.png', clip: { id: 'c1' } }, { id: 'a3', image: 'stills/b.png' }] });
  const clip = { anchor: 'a1', clip: true };
  expect(liveSelection(track, clip)).toBe(clip);
  expect(liveSelection(track, { anchor: 'a5', clip: true })).toBeNull();
  expect(liveSelection(track, { anchor: 'a5', clip: false })).toBeNull();
  expect(liveSelection(track, null)).toBeNull();
});

it('stops the film only on a real play failure, not when a clip is switched or paused before it starts', () => {
  const abort = new Error('The play() request was interrupted');
  abort.name = 'AbortError';
  expect(playFailed(abort)).toBe(false);
  const unsupported = new Error('The element has no supported sources.');
  unsupported.name = 'NotSupportedError';
  expect(playFailed(unsupported)).toBe(true);
  expect(playFailed('unknown')).toBe(true);
});
