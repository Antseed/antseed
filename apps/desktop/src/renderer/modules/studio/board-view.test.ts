import { describe, expect, it } from 'vitest';
import { parseStudioBoard } from '../../../shared/studio.js';
import { boardProgress, formatStudioUsd, shotMedia, studioFileUrl, studioMoney, totalSeconds } from './board-view';

const board = parseStudioBoard({
  kind: 'video',
  shots: [
    { id: '01', status: 'done', still: 'stills/shot-01.png', clip: 'clips/shot-01.mp4', durationSeconds: 5 },
    { id: '02', status: 'still', still: 'stills/shot-02.png', clip: 'clips/shot-02.mp4', durationSeconds: 4 },
    { id: '03', status: 'planned' },
  ],
  estimate: { approved: true, lines: [{ label: 'Stills', usd: 0.24 }, { label: 'Video', usd: 5.4 }, { label: 'Retakes', usd: 1.41 }] },
  spent: [{ label: 'Still 01', usd: 0.04 }, { label: 'Shot 01', usd: 0.9 }],
});

describe('studio board view', () => {
  it('addresses a project file, escaping each part of its path', () => {
    expect(studioFileUrl('surf-ants', 'stills/shot 01#a.png', 12)).toBe('antseed-studio://project/surf-ants/stills/shot%2001%23a.png?v=12');
    expect(studioFileUrl('2024', 'final.mp4')).toBe('antseed-studio://project/2024/final.mp4');
  });

  it('shows dollars to the cent and never a part of a cent as zero', () => {
    expect(formatStudioUsd(7.05)).toBe('$7.05');
    expect(formatStudioUsd(0)).toBe('$0.00');
    expect(formatStudioUsd(0.004)).toBe('<$0.01');
  });

  it('shows the clip only once its file exists, with the still as its poster', () => {
    const files = { 'stills/shot-01.png': 1, 'clips/shot-01.mp4': 2, 'stills/shot-02.png': 3 };
    expect(shotMedia(board.shots[0]!, files)).toEqual({ kind: 'video', path: 'clips/shot-01.mp4', version: 2, poster: { path: 'stills/shot-01.png', version: 1 } });
    expect(shotMedia(board.shots[1]!, files)).toEqual({ kind: 'image', path: 'stills/shot-02.png', version: 3 });
    expect(shotMedia(board.shots[2]!, files)).toBeNull();
    expect(shotMedia(board.shots[1]!, {})).toBeNull();
  });

  it('compares what was spent with what was agreed', () => {
    expect(studioMoney(board)).toEqual({ estimateUsd: 7.05, approved: true, spentUsd: 0.94, over: false });
    const over = parseStudioBoard({ estimate: { lines: [{ label: 'Video', usd: 0.5 }] }, spent: [{ label: 'Shot', usd: 0.9 }] });
    expect(studioMoney(over)).toMatchObject({ approved: false, over: true });
    expect(studioMoney(parseStudioBoard({}))).toEqual({ estimateUsd: null, approved: false, spentUsd: 0, over: false });
  });

  it('says how far the piece is', () => {
    expect(boardProgress(board)).toBe('3 shots · 1 with video');
    expect(boardProgress(parseStudioBoard({ shots: [{ still: 'a.png' }, {}] }))).toBe('2 shots · 1 with a still');
    expect(boardProgress(parseStudioBoard({ kind: 'pictures', shots: [{}] }))).toBe('1 picture');
    expect(boardProgress(parseStudioBoard({}))).toBe('No shots yet');
    expect(totalSeconds(board)).toBe(9);
  });
});
