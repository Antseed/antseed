import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { TrackAnchor } from '../../../../shared/studio-track.js';
import { filmClipKey, filmIndex, filmPlayers, type FilmPlayback } from '../../../modules/studio/track-view';
import styles from './TrackEditor.module.scss';

/**
 * Plays clips back to back without a gap: two players take turns, the next
 * clip loaded and paused on its first frame under the one playing, so the
 * cut swaps them in the same frame. A trimmed clip ends on the frame where
 * its trim is, not at the next time update.
 */
export type FilmPlayerProps = {
  run: TrackAnchor[];
  frame: CSSProperties;
  url: (file: string) => string;
  caption: (anchor: TrackAnchor) => string;
  onDone: () => void;
  /** The clip playing left the film (an undo, or a delivery for it): playback stops. */
  onStop: () => void;
};

export function FilmPlayer({ run, frame, url, caption, onDone, onStop }: FilmPlayerProps) {
  const players = [useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null)] as const;
  // The clip playing, by key rather than position (the film can change while it plays), and the player showing it.
  const [playback, setPlayback] = useState<FilmPlayback>(() => ({ key: run[0] ? filmClipKey(run[0]) : '', slot: 0 }));
  const { index, players: loaded } = filmPlayers(run, playback);
  const latest = useRef({ run, playback });
  latest.current = { run, playback };
  const advanced = useRef('');
  const current = index === null ? null : run[index]!;
  const slot = playback.slot;
  const other = slot === 0 ? 1 : 0;

  const advance = (from: string) => {
    if (advanced.current === from) return;
    advanced.current = from;
    const { run: film, playback: now } = latest.current;
    const at = filmIndex(film, from);
    if (at === null) return;
    const next = film[at + 1];
    if (!next) {
      onDone();
      return;
    }
    // Started here, on the last frame, not after the next render: the next clip is already loaded in the other player.
    const nextSlot = now.slot === 0 ? 1 : 0;
    void players[nextSlot].current?.play().catch(() => {});
    setPlayback({ key: filmClipKey(next), slot: nextSlot });
  };

  useEffect(() => {
    if (index === null) onStop();
  }, [index === null]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (index === null || !current) return undefined;
    const active = players[slot].current;
    const idle = players[other].current;
    idle?.pause();
    if (idle) idle.currentTime = 0;
    if (!active) return undefined;
    if (active.paused) void active.play().catch(() => {});
    // Checked every frame: a trimmed clip stops where its trim is, and an untrimmed one
    // hands over on its last frame instead of waiting for the ended event.
    let frameId = requestAnimationFrame(function check() {
      const end = current.clip?.end ?? (Number.isFinite(active.duration) ? active.duration : null);
      if (end !== null && active.currentTime >= end - 1 / 30) advance(playback.key);
      else frameId = requestAnimationFrame(check);
    });
    return () => cancelAnimationFrame(frameId);
  }, [index, playback.key, slot]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <figure className={styles.stage}>
      <div className={`${styles.preview} ${styles.film}`} style={frame}>
        {([0, 1] as const).map((player) => {
          const anchor = loaded[player];
          const active = index !== null && slot === player;
          return (
            <video
              key={player}
              ref={players[player]}
              className={`${styles.media} ${active ? styles.filmActive : ''}`}
              src={anchor?.clip?.use ? url(anchor.clip.use) : undefined}
              preload="auto"
              muted
              playsInline
              aria-hidden={!active}
              onEnded={() => { if (active) advance(playback.key); }}
            />
          );
        })}
      </div>
      <figcaption className={styles.captionRow}><span className={styles.caption}>{current ? caption(current) : ''}</span></figcaption>
    </figure>
  );
}
