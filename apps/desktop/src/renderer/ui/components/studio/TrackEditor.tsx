import { useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { ActionMenu, Button, IconButton, Modal, Segmented } from '@antseed/ui';
import { HugeiconsIcon } from '@hugeicons/react';
import { MoreHorizontalIcon, PlayIcon, StopIcon, Undo02Icon } from '@hugeicons/core-free-icons';
import { sumStudioCost, type StudioProjectDetail } from '../../../../shared/studio.js';
import {
  anchorName,
  clipName,
  clipPlaySeconds,
  clipsTouching,
  clipState,
  exportCheck,
  MAX_CLIP_SECONDS,
  MIN_CLIP_SECONDS,
  STUDIO_ASPECT_RATIOS,
  trackRuntime,
  type StudioLibraryItem,
  type StudioTrack,
  type TrackAnchor,
  type TrackEdit,
} from '../../../../shared/studio-track.js';
import { formatStudioUsd, studioFileUrl } from '../../../modules/studio/board-view';
import { clipRequestMessage, formatSeconds, formatTimecode, selectionContext, type TrackSelection } from '../../../modules/studio/track-view';
import type { ChatContext } from '../views/ChatView';
import styles from './TrackEditor.module.scss';

const FILE_DRAG = 'application/x-antseed-studio-file';
const SHOT_DRAG = 'application/x-antseed-studio-shot';
const IMAGE_FILE = /\.(png|jpe?g|webp|gif)$/i;
const VIDEO_FILE = /\.(mp4|m4v|mov|webm)$/i;

type Selection = TrackSelection | null;

type Props = {
  detail: StudioProjectDetail & { track: StudioTrack };
  canSend: boolean;
  onSend: (text: string) => void;
  /** The selection, for the chip in the chat composer. */
  onContext: (context: ChatContext | null) => void;
  onChanged: () => void;
};

export function TrackEditor({ detail, canSend, onSend, onContext, onChanged }: Props) {
  const projectId = detail.project.id;
  const [track, setTrack] = useState(detail.track);
  const [selection, setSelection] = useState<Selection>(null);
  const [time, setTime] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [replacing, setReplacing] = useState<{ anchor: string; file: string } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [confirmExport, setConfirmExport] = useState(false);
  const [exporting, setExporting] = useState(false);
  const libraryRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (libraryOpen) libraryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [libraryOpen]);
  const imported = useRef<string[]>([]);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  // The file on disk wins whenever it changes, for example after the agent delivers a clip.
  useEffect(() => { setTrack(detail.track); }, [detail.track]);

  const url = (file: string) => studioFileUrl(projectId, file, detail.files[file]);
  const selected = selection ? track.anchors.find((anchor) => anchor.id === selection.anchor) ?? null : null;
  const selectedIndex = selected ? track.anchors.indexOf(selected) : -1;

  // What is selected travels with the next chat message, as a chip.
  useEffect(() => {
    if (!selection || !selected) {
      onContext(null);
      return;
    }
    const context = selectionContext(track, selection, time);
    const thumbnail = selected.image ? url(selected.image) : null;
    onContext(context ? { ...context, thumbnail } : null);
  }, [selection, track, time]); // eslint-disable-line react-hooks/exhaustive-deps

  function select(next: Selection) {
    setPlaying(false);
    setTime(null);
    setSelection(next);
  }

  async function edit(change: TrackEdit): Promise<StudioTrack | null> {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await window.antseedDesktop?.studioEdit?.(projectId, change);
      if (!result?.ok || !result.data) throw new Error(result?.error ?? 'Restart the desktop to edit the track.');
      imported.current = result.data.imported ?? [];
      if (mounted.current) {
        setTrack(result.data.track);
        if (result.data.message) setMessage(result.data.message);
      }
      onChanged();
      return result.data.track;
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err));
      return null;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function exportFilm() {
    setExporting(true);
    try {
      await edit({ type: 'export' });
    } finally {
      if (mounted.current) setExporting(false);
    }
  }

  /** Replacing an image the clips around it were made from asks first. */
  function replaceImage(anchorId: string, file: string, source: StudioTrack = track) {
    const anchor = source.anchors.find((entry) => entry.id === anchorId);
    if (!anchor || anchor.image === file) return;
    if (clipsTouching(source, anchorId, file).length > 0) setReplacing({ anchor: anchorId, file });
    else void edit({ type: 'set-image', anchor: anchorId, file });
  }

  /** An upload for one shot goes through the same check as a picture from the library. */
  async function uploadFor(anchorId: string) {
    const next = await edit({ type: 'import', anchor: anchorId });
    const file = imported.current[0];
    if (next && file) replaceImage(anchorId, file, next);
  }

  async function insertImage(file: string) {
    const index = selected ? selectedIndex + 1 : track.anchors.length;
    const next = await edit({ type: 'add-anchor', index, file });
    const added = next?.anchors[index];
    if (added) select({ anchor: added.id, clip: false });
  }

  async function addAtEnd(scene: 'continue' | 'new', file: string | null = null) {
    const next = await edit({ type: 'add-anchor', index: track.anchors.length, file, scene });
    const added = next?.anchors.at(-1);
    if (added) select({ anchor: added.id, clip: false });
  }

  const check = exportCheck(track);
  const runtime = trackRuntime(track);
  const spent = sumStudioCost(track.spent);
  const notices = [...(detail.trackError ? [`${detail.trackError}.`] : []), ...detail.notices];
  const canPlay = track.anchors.some((anchor) => anchor.clip?.use);

  return (
    <div className={styles.editor}>
      <div className={styles.toolbar}>
        <p className={styles.facts}>
          {track.anchors.length > 0 ? formatTimecode(runtime).replace(/\.\d$/, '') : ''}
          {spent > 0 ? <span title="What the agent reported for each delivered file">{track.anchors.length > 0 ? ' · ' : ''}{formatStudioUsd(spent)} spent</span> : null}
        </p>
        <div className={styles.actions}>
        <IconButton label={playing ? 'Stop' : 'Play the film'} disabled={!canPlay} onClick={() => setPlaying(!playing)}>
          <HugeiconsIcon icon={playing ? StopIcon : PlayIcon} size={16} strokeWidth={1.8} />
        </IconButton>
        <IconButton
          label={detail.canUndo ? 'Undo your last edit. Delivered files and what was spent stay.' : 'Nothing to undo yet'}
          disabled={busy || !detail.canUndo}
          onClick={() => { void edit({ type: 'undo' }); }}
        >
          <HugeiconsIcon icon={Undo02Icon} size={16} strokeWidth={1.8} />
        </IconButton>
        <Button size="sm" variant="outline" aria-pressed={libraryOpen} onClick={() => setLibraryOpen(!libraryOpen)}>Library</Button>
        <Button
          size="sm"
          variant="brand"
          disabled={busy || check.blockers.length > 0}
          title={check.blockers[0] ?? 'Join the clips into one video in this project folder'}
          onClick={() => { if (check.stale.length > 0) setConfirmExport(true); else void exportFilm(); }}
        >
          {exporting ? 'Exporting…' : 'Export'}
        </Button>
        <ActionMenu
          label="Film settings"
          trigger={<HugeiconsIcon icon={MoreHorizontalIcon} size={16} strokeWidth={1.8} />}
          items={STUDIO_ASPECT_RATIOS.map((ratio) => ({
            section: 'Frame shape',
            label: ratio,
            checked: track.aspectRatio === ratio,
            onSelect: () => { void edit({ type: 'aspect', aspectRatio: ratio }); },
          }))}
        />
        </div>
      </div>

      {notices.map((notice, index) => (
        <Notice key={notice} warning>
          {notice}
          {index === notices.length - 1 && detail.notices.length > 0 ? (
            <> <Button size="sm" variant="link" className={styles.dismiss} onClick={() => { void edit({ type: 'dismiss-notices' }); }}>Dismiss</Button></>
          ) : null}
        </Notice>
      ))}
      {error ? <Notice warning role="alert">{error}</Notice> : null}
      {message ? <Notice>{message}</Notice> : null}

      {track.anchors.length === 0 ? (
        <EmptyStart busy={busy} onUpload={() => { void edit({ type: 'import', index: 0 }); }} onLibrary={() => setLibraryOpen(true)} />
      ) : (
        <>
          <Preview
            track={track}
            selected={selected}
            selection={selection}
            playing={playing}
            busy={busy}
            url={url}
            onStop={() => setPlaying(false)}
            onSelect={select}
            onTime={setTime}
            onTrim={(end) => { if (selected) void edit({ type: 'trim', anchor: selected.id, end }); }}
            onResetTrim={() => { if (selected) void edit({ type: 'reset-trim', anchor: selected.id }); }}
            onUpload={() => { if (selected) void uploadFor(selected.id); }}
            onLibrary={() => setLibraryOpen(true)}
            onDropImage={(file) => { if (selected) replaceImage(selected.id, file); }}
          />
          <Storyboard
            track={track}
            selection={selection}
            busy={busy}
            url={url}
            onSelect={select}
            edit={edit}
            onDropImage={replaceImage}
            onDropVideo={(anchor, file) => { void edit({ type: 'add-version', anchor, file }); }}
            onAddAtEnd={(scene, file) => { void addAtEnd(scene, file); }}
            onUpload={(anchor) => { void uploadFor(anchor); }}
            onLibrary={() => setLibraryOpen(true)}
          />
        </>
      )}

      {libraryOpen ? (
        <div ref={libraryRef}>
          <Library
            items={detail.library}
            track={track}
            selection={selection}
            busy={busy}
            url={url}
            onUpload={() => { void edit({ type: 'import' }); }}
            onUseImage={(file) => { if (selected) replaceImage(selected.id, file); }}
            onInsertImage={(file) => { void insertImage(file); }}
            onUseVideo={(file) => { if (selected) void edit({ type: 'add-version', anchor: selected.id, file }); }}
            onClose={() => setLibraryOpen(false)}
          />
        </div>
      ) : null}

      {replacing ? (
        <ReplaceDialog
          track={track}
          anchorId={replacing.anchor}
          file={replacing.file}
          canSend={canSend}
          onCancel={() => setReplacing(null)}
          onReplace={async (remake) => {
            const target = replacing;
            setReplacing(null);
            const touching = clipsTouching(track, target.anchor, target.file);
            const next = await edit({ type: 'set-image', anchor: target.anchor, file: target.file });
            if (!next || !remake) return;
            const asked = await edit({ type: 'request', clips: touching, images: [] });
            if (asked) onSend(clipRequestMessage(asked, touching));
          }}
        />
      ) : null}

      {confirmExport ? (
        <Modal isOpen onClose={() => setConfirmExport(false)} title="Export with earlier clips?" size="sm">
          <p className={styles.dialogText}>{check.stale.join(', ')} {check.stale.length === 1 ? 'was' : 'were'} made from an image you have since replaced. The export uses {check.stale.length === 1 ? 'it' : 'them'} as {check.stale.length === 1 ? 'it is' : 'they are'}.</p>
          <div className={styles.dialogActions}>
            <Button variant="ghost" onClick={() => setConfirmExport(false)}>Cancel</Button>
            <Button onClick={() => { setConfirmExport(false); void exportFilm(); }}>Export as it is</Button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function Notice({ children, warning = false, role = 'status' }: { children: ReactNode; warning?: boolean; role?: 'status' | 'alert' }) {
  return <p className={styles.notice} role={role}><span className={`${styles.dot} ${warning ? styles.dotWarning : ''}`} aria-hidden="true" />{children}</p>;
}

function dragFile(event: DragEvent): string | null {
  return event.dataTransfer.getData(FILE_DRAG) || null;
}

function EmptyStart({ busy, onUpload, onLibrary }: { busy: boolean; onUpload: () => void; onLibrary: () => void }) {
  return (
    <div className={styles.empty}>
      <p className={styles.emptyText}>Add the images your film moves between, or tell the agent what the film is about.</p>
      <div className={styles.row}>
        <Button disabled={busy} onClick={onUpload}>Upload images…</Button>
        <Button variant="outline" disabled={busy} onClick={onLibrary}>From the library</Button>
      </div>
    </div>
  );
}

// ---------- preview ----------

function Preview({ track, selected, selection, playing, busy, url, onStop, onSelect, onTime, onTrim, onResetTrim, onUpload, onLibrary, onDropImage }: {
  track: StudioTrack;
  selected: TrackAnchor | null;
  selection: Selection;
  playing: boolean;
  busy: boolean;
  url: (file: string) => string;
  onStop: () => void;
  onSelect: (selection: Selection) => void;
  onTime: (time: number | null) => void;
  onTrim: (end: number) => void;
  onResetTrim: () => void;
  onUpload: () => void;
  onLibrary: () => void;
  onDropImage: (file: string) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [now, setNow] = useState(0);
  const [position, setPosition] = useState(0);
  // The time shown belongs to the clip on screen, so it starts again with each one.
  useEffect(() => { setNow(0); }, [selection?.anchor, selection?.clip]);
  const playable = track.anchors.filter((anchor) => anchor.clip?.use);
  const [w, h] = track.aspectRatio.split(':').map(Number) as [number, number];
  // The frame keeps the film's shape and fits the width, or 62% of the window height for a tall film.
  const frame = { aspectRatio: `${String(w)} / ${String(h)}`, ['--ar' as string]: String(w / h) };

  useEffect(() => {
    if (!playing) return;
    const first = track.anchors.findIndex((anchor) => anchor.clip?.use);
    setPosition(Math.max(0, first));
  }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps

  if (playing) {
    const anchor = track.anchors[position];
    const clip = anchor?.clip;
    const advance = () => {
      const following = track.anchors[position + 1];
      const isLast = position + 1 >= track.anchors.length - 1;
      if (following?.clip?.use) setPosition(position + 1);
      else if (!following || isLast) onStop();
      else {
        // An empty gap: stop there and show it, rather than skip over it.
        onSelect({ anchor: following.id, clip: true });
        onStop();
      }
    };
    if (!anchor || !clip?.use) return <div className={styles.preview} style={frame}><span className={styles.placeholder}>Nothing to play yet.</span></div>;
    return (
      <figure className={styles.stage}>
        <div className={styles.preview} style={frame}>
          <video
            key={`${anchor.id}:${clip.use}`}
            className={styles.media}
            src={url(clip.use)}
            autoPlay
            muted
            playsInline
            onTimeUpdate={(event) => { if (clip.end !== null && event.currentTarget.currentTime >= clip.end) advance(); }}
            onEnded={advance}
          />
        </div>
        <figcaption className={styles.captionRow}><span className={styles.caption}>{clipName(track, anchor.id)} · {playable.indexOf(anchor) + 1} of {playable.length}</span></figcaption>
      </figure>
    );
  }

  const shown = selected ?? track.anchors.find((anchor) => anchor.image) ?? track.anchors[0]!;
  const index = track.anchors.indexOf(shown);

  if (!selection?.clip) {
    const before = track.anchors[index - 1];
    return (
      <figure className={styles.stage}>
        <div
          className={styles.preview}
          style={frame}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => { event.preventDefault(); const file = dragFile(event); if (file && IMAGE_FILE.test(file) && selected) onDropImage(file); }}
        >
          {shown.image ? <img className={styles.media} src={url(shown.image)} alt={anchorName(track, shown.id)} /> : (
            <div className={styles.dropZone}>
              <span>{anchorName(track, shown.id)} has no image yet. Drop one here, or ask the agent for it.</span>
              {selected ? (
                <div className={styles.row}>
                  <Button size="sm" variant="outline" disabled={busy} onClick={onUpload}>Upload image…</Button>
                  <Button size="sm" variant="ghost" onClick={onLibrary}>From the library</Button>
                </div>
              ) : null}
            </div>
          )}
        </div>
        <figcaption className={styles.captionRow}>
          {selected && shown.from && before?.clip?.id === shown.from.clip ? <span className={styles.caption}>Frame at {formatSeconds(shown.from.at)} of {clipName(track, before.id)}</span> : null}
        </figcaption>
      </figure>
    );
  }

  const clip = shown.clip;
  const next = track.anchors[index + 1];
  if (!clip?.use) {
    const landsOn = next && clip?.then !== 'cut' ? next : null;
    return (
      <figure className={styles.stage}>
        <div className={`${styles.preview} ${styles.previewPair}`} style={frame}>
          <Frame file={shown.image} url={url} label={anchorName(track, shown.id)} />
          <span className={styles.pairArrow}>{clip ? `${String(clip.plannedSeconds)} s` : ''} →</span>
          {landsOn ? <Frame file={landsOn.image} url={url} label={anchorName(track, landsOn.id)} /> : <span className={styles.pairOpen}>{next ? 'Cut' : 'Ends freely'}</span>}
        </div>
        <figcaption className={styles.captionRow}><span className={styles.caption}>{clipName(track, shown.id)} is empty. Say in the chat what should happen; the agent quotes it first.</span></figcaption>
      </figure>
    );
  }

  const end = clip.end;
  return (
    <figure className={styles.stage}>
      <div className={styles.preview} style={frame}>
        <video
          key={clip.use}
          ref={video}
          className={styles.media}
          src={url(clip.use)}
          controls
          muted
          playsInline
          preload="metadata"
          onTimeUpdate={(event) => {
            const at = event.currentTarget.currentTime;
            setNow(at);
            // The trimmed clip stops at its end frame, as it will in the film.
            if (end !== null && at > end + 0.05 && !event.currentTarget.paused) {
              event.currentTarget.pause();
              event.currentTarget.currentTime = end;
            }
          }}
          onPause={(event) => onTime(event.currentTarget.currentTime)}
          onSeeked={(event) => { if (event.currentTarget.paused) onTime(event.currentTarget.currentTime); }}
        />
      </div>
      <figcaption className={styles.captionRow}>
        <span className={styles.caption}>{formatTimecode(now)}{end !== null ? ` · ends at ${formatSeconds(end)}` : ''}</span>
        <Button size="sm" variant="outline" disabled={busy || now < 0.1} onClick={() => { video.current?.pause(); onTrim(video.current?.currentTime ?? now); }}>End clip here</Button>
        {end !== null ? <Button size="sm" variant="link" disabled={busy} onClick={onResetTrim}>Reset end</Button> : null}
      </figcaption>
    </figure>
  );
}

function Frame({ file, url, label }: { file: string | null; url: (file: string) => string; label: string }) {
  return file ? <img className={styles.pairFrame} src={url(file)} alt={label} /> : <span className={`${styles.pairFrame} ${styles.pairMissing}`}>{label}</span>;
}

// ---------- storyboard ----------

function Storyboard({ track, selection, busy, url, onSelect, edit, onDropImage, onDropVideo, onAddAtEnd, onUpload, onLibrary }: {
  track: StudioTrack;
  selection: Selection;
  busy: boolean;
  url: (file: string) => string;
  onSelect: (selection: Selection) => void;
  edit: (change: TrackEdit) => Promise<StudioTrack | null>;
  onDropImage: (anchor: string, file: string) => void;
  onDropVideo: (anchor: string, file: string) => void;
  onAddAtEnd: (scene: 'continue' | 'new', file: string | null) => void;
  onUpload: (anchor: string) => void;
  onLibrary: () => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  // Every image on the strip has the same box: 92 px wide, or 96 px tall for a tall frame.
  const [w, h] = track.aspectRatio.split(':').map(Number) as [number, number];
  const size = w >= h ? { width: 92, height: Math.round((92 * h) / w) } : { width: Math.round((96 * w) / h), height: 96 };
  return (
    <div className={styles.storyboard}>
      <ol className={styles.strip} aria-label="Storyboard" style={{ ['--row-h' as string]: `${String(Math.max(size.height, 52))}px` }}>
        {track.anchors.map((anchor, index) => (
          <Shot
            key={anchor.id}
            track={track}
            anchor={anchor}
            index={index}
            size={size}
            selection={selection}
            busy={busy}
            renaming={renaming === anchor.id}
            url={url}
            onSelect={onSelect}
            onRename={(on) => setRenaming(on ? anchor.id : null)}
            edit={edit}
            onDropImage={onDropImage}
            onDropVideo={onDropVideo}
            onUpload={onUpload}
            onLibrary={onLibrary}
          />
        ))}
        <li
          className={`${styles.shot} ${styles.addEnd}`}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => { event.preventDefault(); const file = dragFile(event); if (file && IMAGE_FILE.test(file)) onAddAtEnd('continue', file); }}
        >
          <div className={styles.shotHead} />
          <div className={styles.shotRow}>
          <ActionMenu
            label="Add a shot"
            align="start"
            width={220}
            triggerStyle="plain"
            className={styles.addButton}
            trigger={<span aria-hidden="true">+</span>}
            items={[
              { label: 'Continue scene', description: 'The last clip lands on the new image', disabled: busy, onSelect: () => onAddAtEnd('continue', null) },
              { label: 'New scene', description: 'A cut, then the new image', disabled: busy, onSelect: () => onAddAtEnd('new', null) },
            ]}
          />
          </div>
        </li>
      </ol>
    </div>
  );
}

function Shot({ track, anchor, index, size, selection, busy, renaming, url, onSelect, onRename, edit, onDropImage, onDropVideo, onUpload, onLibrary }: {
  track: StudioTrack;
  anchor: TrackAnchor;
  index: number;
  size: { width: number; height: number };
  selection: Selection;
  busy: boolean;
  renaming: boolean;
  url: (file: string) => string;
  onSelect: (selection: Selection) => void;
  onRename: (on: boolean) => void;
  edit: (change: TrackEdit) => Promise<StudioTrack | null>;
  onDropImage: (anchor: string, file: string) => void;
  onDropVideo: (anchor: string, file: string) => void;
  onUpload: (anchor: string) => void;
  onLibrary: () => void;
}) {
  const next = track.anchors[index + 1];
  const clip = anchor.clip;
  const state = clip ? clipState(track, index) : null;
  const imageSelected = selection?.anchor === anchor.id && !selection.clip;
  const clipSelected = selection?.anchor === anchor.id && selection.clip;
  const active = selection?.anchor === anchor.id;
  const title = `${String(index + 1)}.${anchor.title ? ` ${anchor.title}` : ''}`;
  const item = useRef<HTMLLIElement>(null);
  // The selected shot stays in view on the strip, a new one at the end included.
  useEffect(() => {
    if (!active) return undefined;
    // After layout, so a shot just added at the end is measured before the strip scrolls to it.
    const frame = requestAnimationFrame(() => item.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [active, selection?.clip, track.anchors.length]);

  const menu = [
    { section: anchorName(track, anchor.id), label: 'Rename', onSelect: () => onRename(true) },
    { section: anchorName(track, anchor.id), label: 'Upload image…', disabled: busy, onSelect: () => onUpload(anchor.id) },
    { section: anchorName(track, anchor.id), label: 'From the library…', onSelect: () => { onSelect({ anchor: anchor.id, clip: false }); onLibrary(); } },
    ...anchor.earlier.map((file) => ({ section: 'Earlier images', label: track.labels[file] ?? file.split('/').pop() ?? file, disabled: busy, onSelect: () => onDropImage(anchor.id, file) })),
    ...(clip?.versions ?? []).map((version, number) => ({
      section: `Versions of ${clipName(track, anchor.id)}`,
      label: `v${String(number + 1)}${version.seconds ? ` · ${formatSeconds(version.seconds)}` : ''}${version.label ? ` · ${version.label}` : ''}`,
      checked: version.file === clip?.use,
      disabled: busy,
      onSelect: () => { void edit({ type: 'use-version', anchor: anchor.id, file: version.file }); },
    })),
    { section: 'Order', label: 'Move earlier', disabled: busy || index === 0, onSelect: () => { void edit({ type: 'move-anchor', anchor: anchor.id, to: index - 1 }); } },
    { section: 'Order', label: 'Move later', disabled: busy || !next, onSelect: () => { void edit({ type: 'move-anchor', anchor: anchor.id, to: index + 1 }); } },
    { section: 'Order', label: 'Remove from track', description: 'Its files stay in the library', tone: 'danger' as const, disabled: busy, onSelect: () => { void edit({ type: 'remove-anchor', anchor: anchor.id }).then((done) => { if (done) onSelect(null); }); } },
  ];

  return (
    <li
      ref={item}
      className={`${styles.shot} ${active ? styles.shotActive : ''}`}
      onDragOver={(event) => { if (event.dataTransfer.types.includes(SHOT_DRAG)) event.preventDefault(); }}
      onDrop={(event) => {
        const moved = event.dataTransfer.getData(SHOT_DRAG);
        if (!moved || moved === anchor.id) return;
        event.preventDefault();
        void edit({ type: 'move-anchor', anchor: moved, to: index });
      }}
    >
      <div className={styles.shotHead}>
        {renaming ? (
          <input
            className={styles.titleInput}
            aria-label={`Title of ${anchorName(track, anchor.id)}`}
            defaultValue={anchor.title}
            placeholder="Shot title"
            maxLength={120}
            autoFocus
            onBlur={(event) => { onRename(false); if (event.target.value.trim() !== anchor.title) void edit({ type: 'title', anchor: anchor.id, title: event.target.value }); }}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { event.currentTarget.value = anchor.title; event.currentTarget.blur(); } }}
          />
        ) : (
          <span
            className={styles.title}
            title={`${title} · double-click to rename, drag to reorder`}
            draggable
            onDragStart={(event) => { event.dataTransfer.setData(SHOT_DRAG, anchor.id); event.dataTransfer.effectAllowed = 'move'; }}
            onDoubleClick={() => onRename(true)}
            onClick={() => onSelect({ anchor: anchor.id, clip: false })}
          >
            {title}
          </span>
        )}
        {active ? (
          <ActionMenu
            label={`Actions for ${anchorName(track, anchor.id)}`}
            width={230}
            className={styles.shotMenu}
            trigger={<HugeiconsIcon icon={MoreHorizontalIcon} size={14} strokeWidth={1.8} />}
            items={menu}
          />
        ) : null}
      </div>
      <div className={styles.shotRow}>
        <button
          type="button"
          className={styles.image}
          style={{ width: `${String(size.width)}px`, height: `${String(size.height)}px` }}
          aria-pressed={imageSelected}
          aria-label={anchorName(track, anchor.id)}
          onClick={() => onSelect({ anchor: anchor.id, clip: false })}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => { const file = dragFile(event); if (file && IMAGE_FILE.test(file)) { event.preventDefault(); onDropImage(anchor.id, file); } }}
        >
          {anchor.image ? <img src={url(anchor.image)} alt="" draggable={false} /> : <span className={styles.imageEmpty}>+</span>}
        </button>
        {clip ? (
          <ClipTile
            track={track}
            anchor={anchor}
            selected={clipSelected}
            busy={busy}
            stale={state === 'stale'}
            onSelect={() => onSelect({ anchor: anchor.id, clip: true })}
            onLength={(seconds) => { void edit({ type: 'clip', anchor: anchor.id, plannedSeconds: seconds }); }}
            onDropVideo={(file) => onDropVideo(anchor.id, file)}
          />
        ) : null}
        {clip && next ? (
          <ActionMenu
            label={`After ${clipName(track, anchor.id)}: ${clip.then === 'cut' ? 'Cut' : clip.then === 'extend' ? 'Extend' : 'not chosen'}`}
            align="start"
            width={240}
            triggerStyle="plain"
            className={`${styles.marker} ${clip.then === null ? styles.markerOpen : ''}`}
            trigger={<span aria-hidden="true">{clip.then === 'cut' ? '✂' : clip.then === 'extend' ? '→' : '?'}</span>}
            items={[
              { label: `Cut to ${anchorName(track, next.id)}`, description: 'A hard cut; a new scene starts', checked: clip.then === 'cut', disabled: busy, onSelect: () => { void edit({ type: 'then', anchor: anchor.id, then: 'cut' }); } },
              {
                label: clip.end !== null && next.from?.clip !== clip.id ? 'Extend from this frame' : `Extend into ${anchorName(track, next.id)}`,
                description: clip.end !== null && next.from?.clip !== clip.id ? `The end frame becomes ${anchorName(track, next.id)}` : `The clip lands on ${anchorName(track, next.id)}`,
                checked: clip.then === 'extend',
                disabled: busy,
                onSelect: () => { void edit({ type: 'then', anchor: anchor.id, then: 'extend' }); },
              },
            ]}
          />
        ) : null}
      </div>
    </li>
  );
}

const PX_PER_SECOND = 14;

function ClipTile({ track, anchor, selected, busy, stale, onSelect, onLength, onDropVideo }: {
  track: StudioTrack;
  anchor: TrackAnchor;
  selected: boolean;
  busy: boolean;
  stale: boolean;
  onSelect: () => void;
  onLength: (seconds: number) => void;
  onDropVideo: (file: string) => void;
}) {
  const clip = anchor.clip!;
  const [dragging, setDragging] = useState<{ x: number; from: number; seconds: number } | null>(null);
  const seconds = dragging?.seconds ?? (clip.use ? clipPlaySeconds(clip) : clip.plannedSeconds);
  const width = Math.max(84, Math.min(220, 56 + seconds * 8));
  const empty = !clip.use;

  const startDrag = (event: ReactPointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging({ x: event.clientX, from: clip.plannedSeconds, seconds: clip.plannedSeconds });
  };
  const moveDrag = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!dragging) return;
    const value = Math.round(dragging.from + (event.clientX - dragging.x) / PX_PER_SECOND);
    setDragging({ ...dragging, seconds: Math.max(MIN_CLIP_SECONDS, Math.min(MAX_CLIP_SECONDS, value)) });
  };
  const endDrag = () => {
    if (!dragging) return;
    if (dragging.seconds !== clip.plannedSeconds) onLength(dragging.seconds);
    setDragging(null);
  };

  return (
    <div className={styles.clipWrap} style={{ width: `${String(width)}px` }}>
      <button
        type="button"
        className={`${styles.clip} ${empty ? styles.clipEmpty : ''}`}
        aria-pressed={selected}
        aria-label={`${clipName(track, anchor.id)}, ${empty ? `empty, ${String(clip.plannedSeconds)} s planned` : stale ? 'made from an earlier image' : 'ready'}`}
        title={stale ? 'Made from an image you have since replaced' : undefined}
        onClick={onSelect}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => { const file = dragFile(event); if (file && VIDEO_FILE.test(file)) { event.preventDefault(); onDropVideo(file); } }}
      >
        <span className={styles.clipName}>{clipName(track, anchor.id).replace('Clip ', '')}</span>
        <span className={styles.clipMeta}>{stale ? <span className={`${styles.dot} ${styles.dotWarning}`} aria-hidden="true" /> : null}{formatSeconds(seconds)}</span>
      </button>
      {empty && selected ? (
        <span
          className={styles.lengthHandle}
          role="slider"
          tabIndex={0}
          aria-label="Length to make"
          aria-valuemin={MIN_CLIP_SECONDS}
          aria-valuemax={MAX_CLIP_SECONDS}
          aria-valuenow={seconds}
          aria-disabled={busy}
          title="Drag to change the length to make"
          onPointerDown={busy ? undefined : startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={() => setDragging(null)}
          onKeyDown={(event) => {
            if (busy) return;
            const step = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0;
            if (!step) return;
            event.preventDefault();
            const value = Math.max(MIN_CLIP_SECONDS, Math.min(MAX_CLIP_SECONDS, clip.plannedSeconds + step));
            if (value !== clip.plannedSeconds) onLength(value);
          }}
        >
          {dragging ? <span className={styles.lengthTip}>{formatSeconds(dragging.seconds)}</span> : null}
        </span>
      ) : null}
    </div>
  );
}

// ---------- library ----------

const LIBRARY_STATUS: Record<StudioLibraryItem['status'], string | null> = { 'in-use': 'In use', earlier: 'Earlier version', export: 'Export', unused: null };

function Library({ items, track, selection, busy, url, onUpload, onUseImage, onInsertImage, onUseVideo, onClose }: {
  items: StudioLibraryItem[];
  track: StudioTrack;
  selection: Selection;
  busy: boolean;
  url: (file: string) => string;
  onUpload: () => void;
  onUseImage: (file: string) => void;
  onInsertImage: (file: string) => void;
  onUseVideo: (file: string) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<'all' | 'image' | 'video'>('all');
  const [picked, pick] = useState<string | null>(null);
  const shown = items.filter((item) => filter === 'all' || item.kind === filter);
  const item = items.find((entry) => entry.file === picked) ?? null;
  const target = selection ? (selection.clip ? clipName(track, selection.anchor) : anchorName(track, selection.anchor)) : null;
  return (
    <section className={styles.library} aria-label="Library">
      <div className={styles.libraryHead}>
        <h3 className={styles.heading}>Library</h3>
        <Segmented label="Show" value={filter} options={[{ value: 'all', label: 'All' }, { value: 'image', label: 'Images' }, { value: 'video', label: 'Videos' }]} onChange={setFilter} />
        <Button size="sm" variant="outline" disabled={busy} onClick={onUpload}>Upload…</Button>
        <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
      </div>
      <p className={styles.hint}>Everything this project has made or been given, earlier versions included. Drag a picture onto a shot, a video onto a clip, or pick one.</p>
      {shown.length === 0 ? <p className={styles.hint}>Nothing here yet.</p> : (
        <ul className={styles.libraryGrid}>
          {shown.map((entry) => (
            <li key={entry.file}>
              <button
                type="button"
                className={styles.libraryItem}
                aria-pressed={picked === entry.file}
                draggable
                onDragStart={(event) => { event.dataTransfer.setData(FILE_DRAG, entry.file); event.dataTransfer.effectAllowed = 'copy'; }}
                onClick={() => pick(picked === entry.file ? null : entry.file)}
                title={entry.file}
              >
                {entry.kind === 'image'
                  ? <img src={url(entry.file)} alt="" draggable={false} loading="lazy" />
                  : <video src={url(entry.file)} muted preload="metadata" />}
                <span className={styles.libraryLabel}>{entry.label}</span>
                {LIBRARY_STATUS[entry.status] ? <span className={styles.libraryStatus}>{LIBRARY_STATUS[entry.status]}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      {item ? (
        <div className={styles.row}>
          <span className={styles.hint}>{item.label}</span>
          {item.kind === 'image' && selection && !selection.clip ? <Button size="sm" disabled={busy} onClick={() => onUseImage(item.file)}>Use for {target}</Button> : null}
          {item.kind === 'image' ? <Button size="sm" variant="outline" disabled={busy} onClick={() => onInsertImage(item.file)}>{selection ? `Insert after ${anchorName(track, selection.anchor)}` : 'Add at the end'}</Button> : null}
          {item.kind === 'video' && selection?.clip ? <Button size="sm" disabled={busy} onClick={() => onUseVideo(item.file)}>Use for {target}</Button> : null}
          {item.kind === 'video' && !selection?.clip ? <span className={styles.hint}>Select a clip on the storyboard to use this video.</span> : null}
        </div>
      ) : null}
    </section>
  );
}

// ---------- replace ----------

function ReplaceDialog({ track, anchorId, file, canSend, onCancel, onReplace }: {
  track: StudioTrack;
  anchorId: string;
  file: string;
  canSend: boolean;
  onCancel: () => void;
  onReplace: (remake: boolean) => Promise<void>;
}) {
  const touching = clipsTouching(track, anchorId, file).map((id) => clipName(track, id));
  return (
    <Modal isOpen onClose={onCancel} title={`Replace the image of ${anchorName(track, anchorId)}?`} size="sm">
      <p className={styles.dialogText}>
        {touching.join(' and ')} {touching.length === 1 ? 'was' : 'were'} not made from this image. Make {touching.length === 1 ? 'it' : 'them'} again so the film matches, or keep {touching.length === 1 ? 'it' : 'them'} as {touching.length === 1 ? 'it is' : 'they are'}. The old image and clips stay in the library.
      </p>
      <div className={styles.dialogActions}>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button variant="outline" onClick={() => { void onReplace(false); }}>Replace image only</Button>
        <Button disabled={!canSend} onClick={() => { void onReplace(true); }}>Replace and get a quote</Button>
      </div>
    </Modal>
  );
}
