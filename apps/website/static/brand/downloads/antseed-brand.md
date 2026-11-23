# Antseed brand assets

For anyone making something with Antseed: partners, press and their agents. Paths are relative to this file.

## Name

Antseed: one word, capital A only. Tagline: The Open Intelligence Network.

## Logo

| File | Use |
|---|---|
| `logo/svg/antseed-logo-black.svg` | On light |
| `logo/svg/antseed-logo-white.svg` | On dark |
| `logo/svg/antseed-mark-black.svg` | Mark, on light |
| `logo/svg/antseed-mark-white.svg` | Mark, on dark |
| `logo/svg/antseed-profile-picture.svg` | Profile picture |

PNG versions are in `logo/png/`.

- Clear space: at least the height of the capitals.
- Smallest size: logo 96 px wide, mark 16 px.
- Never stretch, rotate, recolour or redraw it. No shadow or effect. Never set it on a painting.

## Colours

| Name | Hex | Use |
|---|---|---|
| Green | `#4f7a24` | Buttons and accents |
| Ink | `#30382c` | Text |
| Grey | `#929292` | Second half of a title |
| Paper | `#ffffff` | Background |
| Night | `#0f1312` | Dark background |
| Night green | `#98c463` | Green text on dark |
| Acid | `#c8f53c` | Small dots and glows on dark only. Never text or a fill |

## Type

- Geist Pixel: titles. In `fonts/`. Set the variable axis to `"ELSH" 40`.
- Geist: all other text, 400 and 500. https://fonts.google.com/specimen/Geist
- Geist Mono: code. https://fonts.google.com/specimen/Geist+Mono
- Sentence case. No italics, no capitals for emphasis. Titles come in two tones: ink, then grey.

## The ant

Reference: `ant/antseed-ant.png`. Attach it to every prompt for a new ant. Twenty finished ants are in `ant/examples/`.

Every ant:

- A round head, about half its height
- Exactly two arms and two legs. Count the feet in every image, never three or four
- Soft watercolour with a thin dark-brown line
- No eyebrows, teeth or mandibles
- Never a realistic insect, never cool, heroic or scary

An ant in the background: huge white eyes looking two ways, small pupils drifting outward, a tiny flat mouth, a derpy stare.

An ant in action: eyes on what it is doing, or the expression that fits the moment.

Costume: whatever fits its role. A lime bandana by default, otherwise a hoodie, a beanie, glasses.

## Backgrounds

- `backgrounds/textures/`: three square textures, 2160 × 2160, a painting breaking into dots on transparency, each with a day and a night.
- `backgrounds/watercolours/`: nine paintings for illustration backgrounds, each with a day and a night.

## Watercolour style

`backgrounds/antseed-watercolour-style-reference.webp` is a style reference, not a picture to reuse. Attach it when the model accepts a reference.

This example prompt painted it (Nano Banana 2.1, 16:9). For your own image, keep the first two sentences and the last three, and replace what is in between with your subject.

```text
A wide watercolour landscape on cold-pressed paper, its grain visible through every wash, painted edge to edge with no white border. Soft transparent lavis, wet-in-wet, loose and lightly detailed, like a page from a nature picture book. A low horizon about 62% down. The sky is a calm, empty, pale granulated cerulean wash, only slightly deeper at the top, fading through very pale blue to warm cream at the horizon, with no defined clouds. At the horizon, gently rolling pale sage hills with one far blue-grey hill, a small sliver of pale lake right of centre, soft muted olive clusters of trees at both edges, and on the left one tiny distant farmhouse with a terracotta roof beside three slim cypresses. Below, the meadow fills the whole ground with no bare paper: soft overlapping glazes of muted yellow-green and straw ochre, faint warm sand patches in the middle, and a few dry-brush grass tufts. Along the bottom edge only, densest in both corners, a few loosely painted crimson clover, white daisies with yellow centres, ochre grass seed heads and broad green leaves. The whole palette is muted, light and airy. Detail fades quickly with distance. No pen lines, no outlines, no sun, no hard shadows, no people, no animals, no insects, no text, no frame.
```
