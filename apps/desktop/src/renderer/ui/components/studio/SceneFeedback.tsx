import { useState } from 'react';
import { Button, TextAreaField } from '@antseed/ui';
import styles from './DirectorDesk.module.scss';

export const NOTE_EXAMPLE = 'Keep the rain. Cut to the keeper sooner.';
export type SceneMark = { scene: string; title: string; file: string; time: number | null; region?: string; locked?: boolean };

export function sceneLabel(mark: SceneMark) {
  const seconds = Math.floor(mark.time ?? 0);
  return `Scene ${mark.scene}${mark.time === null ? '' : ` · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2,'0')} in this clip`}`;
}

export function feedbackRequest(mark: SceneMark, note: string) {
  return `${sceneLabel(mark)} — ${mark.title} (${mark.file || 'planned scene'}${mark.time === null ? '' : `, ${mark.time.toFixed(2)} seconds`}${mark.region ? `, region ${mark.region}` : ''}${mark.locked ? ', locked' : ''})\n${note.trim()}\nSuggest a specific fix. Explain what stays, what changes, and whether existing footage is enough or a paid render is needed. Quote any render before asking me to approve. Only propose the change; wait for my decision.`;
}

export function SceneFeedback({ current, capture, canSend, onSend }: { current: SceneMark; capture: () => SceneMark; canSend: boolean; onSend: (request: string) => void }) {
  const [pinned, pin] = useState<SceneMark | null>(null);
  const [text, write] = useState('');
  const [sent, acknowledge] = useState(false);
  const target = pinned ?? current;
  return <div className={styles.feedback}>
    <h3>{current.time !== null ? 'Pause here and leave a note' : 'Leave a note on this scene'}</h3>
    <p className={styles.hint}>{current.time !== null ? 'Play the clip above. Pause or drag to the moment you want to change, then write below. Clicking the box also pauses the clip.' : 'Describe what to keep and what to change. Your note includes the scene automatically.'}</p>
    <TextAreaField label={`Note for ${sceneLabel(target)} — ${target.title}`} rows={2} value={text} placeholder={`Example: “${NOTE_EXAMPLE}”`}
      onFocus={()=>{ if (!pinned) pin(capture()); acknowledge(false); }} onChange={e=>{ if (!pinned) pin(capture()); write(e.target.value); }}/>
    <div className={styles.row}><Button size="sm" disabled={!text.trim() || !canSend} onClick={()=>{onSend(feedbackRequest(pinned ?? capture(),text));write('');pin(null);acknowledge(true);}}>Suggest a fix</Button>
    {pinned && <Button size="sm" variant="link" onClick={()=>pin(capture())}>Use current selection</Button>}</div>
    <p className={styles.hint} role="status">{sent ? 'Note sent. Look in the project chat for the reply.' : !canSend ? 'Wait for the project chat to be ready before sending.' : 'Your scene and time stay attached while you write. The agent replies in chat with a proposal for you to review.'}</p>
  </div>;
}
