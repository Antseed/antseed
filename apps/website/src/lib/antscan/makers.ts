/** The model makers whose mark the site has (static/site/assets/home/icons/labs*), and how to recognise their services. */

export type Maker = {
  id: string;
  logo: string;
  /** Matched against the service id with every separator turned into `-` and a `-` on each side. */
  match: RegExp;
  /** Vendor words that prefix some ids (`deepseek/deepseek-v4`, `minimax/h3`); dropped from the family key. */
  words: readonly string[];
};

/** First match wins: specific makers come before OpenAI's broad `-o<digit>`. */
export const MAKERS: readonly Maker[] = [
  {id: 'anthropic', logo: 'labs-color/anthropic.svg', match: /-claude-/, words: ['anthropic']},
  {id: 'kling', logo: 'labs-color/kling.svg', match: /-kling-/, words: ['kling', 'fal', 'ai']},
  {id: 'happyhorse', logo: 'labs/happyhorse.svg', match: /-happyhorse-/, words: ['happyhorse', 'alibaba']},
  {id: 'bytedance', logo: 'labs-color/bytedance.svg', match: /-(seedance|seedream|doubao)-/, words: ['bytedance', 'fal', 'ai']},
  {id: 'google', logo: 'labs-color/google.svg', match: /-(gemini|gemma|nano-banana|veo\d|imagen)/, words: ['google', 'fal', 'ai']},
  {id: 'deepseek', logo: 'labs-color/deepseek.svg', match: /-deepseek-/, words: ['deepseek']},
  {id: 'moonshot', logo: 'labs/moonshot.svg', match: /-kimi-/, words: ['moonshotai', 'moonshot']},
  {id: 'xai', logo: 'labs/xai.svg', match: /-(grok|xai)-/, words: ['xai', 'x', 'ai']},
  {id: 'qwen', logo: 'labs-color/qwen.svg', match: /-qwen/, words: ['qwen']},
  {id: 'alibaba', logo: 'labs-color/alibaba.svg', match: /-(wan|z-image)-/, words: ['alibaba', 'fal', 'ai']},
  {id: 'minimax', logo: 'labs-color/minimax.svg', match: /-minimax-|^-speech-\d/, words: ['minimax']},
  {id: 'zai', logo: 'labs/zai.svg', match: /-(glm|cogview)-/, words: ['z', 'ai', 'zai', 'zhipu']},
  {id: 'bfl', logo: 'labs/bfl.svg', match: /-flux-/, words: ['bfl', 'blackforestlabs', 'fal', 'ai']},
  {id: 'lightricks', logo: 'labs/lightricks.svg', match: /-ltx-/, words: ['lightricks', 'fal', 'ai']},
  {id: 'runway', logo: 'labs/runway.svg', match: /-runway-/, words: ['runway']},
  {id: 'recraft', logo: 'labs/recraft.svg', match: /-recraft-/, words: ['recraft']},
  {id: 'ideogram', logo: 'labs/ideogram.svg', match: /-ideogram-/, words: ['ideogram']},
  {id: 'elevenlabs', logo: 'labs/elevenlabs.svg', match: /-elevenlabs-/, words: ['elevenlabs']},
  {id: 'stability', logo: 'labs-color/stability.svg', match: /-(stable-diffusion|sd-?3)/, words: ['stabilityai', 'stability']},
  {id: 'openai', logo: 'labs/openai.svg', match: /-(gpt|o\d|codex|chatgpt|sora)-/, words: ['openai']},
];

/** `fal-ai/kling-video/v3/pro` → `-fal-ai-kling-video-v3-pro-`, the form `Maker.match` reads. */
export const dashed = (service: string): string => `-${service.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean).join('-')}-`;

export const makerOf = (service: string): Maker | null => {
  const id = dashed(service);
  return MAKERS.find((m) => m.match.test(id)) ?? null;
};
