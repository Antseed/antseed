import type {Maker} from './makers.ts';

/** Id words that name a mode or a route of one model, not another model (`…/text-to-video`, `-basic`, `-us`). */
const MODE_WORDS = new Set(['to', 'text', 'image', 'reference', 'video', 'motion', 'control', 'edit', 'basic', 'private', 'recast', 'us', 'tts']);
const KEEP_IMAGE = new Set(['image']);
/** A release date at the end of an id: `-0731`, `-20260531`. */
const DATE = /^\d{4,8}$/;

/**
 * One key per model, whatever the seller calls it: `claude-opus-4-7` and `claude-opus-4.7`, `minimax/h3/text-to-video` and
 * `minimax-h3-image-to-video`, `deepseek/deepseek-v4.1-flash` and `deepseek-v4.1-flash:fast` each come out the same.
 * `image` is kept for image models (`flux-3-image` is not the `flux-3` video model, but they never meet in one lane).
 */
export function familyKey(service: string, maker: Maker, imageModel = false): string {
  const words = service.toLowerCase().replace(/:.*$/, '').split(/[^a-z0-9.]+/).filter(Boolean);
  if (words.length > 1 && DATE.test(words[words.length - 1])) words.pop();
  const kept = words.filter((w) => !maker.words.includes(w) && !(MODE_WORDS.has(w) && !(imageModel && KEEP_IMAGE.has(w))));
  return `${maker.id}:${kept.join('').replace(/\./g, '')}`;
}

const MODE_PHRASES = /\b(text|image|reference|video) to (video|image)\b|\bmotion control\b|\bedit video\b|\b(basic|private|recast|edit)\b|\bUs\b/gi;
const CASE: Record<string, string> = {
  hd: 'HD', ltx: 'LTX', gpt: 'GPT', glm: 'GLM', tts: 'TTS', ai: 'AI', xai: 'xAI', minimax: 'MiniMax', happyhorse: 'HappyHorse',
  elevenlabs: 'ElevenLabs', sdxl: 'SDXL', sd35: 'SD3.5', cogview: 'CogView',
};
/** A parameter count: `0.6b` → `0.6B`. */
const SIZE = /^\d+(\.\d+)?b$/i;
const word = (w: string): string => CASE[w.toLowerCase()] ?? (SIZE.test(w) ? w.toUpperCase() : w);

/** A seller's display name as a card title: no mode words, `2 5` read back as `2.5`, makers spelled their way. */
export function cleanName(raw: string): string {
  return raw
    .replace(MODE_PHRASES, ' ')
    .replace(/^\s*tts\s+(.*)$/i, (_, rest: string) => (/\bspeech\b/i.test(rest) ? rest : `${rest} TTS`))
    .replace(/\s+text\s*$/i, '')
    .replace(/(^|\s)((?:v|gen)?\d) (\d)(?=\s|$|[a-z])/gi, '$1$2.$3')
    .split(/\s+/)
    .filter(Boolean)
    .map(word)
    .join(' ');
}

/** The best title among a model's names: one that keeps its version's dot, then the fullest, then the most announced. */
export function pickName(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const n of names.map(cleanName)) if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
  const score = (n: string) => [n.includes('.') ? 1 : 0, n.split(' ').length, counts.get(n) ?? 0];
  return [...counts.keys()].sort((a, b) => {
    const [sa, sb] = [score(a), score(b)];
    return sb[0] - sa[0] || sb[1] - sa[1] || sb[2] - sa[2] || a.localeCompare(b);
  })[0] ?? '';
}
