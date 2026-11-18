// node apps/website/scripts/site-models-refresh.mjs — re-reads the homepage's price list (hero/models.json) from AntSeedStats' API
// (https://antseedstats.com/developers, CC BY 4.0). Run it before a deploy; the page shows what the file holds.
//   the models  each medium's most used models, as AntSeedStats orders them (/models, /models/images, /video, /speech), for variety
//               one per family (a family: the maker and the name without its versions and sizes, so GPT-5.6 Sol and GPT-6.1 Sol are
//               one) and a few per maker (text 3, the others 2), then dealt maker by maker so neighbours differ; only models whose
//               maker's mark we have (assets/home/icons/labs), and names not for a homepage left out (NSFW, abliterated, uncensored)
//   price       text: the lowest input price a provider asks, $ per million tokens, among the listings that report healthy (all of
//               them when none reports), free listings left out; image $ an image, video $ a second, voice $ per million characters
//   save        text only: that listing's saving on the lab's own list price, as AntSeedStats gives it (it has none for the rest)
//   providers   how many providers serve the model
//   logo        the maker's mark (LobeHub's icons, MIT: @lobehub/icons-static-svg): in its brand colours from assets/home/icons/labs-color
//               when we have one there (Anthropic's is Claude's), else the monochrome one in labs/, which the page draws in the text colour
// And the band under the hero's active users and tokens (network), read off AntSeedStats' home page, which its API does not give.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('../static/site/hero/models.json', import.meta.url), API = 'https://antseedstats.com/api/v1';
const data = JSON.parse(readFileSync(FILE, 'utf8'));
const get = async (path) => { const r = await fetch(`${API}/${path}`); if (!r.ok) throw new Error(`${path}: ${r.status}`); return (await r.json()).data; };
const NOT_HERE = /lustify|nsfw|hentai|abliterat|uncensor|heretic|porn|\bwai\b|anime/i;
const LABS = [
  [/^(gpt|o\d|openai|whisper|sora|chatgpt)/i, 'openai'], [/^claude/i, 'anthropic'], [/^(gemini|gemma|nano banana|veo|imagen|lyria)/i, 'google'],
  [/^deepseek/i, 'deepseek'], [/^kimi/i, 'moonshot'], [/^qwen/i, 'qwen'], [/^(wan|z-image)/i, 'alibaba'], [/^(minimax|hailuo)/i, 'minimax'],
  [/^(grok|xai)/i, 'xai'], [/^glm/i, 'zai'], [/^flux/i, 'bfl'], [/^(seedream|seedance|seededit)/i, 'bytedance'], [/^kling/i, 'kling'],
  [/^ltx/i, 'lightricks'], [/^runway/i, 'runway'], [/^elevenlabs/i, 'elevenlabs'], [/^ideogram/i, 'ideogram'], [/^recraft/i, 'recraft'],
  [/^(venice sd|stable diffusion|sd ?\d)/i, 'stability'], [/^happyhorse/i, 'happyhorse'],
];
const lab = (name) => LABS.find(([re]) => re.test(name))?.[1];
const logo = (maker) => (existsSync(new URL(`../static/site/assets/home/icons/labs-color/${maker}.svg`, import.meta.url)) ? `labs-color/${maker}.svg` : `labs/${maker}.svg`);
const QUALIFIERS = /^(pro|max|flash|flashx|fast|turbo|highspeed|ultrafast|basic|standard|prime|plus|mini|lite|hd|high|full|quality|preview|instruct|thinking|base|reference|us|eu|video|image|v)$/;
const family = (maker, name) => `${maker} ${name.toLowerCase().replace(/\(.*?\)/g, ' ').split(/[\s-]+/).filter((w) => w && !/\d/.test(w) && !QUALIFIERS.test(w)).join(' ')}`;
const round = (v) => +v.toPrecision(3);

// every listing, a thousand at a time (the API's most): the text prices and savings come from them
const listings = [];
for (let total = Infinity; listings.length < total;) {
  const d = await get(`prices?limit=1000&offset=${listings.length}`);
  if (!d.listings.length) break;
  total = d.total; listings.push(...d.listings);
}

const pick = (models, n, perLab, row) => {
  const seen = new Set(), per = {}, byLab = new Map();
  let count = 0;
  for (const m of models) {
    const name = m.display.replace(/\s*\(Resemble AI\)$/, '').replace(/ Text to (Speech|Image|Video)$/i, ''), maker = lab(name);
    if (count >= n || !maker || NOT_HERE.test(`${name} ${m.model}`) || seen.has(family(maker, name)) || (per[maker] || 0) >= perLab) continue;
    const r = row(m); if (!r) continue;
    seen.add(family(maker, name)); per[maker] = (per[maker] || 0) + 1; count++;
    if (!byLab.has(maker)) byLab.set(maker, []);
    byLab.get(maker).push({ name, logo: logo(maker), providers: m.sellers, ...r });
  }
  // dealt maker by maker, in the order they first came, so no two neighbours share a maker
  const out = [], queues = [...byLab.values()];
  while (queues.some((q) => q.length)) for (const q of queues) if (q.length) out.push(q.shift());
  return out;
};
const all = (await get('models?limit=1000')).models;
const text = pick(all.filter((m) => !m.image_generation && !m.video_generation && !m.speech_generation), 30, 3, (m) => {
  const mine = listings.filter((l) => l.model === m.model && l.live !== false), paid = mine.filter((l) => l.input_usd_per_m > 0 && l.save_pct != null);
  const healthy = paid.filter((l) => l.health === 'healthy'), best = (healthy.length ? healthy : paid).sort((a, b) => a.input_usd_per_m - b.input_usd_per_m)[0];
  return best && best.save_pct > 0 && { price: round(best.input_usd_per_m), save: Math.round(best.save_pct) };
});
const image = pick((await get('models/images?limit=200')).models, 24, 2, (m) => m.min_image_usd > 0 && { price: round(m.min_image_usd) });
const video = pick((await get('models/video?limit=200')).models, 24, 2, (m) => m.min_video_usd_per_s > 0 && { price: round(m.min_video_usd_per_s) });
const voice = pick((await get('models/speech?limit=200')).models, 24, 2, (m) => m.min_usd_per_1m_chars > 0 && { price: round(m.min_usd_per_1m_chars) });
data.media = { text, image, video, voice };
for (const [k, v] of Object.entries(data.media)) if (v.length < 5) console.warn(`${k}: only ${v.length} models`);

// "Total active users 19,252" and "Tokens consumed 742.76B", in the home page's text
const home = (await (await fetch('https://antseedstats.com/')).text()).replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const users = home.match(/Total active users\D*?([\d,]+)/)?.[1], tokens = home.match(/Tokens consumed\D*?([\d.]+)([KMB])/);
if (users && tokens) data.network = { users: +users.replace(/,/g, ''), tokens: Math.round(+tokens[1] * { K: 1e3, M: 1e6, B: 1e9 }[tokens[2]]) };
else console.warn('network: active users or tokens not found on antseedstats.com, kept as they were');

data.source = 'https://antseedstats.com, its API (https://antseedstats.com/developers): /models, /models/images, /models/video, /models/speech, /prices; the network figures from its home page';
data.rule = 'Each medium\'s most used models, one per family, a few per maker, dealt maker by maker; only makers whose mark we have. price: text, lowest paid input price among healthy listings ($/M tokens); image $/image; video $/s; voice $/M characters. save: that text listing\'s saving on the lab\'s list price. Refresh: node apps/website/scripts/site-models-refresh.mjs';
data.read = new Date().toISOString().slice(0, 10);
// one row a line, so a refresh reads as a short diff
const rowsOut = (rows) => `[\n${rows.map((r) => `      ${JSON.stringify(r)}`).join(',\n')}\n    ]`;
const order = ['source', 'read', 'rule', 'media', 'network'];
writeFileSync(FILE, `{\n${order.filter((k) => k in data).map((k) => (k === 'media'
  ? `  "media": {\n${Object.entries(data.media).map(([m, rows]) => `    ${JSON.stringify(m)}: ${rowsOut(rows)}`).join(',\n')}\n  }`
  : `  ${JSON.stringify(k)}: ${JSON.stringify(data[k])}`)).join(',\n')}\n}\n`);
console.log(`hero/models.json read ${data.read}: ${Object.entries(data.media).map(([k, v]) => `${v.length} ${k}`).join(', ')}`);
