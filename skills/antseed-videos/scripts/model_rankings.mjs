// Quality rankings for image and video models, from LMArena's public leaderboard
// (blind human votes, CC BY 4.0, https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset).
// Read without an API key through the Hugging Face dataset viewer, cached for a day, with a
// built-in snapshot when the network is unreachable. Only the leaderboard is requested;
// nothing about the user's prompt or media leaves the machine.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const RANKING_SOURCE = 'LMArena leaderboard (lmarena.ai, CC BY 4.0)';
const DATASET_ROWS_URL = 'https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&split=latest&offset=0&length=100&config=';
/** Models ranked within this many places of the top count as top tier. */
export const TOP_TIER_RANK = 12;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

/** LMArena boards used for each choice the skill makes. */
export const BOARDS = ['text_to_image', 'image_to_video', 'text_to_video'];

/**
 * Snapshot of each board (LMArena, published image_to_video 2026-09-22, text_to_image 2026-10-07, text_to_video 2026-09-22),
 * used only when the live board cannot be fetched or cached.
 */
export const SNAPSHOT = {
  publishedAt: { text_to_image: '2026-10-07', image_to_video: '2026-09-22', text_to_video: '2026-09-22' },
  text_to_image: [
    ["gpt-image-2.5-sunburst", 1425], ["gpt-image-2.5-flare", 1398], ["gpt-image-2 (medium)", 1383], ["grok-imagine-image-2.0 (canvas)", 1334],
    ["mai-image-2.6", 1332], ["gemini-nano-banana-2.1", 1328], ["reve-2.1", 1302], ["grok-imagine-image-2.0 (20260801)", 1294],
    ["muse-image", 1274], ["reve-2.0", 1269], ["gemini-3.1-flash-image (nano-banana-2) [web-search]", 1262], ["seedream-5.0-pro", 1255],
    ["qwen-image-3.0-pro", 1255], ["mai-image-2.5", 1254], ["gemini-3.1-flash-lite-image (nano-banana-2-lite)", 1250], ["gemini-3-pro-image-2k (nano-banana-pro)", 1248],
    ["gpt-image-1.5-high-fidelity", 1237], ["gemini-3-pro-image-preview (nano-banana-pro)", 1234], ["qwen-image-2.1", 1223], ["ideogram-4.0-quality", 1205],
    ["qwen-image-2.0-pro-2026-06-22", 1192], ["uni-1.1-max", 1189], ["uni-1.1", 1184], ["mai-image-2", 1184],
    ["grok-imagine-image", 1170], ["recraft-v4.1-utility-pro", 1169], ["Cosmos3-Super-Text2Image (Agentic)", 1165], ["grok-imagine-image-pro", 1162],
    ["flux-2-max", 1162], ["flux-2-flex", 1157], ["reve-v1.5", 1155], ["flux-2-pro", 1153],
    ["Cosmos3-Super-Text2Image", 1152], ["gemini-2.5-flash-image-preview (nano-banana)", 1150], ["hunyuan-image-3.0", 1150], ["seedream-4.5", 1149],
    ["imagen-ultra-4.0-generate-001", 1148], ["flux-2-dev", 1146], ["seedream-4-2k", 1140], ["seedream-5.0-lite", 1138],
    ["wan2.6-t2i", 1137], ["recraft-v4.1-pro", 1133], ["imagen-4.0-generate-001", 1129], ["qwen-image-2512", 1125],
    ["krea-2-medium", 1124], ["seedream-4-fal", 1117], ["hidream-o1-image", 1116], ["wan2.5-t2i-preview", 1116],
    ["gpt-image-1", 1116], ["recraft-v4", 1115], ["seedream-4-high-res-fal", 1113], ["krea-2-turbo", 1113],
    ["krea-2-large", 1112], ["gpt-image-1-mini", 1110], ["wan2.7-image-pro", 1104], ["wan2.7-image", 1101],
    ["recraft-v4.1-flash", 1099], ["mai-image-1", 1093], ["z-image-turbo", 1083], ["seedream-3", 1082],
    ["flux-1-kontext-max", 1074], ["flux-2-klein-9b", 1070], ["qwen-image-prompt-extend", 1060], ["flux-1-kontext-pro", 1059],
    ["imagen-3.0-generate-002", 1058], ["qwen-image", 1057], ["ideogram-v3-quality", 1048], ["photon", 1036],
    ["p-image", 1033], ["flux-2-klein-4b", 1030], ["runway-gen4", 1024], ["recraft-v3", 1021],
    ["flux-1.1-pro", 1016], ["ideogram-v2", 1013], ["lucid-origin", 1013], ["glm-image", 1012],
    ["gemini-2.0-flash-preview-image-generation", 975], ["flux-1-dev-fp8", 969], ["dall-e-3", 968], ["flux-1-kontext-dev", 941],
    ["stable-diffusion-v35-large", 938], ["bagel", 898],
  ],
  image_to_video: [
    ["minimax-h3", 1495], ["gemini-omni-1.1-flash", 1488], ["wan3.0", 1480], ["dreamina-seedance-2.5-720p", 1477],
    ["dreamina-seedance-2.0-720p", 1475], ["gemini-omni-flash", 1465], ["hidream-o1-video-1.0", 1456], ["grok-imagine-video-1.5-720p", 1456],
    ["flux-3-video-20260811", 1449], ["happyhorse-1.0", 1442], ["wan2.7-i2v", 1428], ["grok-imagine-video-720p", 1415],
    ["veo-3.1-audio", 1398], ["veo-3.1-audio-1080p", 1390], ["veo-3.1-fast-audio", 1385], ["grok-imagine-video-480p", 1385],
    ["veo-3.1-fast-audio-1080p", 1372], ["vidu-q3-pro", 1363], ["kling-v3-pro", 1354], ["veo-3-audio", 1331],
    ["veo-3-fast-audio", 1326], ["wan2.5-i2v-preview", 1321], ["wan2.6-i2v", 1310], ["seedance-v1.5-pro", 1307],
    ["pixverse-v5.6", 1299], ["kling-2.6-pro", 1294], ["kling-2.5-turbo-1080p", 1276], ["seedance-v1-pro", 1273],
    ["hailuo-2.3", 1262], ["veo-3", 1258], ["veo-3-fast", 1257], ["p-video", 1244],
    ["vidu-q2-turbo", 1244], ["kling-v2.1-master", 1235], ["hailuo-02-pro", 1229], ["kling-v2.1-standard", 1229],
    ["ray-3", 1226], ["hailuo-02-standard", 1224], ["vidu-q2-pro", 1223], ["hunyuan-video-1.5", 1198],
    ["hailuo-02-fast", 1194], ["seedance-v1-lite", 1185], ["wan-v2.2-a14b", 1170], ["veo-2", 1166],
    ["ltx-2-19b", 1159], ["ray2", 1108], ["runway-gen4-turbo", 1052], ["pika-v2.2", 997],
  ],
  text_to_video: [
    ["gemini-omni-1.1-flash", 1516], ["gemini-omni-flash", 1513], ["flux-3-video", 1493], ["grok-imagine-video-1.5-agent", 1492],
    ["dreamina-seedance-2.0-720p", 1479], ["wan3.0", 1476], ["dreamina-seedance-2.5-720p", 1474], ["minimax-h3", 1460],
    ["muse-video", 1456], ["happyhorse-1.0", 1427], ["sora-2-pro", 1368], ["veo-3.1-audio", 1364],
    ["veo-3.1-audio-1080p", 1362], ["veo-3.1-fast-audio", 1362], ["veo-3.1-fast-audio-1080p", 1358], ["veo-3-fast-audio", 1348],
    ["sora-2", 1343], ["grok-imagine-video-720p", 1342], ["veo-3-audio", 1340], ["wan2.7-t2v", 1337],
    ["wan2.6-t2v", 1327], ["seedance-v1.5-pro", 1256], ["veo-3", 1254], ["veo-3-fast", 1248],
    ["wan2.5-t2v-preview", 1245], ["pixverse-v5.6", 1240], ["runway-gen-4.5", 1225], ["kling-2.5-turbo-1080p", 1220],
    ["kling-2.6-pro", 1216], ["p-video", 1207], ["ray-3", 1206], ["hailuo-2.3", 1206],
    ["kling-o1-pro", 1205], ["hailuo-02-pro", 1198], ["seedance-v1-pro", 1191], ["hailuo-02-standard", 1181],
    ["kandinsky-5.0-t2v-pro", 1175], ["hunyuan-video-1.5", 1169], ["veo-2", 1164], ["kling-v2.1-master", 1163],
    ["ltx-2-19b", 1154], ["wan-v2.2-a14b", 1132], ["seedance-v1-lite", 1113], ["kandinsky-5.0-t2v-lite", 1113],
    ["sora", 1069], ["ray2", 1065], ["pika-v2.2", 1009], ["mochi-v1", 1007],
  ],
};

/**
 * Hand-checked mapping from network model ids to LMArena entries. `exact` means the leaderboard
 * scored this model; `family` means it scored the base model and the network id is a tier of it
 * (fast, lite, max, prime, standard). Ids not listed here fall back to automatic name matching.
 * Leaderboard names are listed per board; a model may appear on only one board.
 */
export const MANUAL_MAP = {
  // Video: MiniMax
  'minimax-h3-image-to-video': { name: 'minimax-h3', match: 'exact' },
  'minimax-h3-text-to-video': { name: 'minimax-h3', match: 'exact' },
  'minimax-h3-max-image-to-video': { name: 'minimax-h3', match: 'family' },
  'minimax-h3-max-text-to-video': { name: 'minimax-h3', match: 'family' },
  // Video: Google
  'gemini-omni-flash-1-1-image-to-video': { name: 'gemini-omni-1.1-flash', match: 'exact' },
  'gemini-omni-flash-1-1-text-to-video': { name: 'gemini-omni-1.1-flash', match: 'exact' },
  'veo3.1-full-image-to-video': { name: 'veo-3.1-audio', match: 'exact' },
  'veo3.1-full-text-to-video': { name: 'veo-3.1-audio', match: 'exact' },
  'veo3.1-fast-image-to-video': { name: 'veo-3.1-fast-audio', match: 'exact' },
  'veo3.1-fast-text-to-video': { name: 'veo-3.1-fast-audio', match: 'exact' },
  'fal-ai/veo3.1/fast': { name: 'veo-3.1-fast-audio', match: 'exact' },
  // Video: Alibaba Wan
  'wan-3-0-image-to-video': { name: 'wan3.0', match: 'exact' },
  'wan-3-0-text-to-video': { name: 'wan3.0', match: 'exact' },
  'wan-3-0-prime-pro-image-to-video': { name: 'wan3.0', match: 'family' },
  'wan-3-0-prime-pro-text-to-video': { name: 'wan3.0', match: 'family' },
  'alibaba/wan-3.0-prime/image-to-video': { name: 'wan3.0', match: 'family' },
  'alibaba/wan-3.0-prime/text-to-video': { name: 'wan3.0', match: 'family' },
  // Video: ByteDance Seedance (leaderboard scores the 720p "Dreamina" release)
  'seedance-2-5-image-to-video-basic': { name: 'dreamina-seedance-2.5-720p', match: 'exact' },
  'seedance-2-5-text-to-video-basic': { name: 'dreamina-seedance-2.5-720p', match: 'exact' },
  'seedance-2-0-image-to-video-basic': { name: 'dreamina-seedance-2.0-720p', match: 'exact' },
  'seedance-2-0-text-to-video-basic': { name: 'dreamina-seedance-2.0-720p', match: 'exact' },
  'seedance-2-0-fast-image-to-video-basic': { name: 'dreamina-seedance-2.0-720p', match: 'family' },
  'seedance-2-0-fast-text-to-video-basic': { name: 'dreamina-seedance-2.0-720p', match: 'family' },
  // Video: xAI Grok Imagine
  'grok-imagine-1-5-image-to-video-private': { name: 'grok-imagine-video-1.5-720p', match: 'exact' },
  'grok-imagine-1-5-text-to-video-private': { name: 'grok-imagine-video-1.5-agent', match: 'exact' },
  'grok-imagine-1-5-lite-image-to-video': { name: 'grok-imagine-video-1.5-720p', match: 'family' },
  'grok-imagine-1-5-lite-text-to-video': { name: 'grok-imagine-video-1.5-agent', match: 'family' },
  // Video: Black Forest Labs
  'flux-3-image-to-video': { name: 'flux-3-video-20260811', match: 'exact' },
  'flux-3-text-to-video': { name: 'flux-3-video', match: 'exact' },
  // Video: Kling (only V3 Pro is on the leaderboard; Standard and O3 are not scored)
  'kling-v3-pro-image-to-video': { name: 'kling-v3-pro', match: 'exact' },
  'kling-v3-pro-text-to-video': { name: 'kling-v3-pro', match: 'exact' },
  'kling-v3-standard-image-to-video': null,
  'kling-v3-standard-text-to-video': null,
  'kling-o3-pro-image-to-video': null,
  'kling-o3-pro-text-to-video': null,
  // Video: Runway
  'runway-gen4-5': { name: 'runway-gen-4.5', match: 'exact' },
  'runway-gen4-5-text': { name: 'runway-gen-4.5', match: 'exact' },
  // Video: Lightricks LTX 2.5 is not on the leaderboard (only LTX-2 19B is)
  'ltx-2-5-pro-image-to-video': null,
  'ltx-2-5-pro-text-to-video': null,
  'lightricks/ltx-2.5/text-to-video/pro': null,
  // Image
  'nano-banana-2': { name: 'gemini-3.1-flash-image (nano-banana-2) [web-search]', match: 'exact' },
  'nano-banana-2-1': { name: 'gemini-nano-banana-2.1', match: 'exact' },
  'nano-banana-2-lite': { name: 'gemini-3.1-flash-lite-image (nano-banana-2-lite)', match: 'exact' },
  'nano-banana-pro': { name: 'gemini-3-pro-image-2k (nano-banana-pro)', match: 'exact' },
  'gpt-image-1-5': { name: 'gpt-image-1.5-high-fidelity', match: 'exact' },
  'gpt-image-2': { name: 'gpt-image-2 (medium)', match: 'exact' },
  'grok-imagine-image-2-0': { name: 'grok-imagine-image-2.0 (20260801)', match: 'exact' },
  'hunyuan-image-v3': { name: 'hunyuan-image-3.0', match: 'exact' },
  'ideogram-v4': { name: 'ideogram-4.0-quality', match: 'exact' },
  'luma-uni-1': { name: 'uni-1.1', match: 'exact' },
  'luma-uni-1-max': { name: 'uni-1.1-max', match: 'exact' },
  'seedream-v5-pro': { name: 'seedream-5.0-pro', match: 'exact' },
  'seedream-v5-lite': { name: 'seedream-5.0-lite', match: 'exact' },
  'seedream-v4': { name: 'seedream-4-2k', match: 'exact' },
  'qwen-image-3-pro': { name: 'qwen-image-3.0-pro', match: 'exact' },
  'krea-v2-medium': { name: 'krea-2-medium', match: 'exact' },
  'krea-v2-large': { name: 'krea-2-large', match: 'exact' },
  'wan-2-7-text-to-image': { name: 'wan2.7-image', match: 'exact' },
  'wan-2-7-pro-text-to-image': { name: 'wan2.7-image-pro', match: 'exact' },
};

/** Words that describe a variant or mode rather than the model itself. */
const NOISE = /\b(text|image|to|video|t2v|i2v|t2i|basic|private|720p|1080p|480p|high|medium|low|fidelity|quality|preview|canvas|web|search|agent|agentic|audio|fal|generate|001)\b/g;

/** Comparable key: lowercase letters and digits only, after dropping bracketed notes and noise words. */
export function modelKey(name) {
  return String(name)
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/[-_ ]20\d{6}\b/g, ' ') // dated snapshots such as "-20260811"
    .replace(/^(dreamina|gemini|fal-ai|alibaba|lightricks|openai|google|bytedance)[-/]/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(NOISE, ' ')
    .replace(/(\d) (\d)/g, '$1$2')
    .replace(/ /g, '')
    .replace(/(\d)0(?=$|[a-z])/g, '$1'); // "3.0" and "3" compare equal
}

function boardFromRows(rows) {
  const entries = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || row.category !== 'overall' || typeof row.model_name !== 'string' || !Number.isFinite(row.rating)) continue;
    if (seen.has(row.model_name)) continue;
    seen.add(row.model_name);
    entries.push({ name: row.model_name, rating: Math.round(row.rating), votes: Number.isFinite(row.vote_count) ? row.vote_count : null });
  }
  return entries.sort((a, b) => b.rating - a.rating).map((entry, index) => ({ ...entry, rank: index + 1 }));
}

function snapshotBoard(board) {
  return (SNAPSHOT[board] ?? []).map(([name, rating], index) => ({ name, rating, votes: null, rank: index + 1 }));
}

export function cachePath(env = process.env) {
  return env.ANTSEED_MODEL_RANKINGS_CACHE || path.join(homedir(), '.antseed', 'cache', 'model-rankings.json');
}

async function readCache(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

async function writeCache(file, value) {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(value));
    await rename(temp, file);
  } catch {
    // A missing cache only costs a refetch.
  }
}

async function fetchBoard(board, fetchImpl, env) {
  const base = env.ANTSEED_MODEL_RANKINGS_URL || DATASET_ROWS_URL;
  const response = await fetchImpl(`${base}${board}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`leaderboard HTTP ${response.status}`);
  const body = await response.json();
  const rows = Array.isArray(body?.rows) ? body.rows.map((item) => item?.row) : [];
  const entries = boardFromRows(rows);
  if (!entries.length) throw new Error('leaderboard was empty');
  const publishedAt = rows.find((row) => typeof row?.leaderboard_publish_date === 'string')?.leaderboard_publish_date ?? null;
  return { entries, publishedAt };
}

/**
 * Returns a board's ranked entries plus where they came from: `live`, `cache`
 * (fresh, or stale after a failed refresh), or `snapshot`. Never throws.
 */
export async function loadBoard(board, { fetchImpl = fetch, env = process.env, now = Date.now() } = {}) {
  if (env.ANTSEED_MODEL_RANKINGS === 'off') return { board, source: 'off', publishedAt: null, entries: [] };
  const file = cachePath(env);
  const cache = await readCache(file);
  const cached = cache[board];
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS && Array.isArray(cached.entries)) {
    return { board, source: 'cache', publishedAt: cached.publishedAt ?? null, entries: cached.entries };
  }
  try {
    const { entries, publishedAt } = await fetchBoard(board, fetchImpl, env);
    await writeCache(file, { ...cache, [board]: { fetchedAt: now, publishedAt, entries } });
    return { board, source: 'live', publishedAt, entries };
  } catch {
    if (cached && Array.isArray(cached.entries)) return { board, source: 'cache', stale: true, publishedAt: cached.publishedAt ?? null, entries: cached.entries };
    return { board, source: 'snapshot', publishedAt: SNAPSHOT.publishedAt[board] ?? null, entries: snapshotBoard(board) };
  }
}

/** Finds a network model's leaderboard entry by alias, then by exact key, then by the longest key prefix. */
export function matchRanking(names, entries) {
  const candidates = [...new Set(names.filter((name) => typeof name === 'string' && name))];
  const byKey = new Map();
  for (const entry of entries) {
    const key = modelKey(entry.name);
    if (key && !byKey.has(key)) byKey.set(key, entry);
  }
  for (const name of candidates) {
    const key = name.toLowerCase();
    if (!Object.hasOwn(MANUAL_MAP, key)) continue;
    const mapped = MANUAL_MAP[key];
    // null: checked by hand and not on the leaderboard; do not guess a neighbour.
    if (mapped === null) return null;
    const entry = entries.find((item) => item.name === mapped.name);
    // A listed model missing from this board may still be on the other board.
    return entry ? { ...entry, match: mapped.match } : null;
  }
  for (const name of candidates) {
    const entry = byKey.get(modelKey(name));
    if (entry) return { ...entry, match: 'exact' };
  }
  // "seedance-2-0-fast-…" should still find "seedance-2.0", but never across versions.
  let best = null;
  for (const name of candidates) {
    const key = modelKey(name);
    for (const [entryKey, entry] of byKey) {
      if (entryKey.length < 4 || !key.startsWith(entryKey) || /\d/.test(key[entryKey.length] ?? '')) continue;
      if (!best || entryKey.length > best.length || (entryKey.length === best.length && entry.rating > best.entry.rating)) best = { length: entryKey.length, entry };
    }
  }
  // A family match borrows the base model's score for a variant (for example a "fast" or "lite" tier).
  return best ? { ...best.entry, match: 'family' } : null;
}

/** Ranking fields to attach to a model summary. */
export function rankingFor(entry, board) {
  if (!entry) return { rank: null, rating: null, arenaName: null, match: null, tier: 'unranked' };
  return {
    rank: entry.rank,
    rating: entry.rating,
    arenaName: entry.name,
    match: entry.match ?? 'exact',
    tier: entry.rank <= TOP_TIER_RANK ? 'top' : 'ranked',
  };
}

/** Where a ranking came from, for the agent to cite next to a recommendation. */
export function rankingSummary(board) {
  return {
    board: board.board,
    source: board.source,
    stale: Boolean(board.stale),
    publishedAt: board.publishedAt,
    attribution: RANKING_SOURCE,
  };
}
