/** An example of a style prompt, tested on Nano Banana 2.1 at 16:9. The style stays; `subject` is the part a reader replaces with their own. */
export const PROMPT_PARTS = {
  before:
    'A wide watercolour landscape on cold-pressed paper, its grain visible through every wash, painted edge to edge with no white border. Soft transparent lavis, wet-in-wet, loose and lightly detailed, like a page from a nature picture book. ',
  subject:
    'A low horizon about 62% down. The sky is a calm, empty, pale granulated cerulean wash, only slightly deeper at the top, fading through very pale blue to warm cream at the horizon, with no defined clouds. At the horizon, gently rolling pale sage hills with one far blue-grey hill, a small sliver of pale lake right of centre, soft muted olive clusters of trees at both edges, and on the left one tiny distant farmhouse with a terracotta roof beside three slim cypresses. Below, the meadow fills the whole ground with no bare paper: soft overlapping glazes of muted yellow-green and straw ochre, faint warm sand patches in the middle, and a few dry-brush grass tufts. Along the bottom edge only, densest in both corners, a few loosely painted crimson clover, white daisies with yellow centres, ochre grass seed heads and broad green leaves.',
  after:
    ' The whole palette is muted, light and airy. Detail fades quickly with distance. No pen lines, no outlines, no sun, no hard shadows, no people, no animals, no insects, no text, no frame.',
};

export const WATERCOLOUR_PROMPT = PROMPT_PARTS.before + PROMPT_PARTS.subject + PROMPT_PARTS.after;
