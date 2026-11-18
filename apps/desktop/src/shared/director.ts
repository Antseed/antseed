export type Take = { path: string; label: string };
export type Reference = Take & { role: string };
export type Edit = { takes: Take[]; keeper?: string; previous?: string; locked?: boolean; hold?: number };
export type Desk = { order: string[]; edits: Record<string, Edit>; shelf: Reference[]; lessons: string[]; importedShots?: { id: string; path: string; label: string }[] };
export const emptyDesk = (): Desk => ({ order: [], edits: {}, shelf: [], lessons: [] });
export type DeskAction =
  | { type: 'trim'; shot: string; source: string; end: number }
  | { type: 'keep' | 'add'; shot: string; source: string }
  | { type: 'undo' | 'lock'; shot: string }
  | { type: 'hold'; shot: string; seconds: number }
  | { type: 'order'; ids: string[] }
  | { type: 'import' }
  | { type: 'place'; source: string }
  | { type: 'role'; source: string; role: string }
  | { type: 'teach' | 'forget'; lesson: string };
