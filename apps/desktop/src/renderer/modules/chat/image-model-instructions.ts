import type { VprModelCatalogEntry } from '../../core/state';

export const ANTSEED_IMAGES_SKILL_URL = 'https://github.com/AntSeed/antseed/blob/main/skills/antseed-images/README.md';

/**
 * Short handoff for a normal text agent. The reusable workflow and safety
 * rules live in the public Antseed skill; the desktop supplies the selected
 * model and lets the buyer proxy choose and fail over between serving peers.
 */
export function buildImageModelSkillPrompt(
  model: Pick<VprModelCatalogEntry, 'serviceId' | 'label'>,
  proxyPort: number,
): string {
  const port = Number.isInteger(proxyPort) && proxyPort > 0 ? proxyPort : 8377;
  const proxyUrl = `http://127.0.0.1:${String(port)}`;

  return `Use the Antseed Images skill:
${ANTSEED_IMAGES_SKILL_URL}

Before generating, query ${proxyUrl}/v1/models?type=images and resolve this model against the returned ids and aliases:
- model: ${model.serviceId}
- display_name: ${model.label}
- proxy_url: ${proxyUrl}

Use the returned bare model id for the image request. Let Antseed select and fail over between peers; do not pin a peer. Use the user's image request as the prompt and follow the skill's safety and output instructions.`;
}
