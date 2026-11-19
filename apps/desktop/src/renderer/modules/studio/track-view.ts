import {
  anchorName,
  clipName,
  sceneRuns,
  STUDIO_DELIVERIES_DIR,
  type StudioTrack,
} from '../../../shared/studio-track.js';

export function formatSeconds(value: number): string {
  return `${(Math.round(value * 10) / 10).toString()} s`;
}

export function formatTimecode(value: number): string {
  const whole = Math.max(0, value);
  const minutes = Math.floor(whole / 60);
  const seconds = whole - minutes * 60;
  return `${String(minutes)}:${seconds.toFixed(1).padStart(4, '0')}`;
}

function sceneLine(track: StudioTrack, anchorId: string): string | null {
  const run = sceneRuns(track).find((scene) => scene.anchors.includes(anchorId));
  if (!run) return null;
  const name = run.name ? `"${run.name}"` : '(no name yet)';
  return `- Scene ${String(run.number)} ${name}${run.world ? `: ${run.world}` : ''}`;
}

/**
 * The chat message that asks the project agent for clips. The agent quotes
 * first and only makes them after the user says yes in chat.
 */
export function clipRequestMessage(track: StudioTrack, anchorIds: string[]): string {
  const blocks = anchorIds.flatMap((anchorId) => {
    const index = track.anchors.findIndex((anchor) => anchor.id === anchorId);
    const anchor = track.anchors[index];
    const clip = anchor?.clip;
    if (!anchor || !clip) return [];
    const next = track.anchors[index + 1];
    const end = !next
      ? '- End frame: none. This is the last clip; it ends freely.'
      : clip.then === 'cut'
        ? `- End frame: none. Cut: the film cuts to ${anchorName(track, next.id)} after it, so it ends freely.`
        : `- End frame: ${next.image ?? '(no image yet)'} (${anchorName(track, next.id)}). Extend: the clip must land exactly on this image.`;
    return [[
      `${clipName(track, anchorId)} (clip ${clip.id})`,
      `- Start frame: ${anchor.image ?? '(no image yet)'} (${anchorName(track, anchorId)})`,
      end,
      `- Length: ${String(clip.plannedSeconds)} s`,
      sceneLine(track, anchorId),
      `- Direction: ${clip.prompt || 'none given; write one from the two frames and the scene.'}`,
    ].filter(Boolean).join('\n')];
  });
  const what = blocks.length === 1 ? 'this clip' : `these ${String(blocks.length)} clips`;
  return [
    `Please make ${what} for the track.`,
    ...blocks,
    `Quote one total price first (model, length, resolution) and wait for my yes. An Extend needs a model that takes a first and a last frame; if none is offered, say so instead of falling back. Deliver each file through ${STUDIO_DELIVERIES_DIR}/ as the antseed-studio skill says.`,
  ].join('\n\n');
}

export type TrackSelection = { anchor: string; clip: boolean };

/**
 * The chip in the chat composer: a short label for the user, and a line for
 * the agent with the ids, files and moment it needs to find what was meant.
 */
export function selectionContext(track: StudioTrack, selection: TrackSelection, time: number | null = null): { label: string; text: string } | null {
  const index = track.anchors.findIndex((anchor) => anchor.id === selection.anchor);
  const anchor = track.anchors[index];
  if (!anchor) return null;
  const shot = anchorName(track, anchor.id);
  if (!selection.clip) {
    const label = `${shot} · ${anchor.title || (anchor.image ? track.labels[anchor.image] ?? anchor.image.split('/').pop()! : 'no image yet')}`;
    const parts = [
      `${shot}${anchor.title ? ` "${anchor.title}"` : ''} (anchor ${anchor.id})`,
      anchor.image ? `image ${anchor.image}` : 'no image yet',
      `aspect ${track.aspectRatio}`,
    ];
    return { label, text: `[Studio: ${parts.join(' · ')}]` };
  }
  const clip = anchor.clip;
  if (!clip) return null;
  const next = track.anchors[index + 1];
  const name = clipName(track, anchor.id);
  const ending = !next
    ? 'last clip, ends freely'
    : clip.then === 'cut'
      ? `then Cut to ${anchorName(track, next.id)}: ends freely`
      : clip.then === 'extend'
        ? `then Extend: must land on ${next.image ?? 'the next image (none yet)'} (${anchorName(track, next.id)})`
        : `Cut or Extend not chosen yet; next is ${anchorName(track, next.id)} (anchor ${next.id}, ${next.image ?? 'no image yet'})`;
  if (clip.use) {
    const version = clip.versions.findIndex((entry) => entry.file === clip.use) + 1;
    const at = time !== null && time > 0 ? ` at ${formatTimecode(time)}` : '';
    const parts = [
      `${name} (clip ${clip.id})`,
      `playing ${clip.use}${at}`,
      clip.end !== null ? `ends at ${formatSeconds(clip.end)}` : null,
      `start ${anchor.image ?? 'none'}`,
      ending,
    ].filter(Boolean);
    return { label: `${name} · v${String(version)}${at}`, text: `[Studio: ${parts.join(' · ')}]` };
  }
  const then = !next ? '' : clip.then === 'cut' ? ' · Cut' : clip.then === 'extend' ? ' · Extend' : '';
  const parts = [
    `${name} (clip ${clip.id})`,
    `empty, planned ${String(clip.plannedSeconds)} s`,
    `start ${anchor.image ?? 'none yet'}`,
    ending,
    `aspect ${track.aspectRatio}`,
  ];
  return { label: `${name} · empty · ${String(clip.plannedSeconds)} s${then}`, text: `[Studio: ${parts.join(' · ')}]` };
}

/**
 * A sent message that starts with a Studio selection: its chip label, the
 * selection line itself and the typed text after it. Sent messages keep only
 * the line, so the label is read back from it.
 */
export function splitStudioContext(message: string): { label: string; context: string; rest: string } | null {
  const newline = message.indexOf('\n');
  const context = newline === -1 ? message : message.slice(0, newline);
  if (!context.startsWith('[Studio: ') || !context.endsWith(']')) return null;
  const parts = context.slice('[Studio: '.length, -1).split(' · ');
  const head = /^(.+?)(?: "(.*)")? \((?:anchor|clip) [^)]+\)$/.exec(parts[0] ?? '');
  if (!head) return null;
  const [, name, title] = head;
  const detail = parts.slice(1);
  const playing = detail.find((part) => part.startsWith('playing '));
  const at = playing ? / at (\d+:\d{2}\.\d)$/.exec(playing)?.[1] : undefined;
  const label = [
    name,
    title || null,
    detail.some((part) => part.startsWith('empty')) ? 'empty' : null,
    at ? `at ${at}` : null,
  ].filter(Boolean).join(' · ');
  let rest = newline === -1 ? '' : message.slice(newline + 1);
  // The same line again (an earlier message pasted with the chip still on): one chip says it.
  while (rest === context || rest.startsWith(`${context}\n`)) rest = rest.slice(context.length + 1);
  return { label, context, rest };
}

/**
 * A clip request the editor sent (Update, or Replace and get a quote) shows as one chip naming its clips;
 * the full request, with file names and instructions for the agent, is the chip's tooltip.
 */
export function splitClipRequest(message: string): { label: string; context: string; rest: string } | null {
  if (!/^Please make (?:this clip|these \d+ clips) for the track\.\n/.test(message)) return null;
  const clips = [...message.matchAll(/^Clip (\S+) \(clip [^)]+\)$/gm)].map((match) => match[1]!);
  if (clips.length === 0) return null;
  const label = clips.length === 1 ? `Make Clip ${clips[0]!}` : `Make ${String(clips.length)} clips · ${clips.join(', ')}`;
  return { label, context: message, rest: '' };
}

/** The chip for a user message: a clip request, or the selection line it was sent with. */
export function splitStudioMessage(message: string): { label: string; context: string; rest: string } | null {
  const selection = splitStudioContext(message);
  return splitClipRequest(selection ? selection.rest : message) ?? selection;
}
