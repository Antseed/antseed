import { describe, expect, it } from 'vitest';
import { buildChatSections, folderName, normalizeFolder } from './chat-list-sections';

const NOW = 10 * 24 * 60 * 60 * 1000;
const DEFAULT = '/Users/me/.antseed/chat-workspace';
const conv = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, updatedAt: NOW - 1000, ...extra });
const ids = (list: Record<string, unknown>[]) => list.map((c) => c.id);

describe('buildChatSections', () => {
  it('keeps a plain list when nothing is pinned, in a project or archived', () => {
    const sections = buildChatSections([conv('a'), conv('b', { workspacePath: DEFAULT })], { defaultWorkspace: DEFAULT });
    expect(sections.map((s) => s.kind)).toEqual(['chats']);
    expect(ids(sections[0]!.conversations)).toEqual(['a', 'b']);
  });

  it('orders Pinned, projects by latest activity, Chats, then Archived', () => {
    const sections = buildChatSections([
      conv('loose'),
      conv('old-proj', { workspacePath: '/code/motion', updatedAt: NOW - 3_000 }),
      conv('new-proj', { workspacePath: '/code/antseed/', updatedAt: NOW - 500 }),
      conv('pin-old', { pinnedAt: 1, workspacePath: '/code/antseed' }),
      conv('pin-new', { pinnedAt: 2 }),
      conv('gone', { archivedAt: 5, workspacePath: '/code/motion' }),
    ], { defaultWorkspace: DEFAULT });

    expect(sections.map((s) => [s.kind, s.label])).toEqual([
      ['pinned', 'Pinned'],
      ['project', 'antseed'],
      ['project', 'motion'],
      ['chats', 'Chats'],
      ['archived', 'Archived'],
    ]);
    expect(ids(sections[0]!.conversations)).toEqual(['pin-new', 'pin-old']);
    expect(sections[1]!.path).toBe('/code/antseed');
    expect(ids(sections[4]!.conversations)).toEqual(['gone']);
  });

  it('tells two folders with the same name apart by their parent', () => {
    const sections = buildChatSections([
      conv('a', { workspacePath: '/work/client-a/app' }),
      conv('b', { workspacePath: '/work/client-b/app' }),
    ], { defaultWorkspace: DEFAULT });
    expect(sections.map((s) => s.label).sort()).toEqual(['app · client-a', 'app · client-b']);
  });

  it('puts chats touched in the last day above older ones inside a section', () => {
    const sections = buildChatSections([
      conv('old', { workspacePath: '/p', updatedAt: NOW - 3 * 24 * 60 * 60 * 1000 }),
      conv('today', { workspacePath: '/p', updatedAt: NOW - 60_000 }),
    ], { defaultWorkspace: DEFAULT });
    expect(ids(sections[0]!.conversations)).toEqual(['today', 'old']);
  });
});

it('normalizes folder paths and names', () => {
  expect(normalizeFolder('/a/b/')).toBe('/a/b');
  expect(normalizeFolder('C:\\\\code\\\\app\\\\')).toBe('C:\\\\code\\\\app');
  expect(normalizeFolder('/')).toBe('/');
  expect(folderName('/Users/me/MotionAI')).toBe('MotionAI');
  expect(folderName('C:\\\\code\\\\app')).toBe('app');
});
