# Antseed watercolour

Open this to make, choose or place a painting. DESIGN.md comes first; the ant is in mascot.md.

Every painting is a transparent watercolour of the ant's world: a meadow seen from the grass, with sky and bare paper across the top. Each one has a night, painted as an edit of its day.

## The reference: the homepage hero

`refs/hero-day.webp` (1920 × 1080, the hero's painting; on the site five painted clouds drift over it as separate layers) and `refs/hero-night.webp` (1376 × 768, the night on the site). Everything in this section is read from these two files. A painting that matches them matches the site.

### Paper and paint

- Transparent watercolour on cold-pressed paper. The paper's tooth shows everywhere as a fine, even pebble texture, strongest in the flat sky, where pale specks of paper show through the wash.
- Mild granulation in the sky blue: the pigment settles into the hollows of the paper and mottles.
- A few soft blooms inside the wettest washes (the sky, the big leaves). No hard cauliflower blooms, no back-runs with dark rings.
- Each wash dries with a crisp, slightly darker rim. For most shapes that rim is the only edge.
- Lost and found edges: the sky has no hard edge anywhere; hills and field bands have a crisp top edge and a lost bottom that melts into the band below; the foreground plants are crisp all round.
- Opaque white only in small touches: daisy petals, a glint. No gouache sky, no airbrush gradient, no smooth digital blend.

### How the washes are laid

- **Sky:** wet-in-wet, graded from the top down: a soft cerulean blue at the top in loose horizontal streaks, paling to bare white paper by mid-height, then warming to cream paper at the horizon. Clouds, when there are any, are left as white paper with soft blue-grey undersides dropped in wet.
- **Distant hills:** one flat, pale wash each, wet-on-dry. The farthest is the bluest and palest. No texture, nothing on them.
- **The horizon band:** small rounded tree clumps at both ends, wet-in-wet with darker undersides; at the left third a farmhouse in a few strokes (cream walls, terracotta roof) and three dark cypresses; right of centre a sliver of lake left almost as paper.
- **Meadow:** horizontal bands of straw ochre and soft yellow-green, glazed wet-on-dry and overlapping; sandy bare patches; grass tufts as a few dry-brush flicks.
- **Foreground:** wet-on-dry, the crispest and darkest part. Clover heads in separate crimson-pink petal strokes; daisies with white petals and golden hearts; broad leaves with darker pooled edges and a lighter midrib; blades and stems in single sweeping strokes.

### Line

No pen or ink line on scenery: sky, clouds, hills, trees, fields, water and plants are drawn by the edges of the washes alone. A fine, broken dark-sienna line appears only on subjects: the wheat in v01, the ants, the seed, the coin, a Mac mini or a sign in a story painting.

### Palette

Medians sampled from `refs/hero-day.webp`. They are for checking a result; describe colours to a model in words, and never use these as UI colours.

| Area | Hex | Share of the picture |
|---|---|---|
| Sky, top (deepest streaks) | `#bcd7e8` (`#aecee6`) | sky, from blue to white: about 42% |
| Sky, middle | `#dce9ee` | |
| Sky, low | `#eef1ee` | |
| Paper at the horizon, warm cream | `#f9f6ea` | paper and haze: about 18% |
| Farthest hill, blue-grey | `#c8d3cf` | |
| Hills, sage | `#adb78f` | |
| Tree clumps, hedgerows | `#7b8457`, `#828e62` | |
| Cypresses | `#5e673e` | |
| Lake | `#e5e9de` | |
| Roof, walls | `#cb9c64`, `#ebdcad` | |
| Meadow, soft yellow-green | `#c4be77` | meadow and earth: about 28% |
| Meadow, straw gold | `#bbb269` | |
| Bare earth, sandy ochre | `#d6b072` | |
| Leaves, olive | `#868421` | dark foreground greens: about 12% |
| Stems, deepest grass | `#535f27`, `#4b4e14` | |
| Clover, pink and crimson | `#b86d6b`, `#7e3634` | flower accents: under 1% |
| Daisy petal, heart | `#fdf7e4`, `#d49f10` | |

In words: a pale cerulean sky fading to warm cream paper; sage and blue-grey hills; straw ochre and soft yellow-green meadow; olive and moss foreground; small accents of clover crimson and daisy white with golden hearts. Muted throughout: nothing pure, nothing neon, no black. Overall the day is warm: on average red is 18 above blue.

### Values and light

- High key. Grayscale L (0 to 255): the top 60% sits between 208 and 241; the meadow between 145 and 170; the darkest values, 80 to 120, only along the bottom edge.
- The whole picture: mean L 196, 23% near-white (L 235 and up).
- Soft, diffuse late-morning light from above. No sun in the frame, no cast shadows, no rim light. Form shows only as a darker underside (tree clumps, leaves).

### Space

- The horizon sits 60 to 63% down from the top; the tree clumps at both ends rise to 53 to 55%. The line dips a little in the middle, framed by trees on both sides.
- Eye level is low, near the tops of the grass: the nearest flowers are big and cut by the bottom edge, the far hills a thin band.
- Detail falls off in three steps: drawn plants in the bottom fifth; tufts suggested in the meadow; flat shapes at the horizon (trees as blobs, a house in five strokes). The sky has no detail.
- Aerial perspective: the farther, the paler, bluer and flatter.

### Composition

- Sky and paper fill the top 60%. Titles, buttons and glass go there, centred: the homepage sets its pill, H1 and install glass in the sky from about 17% down.
- Nothing sits in the centre. The interest is at the two ends of the horizon and in the bottom corners.
- Foreground plants rise from the bottom edge, densest in both bottom corners (up to about 64% of the height at the sides), lower and sparser in the middle, so the bottom centre stays calm.
- The mascot, when one is placed, stands low at the right in the meadow, with plants in front of it.
- Balanced, never mirrored: the two sides differ in their trees and flowers.

### Never in it

People, animals, birds, insects (the ant is its own layer), a building in focus (one small farmhouse on the horizon is the limit), roads, fences, text, a signature, a frame or border, an outline on scenery, hard shadows, a sun disc, lens effects, saturated colour, black.

### The night

`refs/hero-night.webp`: the same scene, element for element, repainted at night. On the site it fades in over 1.2 s when the theme switches.

| Area | Hex |
|---|---|
| Sky, top | `#061b2c` |
| Sky, middle | `#183844` |
| Sky at the horizon | `#355b62` |
| Hills, moonlit slate blue | `#3e596f` |
| Meadow; nearer | `#325656`; `#27474a` |
| Bottom edge | `#0e2c33` |
| Tree clumps | `#041b2d` |
| Clover heads, dull violet | `#202b3b` |
| Daisy petals; hearts | `#9fb4ba`; `#6a7551` |
| Lake shine | `#9ab2be` |
| Moon; its halo | `#d2dada`; `#2a4d59` |
| The one lit window | `#d5bb7a` |

- Deep blue-green, not navy and not grey: mean L 54, no near-white at all. On average blue is 40 above red and green 30 above red.
- The sky is darkest at the top and lightens toward the horizon, so the hills read as a silhouette.
- Soft, cool moonlight from a small crescent tucked into the far top right corner, clear of the title. It catches the lake, the daisies and the hill crests in silver. No stars in the hero.
- Warmth in one place only: one small lit window, amber. The site adds fireflies in code; never paint them into a ground.
- The clouds turn into dark, barely visible shapes. The paper grain still shows.
- Every colour is repainted, not dimmed: ochre turns teal, pink turns violet-grey, white turns blue-grey.

**A night is an edit of the day, never a darkened day.** Attach the approved day, keep every shape where it is, change only the light and the colours. A darkened copy keeps the day's hues, turns grey-olive and fails the check below.

## What recurs

Every painting on the site shares these:

1. Cold-pressed paper grain in every flat wash.
2. Sky or bare paper across the top, fading to white or cream. Text sits there.
3. The meadow world: grass, clover, daisies, wheat, broad leaves, ferns, hills, a river, a pond. Clover and daisies come back in almost every foreground.
4. The same muted palette: pale cerulean, cream paper, sage, straw ochre, olive; crimson-pink and white flowers as the only accents.
5. Soft diffuse light; no cast shadows, at most a light contact shade under an object.
6. No line on scenery.
7. A night for every day, same composition, deep blue-green, warm in one or two small places at most.

What varies, by kind (measured on the site's files):

| Kind | What it is | Near-white, day | Mean L, day / night | On the site |
|---|---|---|---|---|
| Vignette | A close crop of a few plants, no characters, behind glass or text | 50–85% | 229–245 / 44–73 | v01–v11 |
| Scene | A whole view, no characters (the ant is a layer) | 23–32% | 196–201 / 54–57 | the hero, the footer |
| Story | Ants doing something in the meadow, beside the text | 42–75% | 208–231 / 64–113 | /colony/, /network/, /ecosystem/, /providers/, /ants/ |
| Spot | One ant on a small patch of painted ground, cut out | | | the network's steps |

- Light: late morning in the hero; golden hour in the footer and v10 (warm haze, the sun low at the end of the river).
- Nights: a vignette's night has no moon and no stars; the hero has its crescent; story nights may show a few small stars, one lantern or lit window, the Mac minis' tiny lights, the seeds' amber glow.
- Text: none in a vignette or a scene. A story painting may carry one short hand-lettered sign when the story needs it ("King of the Ant Hill", "$0.02/M").
- Characters: none in a vignette or a scene. A story painting has the mascot painted in, with its props: Mac minis as small white rounded boxes, seeds, green coins, wooden signs, stalls, ant hills. Its ants follow mascot.md, eyes included.

Not to copy: the nights of /colony/'s build and first paintings are the day darkened in code (grey-olive; blue minus red about 0, where every painted night on the site is +10 to +44).

## The paintings on the site

- **The hero** (homepage): `hero-ground-poster` by day, `whimsical-2-night-b` by night (spares: `-night-a`, a full moon top left; `-night-c`, no moon). The reference for any scene.
- **The footer:** a valley at golden hour down to a river, three ants resting on seeds; `meadow-loop-day-poster` and `meadow-loop-night-poster`, 1920 × 1080. The reference for a wide view.
- **Vignettes** `vNN-day` / `vNN-night`: v01 golden wheat (the reference for a close crop), v02 grass and clover, v03 a forest edge, v04 a sea shore, v05 ferns, v06 a river from above, v07 hills and hedgerows, v08 poppies and daisies, v09 a pond, v10 a field at golden hour, v11 a horizon band (21:9).
- **Story paintings:** /colony/ hero, build, first, how, join (16:9) and many (21:9); /network/ and /ecosystem/ heroes (4:5); /providers/ king (1:1) and stall; /ants/ pools and supply (1:1).
- **Spots:** the network's five steps, 640 square, cut out.

In a new page, reference them as `assets/paintings/<name>-day.webp` and `<name>-night.webp` (DESIGN.md, Imagery and assets).

## Placing a painting

Place a painting in its component's panel, cover-cropped, the windows on top: radius 11 in a two-option section, 16 in a card row and the page hero, 0 in a duo and the stacked hero (DESIGN.md, Shapes). Set `--wash-pos` on the point that must stay in frame. It arrives through the LED matrix and breaks into dots under the cursor, drawn by the kit's `effects/arrival.js` and `effects/mosaic.js`, loaded at the end of `<body>` as `<script type="module" src="effects/arrival.js"></script>` and `<script type="module" src="effects/mosaic.js"></script>` (DESIGN.md, Motion & Micro-interaction).

## Making a painting

Anyone can make one, by hand or with an image model. Follow the recipe, then the checklist. A painting that fails one line of the checklist does not ship.

### Rules

1. **Edit, don't re-describe.** Anything that must match an existing image (a night, a higher resolution, a change) is an edit: attach it, start with `Edit @img1.`, say what to keep exactly, then what to change.
2. **A night is always an edit of the approved day**, pixel-aligned so the two crossfade. Never a darkened copy, never a fresh generation.
3. **Never ask for dots, dither, an LED matrix, glass or fireflies.** The image is plain watercolour; code draws the rest (the kit's `effects/`, the site's fireflies).
4. **Sky and paper across the top, few elements, detail only in the foreground.** Too much detail fights the text.
5. **No transparency exists in these models.** Generate on plain white and cut out afterwards.
6. **Describe colours in words.** Models don't follow hex codes; check the hex values afterwards.
7. **Forbid what models add by habit:** moon, stars, fireflies, lit windows, falling leaves, particles, birds, text, signatures, frames, borders, shadows, ground lines.
8. **Attach the references in the order the prompt names them:** `@img1` is the first image attached, `@img2` the second.
9. **Tag each prompt** with a short name at the end (`v12 day.`) so outputs can be found.

Tested with Nano Banana 2.1 in Magnific (1K, one image per generation, two or three tries, then the pick repainted at 2K), GPT 2.6 when an ant's leg must be exact, Kling 2.6 for loops. Another model works the same way with the same prompts.

### References to attach

All in `refs/`.

| File | What it is | Attach it for |
|---|---|---|
| `hero-day.webp` | The homepage hero by day, 1920 × 1080 | Any scene or ground: the style reference |
| `hero-night.webp` | Its night, 1376 × 768 | The night of a scene |
| `vignette-v01-day.webp`, `-night.webp` | v01, golden wheat, 1200 × 896 | A close crop (a card, a two-option ground) and its night |
| `story-colony-day.webp`, `-night.webp` | /colony/'s hero, ants carrying a Mac mini, 1600 × 893 | A story painting with ants, and its night |
| `wide-footer-day.webp`, `-night.webp` | The footer's valley at golden hour, 1920 × 1080 | A wide view, warm light |
| `mascot-you.webp` | The mascot, 641 × 992 | Every ant (mascot.md) |
| `mascot-carry.webp` | An ant carrying a card, the walk's raw render | An ant at work |
| `seed.webp` | The seed, 470 × 651 | A seed in a picture |

### Sizes

The model's 1K sizes: 16:9 = 1376 × 768, 4:3 = 1200 × 896, 21:9 = 1584 × 672, 1:1 = 1024 × 1024. 2K doubles them.

| Use (DESIGN.md) | Generate | Deliver |
|---|---|---|
| A homepage-style hero, the footer | 16:9, then 2K | 1920 × 1080 |
| Page hero panel (704 × 792 at 1440, 16:9 under 1200, 4:3 on phones) | 16:9 with the subject in one third, or 4:5 | 1600 wide; `--wash-pos` on the subject (the Colony hero: `86% 50%`) |
| Two-option panel (588 × 331 at 1440, cropped at `50% 85%`) | 16:9, the subject low | 1600 × 893 |
| Card (384 × 288 at 1440) | 4:3, then 2K | 2400 × 1792 (1200 × 896 for a trial) |
| Duo (half the rail, at least 560 high; 4:3 under 900) | 4:3 or 16:9, the subject in the middle third | 1600 wide |
| Steps band `.s-wide` (1312 / 620; 4:3 on phones) | 21:9, the subject in the middle | 2400 wide |

### A scene or a ground, by day

`@img1` = `refs/hero-day.webp`. `[SUBJECT]`: the view; `[FAR FEATURE]`: one small thing at the horizon (a farmhouse, a lake, a line of trees).

```text
A watercolour landscape painted in exactly the style of @img1: the same cold-pressed watercolour paper with its fine grain showing through every wash, the same soft transparent washes, wet-in-wet sky and crisp dried edges, the same muted palette and the same soft diffuse daylight. Subject: [SUBJECT]. Composition as in @img1: a low horizon about 60% down; the top 60% is a pale cerulean sky in loose horizontal streaks that fades to white paper and warm cream at the horizon, calm and empty so a title can sit on it; [FAR FEATURE], small, at the horizon; a meadow of straw ochre and soft yellow-green bands; clover, daisies, grass blades and broad leaves rising from the bottom edge, dense in both bottom corners and low in the middle. Detail only in the foreground; the far hills are flat pale washes, the farthest blue-grey. No pen line, no outlines on the scenery. No sun, no cast shadows, no people, no animals, no birds, no insects, no ants, no text, no signature, no frame, no border. The painting fills the whole image edge to edge. [TAG] day.
```

This template is assembled from the hero's description and the sentences that worked below; the hero's own prompt was never recorded. Check its first tries against the checklist with care.

With no reference image, use this prompt (Nano Banana 2.1, 1K, 16:9; four tries out of four held the style). For another scene, keep its first two sentences and its last three.

```text
A wide watercolour landscape on cold-pressed paper, its grain visible through every wash, painted edge to edge with no white border. Soft transparent lavis, wet-in-wet, loose and lightly detailed, like a page from a nature picture book. A low horizon about 62% down. The sky is a calm, empty, pale granulated cerulean wash, only slightly deeper at the top, fading through very pale blue to warm cream at the horizon, with no defined clouds. At the horizon, gently rolling pale sage hills with one far blue-grey hill, a small sliver of pale lake right of centre, soft muted olive clusters of trees at both edges, and on the left one tiny distant farmhouse with a terracotta roof beside three slim cypresses. Below, the meadow fills the whole ground with no bare paper: soft overlapping glazes of muted yellow-green and straw ochre, faint warm sand patches in the middle, and a few dry-brush grass tufts. Along the bottom edge only, densest in both corners, a few loosely painted crimson clover, white daisies with yellow centres, ochre grass seed heads and broad green leaves. The whole palette is muted, light and airy. Detail fades quickly with distance. No pen lines, no outlines, no sun, no hard shadows, no people, no animals, no insects, no text, no frame.
```

### A vignette, by day

`@img1` = `refs/vignette-v01-day.webp`. `[SUBJECT]`: one close crop, placed low or to one side. This is the prompt that made v02 and v11.

```text
A small decorative watercolour vignette painted in exactly the style of @img1: the same cold-pressed watercolour paper grain, the same soft transparent washes, the same loose suggested brushwork, the same light airy palette and the same amount of untouched white paper. Subject: [SUBJECT]. Very few elements, sparse and suggested, soft edges, no fine detail, no dense texture, low contrast, large quiet empty areas so text can be read over it. No characters, no ants, no insects, no animals, no birds, no people, no buildings, no text, no lettering, no signature, no frame, no border. The painting fills the whole image edge to edge. [TAG] day.
```

When it must carry text, write the subject as "a close, simple crop of …, all kept low in the lower part of the page. The upper two thirds are pale sky fading into blank white paper."

### A story painting, by day

`@img1` = `refs/story-colony-day.webp`, `@img2` = `refs/mascot-you.webp`. `[SCENE]`: who does what, where, kept low in the frame; `[EYES]`: the sentences from mascot.md, The eyes.

```text
A watercolour storybook illustration painted in exactly the style of @img1: the same cold-pressed watercolour paper grain, the same soft transparent washes and crisp dried edges, the same muted meadow palette and soft diffuse daylight, with a fine dark brown line only around the characters and objects, none on the landscape. Every ant is exactly the ant of @img2: a round brown head, two huge white eyes set apart with small black pupils, a flat line mouth, two antennae with round ball tips, a lime-green bandana, a round abdomen behind, thin little arms. Scene: [SCENE]. The action sits low in the frame; the top third is a pale sky fading into blank white paper. [EYES] Every ant has exactly TWO legs, both under its body; nothing grows from the round abdomen. No people, no other animals, no birds, no text, no letters, no frame, no border. The painting fills the whole image edge to edge. [TAG] day.
```

Also assembled from sentences that worked; expect to fix the ants' eyes in code (mascot.md).

### Its night

`@img1` = the night of the same kind (`hero-night`, `vignette-v01-night` or `story-colony-night`), `@img2` = the approved day.

```text
Edit @img2. Turn this watercolour into the same scene by night, in exactly the night style of @img1: the same deep green-blue moonlit palette, soft transparent washes and the same cold-pressed paper grain. Keep the composition of @img2 exactly the same, element for element and pixel aligned: every shape, edge, horizon line, blade and wash stays in the same place and at the same size, so the day and night versions line up perfectly when crossfaded. Only the lighting and colours change: cool moonlight, deep teal and blue-green tones, soft pale highlights. Keep it as sparse as @img2: where @img2 is blank paper, the night version stays a calm, luminous blue-green paper wash and is not painted over with new grass, leaves, hills or shapes. Do not add a moon, stars, lights, characters, ants, animals, people, buildings, text, frame or border. Same framing, no crop, no zoom. [TAG] night.
```

Add-ons that solved specific problems:

- It still repaints the paper: "Recolour only: keep exactly the same grass blades as @img2, the same number, width and position, with the same open paper at the left and right sides; do not add, thicken or redraw any blade."
- A title sits on it (the hero): "The whole upper sky from the left fifth to the right fifth of the image stays dark, calm and empty: no moon, no stars, no bright clouds there, so a wide white title placed across it reads clearly. A small soft crescent moon tucked into the far top right corner of the image, close to the right edge." The model lit two windows every time; one was painted out by hand.
- Ants are in it: "Keep the ants, their poses, faces, eyes and pupils, bandanas and positions exactly as in @img2." Replace "Do not add a moon, stars, lights, characters, ants" with "Do not add a moon, lights, characters" and allow "a few small faint stars high in the sky" if wanted.
- Seeds in it: "The seeds glow softly from inside with a warm amber light, like embers seen through a thin shell, discreet and calm. No rays, no lens flare."
- The sky meets the dark page: "The sky darkens smoothly upward and the top of the sky becomes almost black, a very dark green-black, so the painting fades into a dark page at the top edge."

### At 2K

The 1K pick as the only reference, day and night each; no upscaler.

```text
Repaint this exact watercolour illustration at high resolution. Keep the composition, every element, its position and size, the colours, the light and the paper texture exactly as in the reference; nothing added, nothing removed, nothing moved. Crisp, clean hand-painted watercolour on paper, fine detail, no text.
```

### An object

A seed, a coin, a thing an ant holds. Style reference `refs/wide-footer-day.webp`; `@img1` = `refs/mascot-you.webp`, for its line.

```text
Square watercolour illustration of a single [OBJECT], painted in the loose hand-made watercolour style of the style reference painting, with a fine thin dark felt-pen outline drawn around [ITS EDGES], exactly like the thin felt-pen line on the ant in @img1. The [OBJECT] floats alone in the centre of the image with generous empty space all around it, seen in a clear three-quarter view, [TILT]. [OBJECT] colours: [COLOURS IN WORDS]. No letters, no numbers, no text, no symbols on the [OBJECT]. Background: one pale plain quiet watercolour wash of light green and cream on off-white textured paper, nothing else in the scene. Loose, not too detailed, no metal, no shine, no glow, no 3D, no shadow. [TAG].
```

### A loop

Kling, the approved painting as start and end frame, 1080p, 5 s. Fix the still first: a video takes its style from it.

```text
Almost still watercolour painting, a cinemagraph with extremely delicate, barely perceptible motion. Static locked-off camera, no zoom, no pan. Only the faintest breeze: [WHAT MOVES, a few millimetres at most]. Everything else is completely still: [LIST]. The sky stays empty: absolutely nothing flies, falls or drifts through the air. No falling leaves, no petals, no birds, no insects, no particles, no new objects. Same watercolour style, colours and framing. No text. [TAG].
```

### After the render

1. Pick at 1K with the checklist below.
2. Story painting: fix the eyes of every ant that needs it on the day, before the night (mascot.md).
3. Make the night from the fixed day. Lay the night over the day in difference mode, or flip between them at 100%: the horizon, hills, trees, flower heads and ants must not move. No drift is normal.
4. Repaint both at 2K, each from its own 1K pick. Check the pair again.
5. A full-bleed painting whose sky meets the dark page: fade the top of its night to exactly `#0f1312`, over about 110 px at 1K, 220 px at 2752 wide.
6. Export WebP: 2K at quality 80, 1K at 1200 wide and quality 82, cut-outs at 88, method 6. Keep the PNG master. Name the pair `<name>-day.webp` and `<name>-night.webp`, the same size.
7. Never ship a raw AI upscale (it looks plastic). If you must use an upscaler, blend 60% of it with 40% of a plain Lanczos enlargement.

### Accept or reject

Measure with Pillow:

```python
from PIL import Image
im = Image.open('name-day.webp').convert('RGB'); h = im.convert('L').histogram(); n = sum(h)
print('mean L', round(sum(i * c for i, c in enumerate(h)) / n), 'near-white %', round(100 * sum(h[235:]) / n))
px = list(im.resize((320, 180)).getdata()); print('blue minus red', round(sum(b - r for r, g, b in px) / len(px)))
```

The day passes when:

- [ ] Paper grain shows in the sky at 100%.
- [ ] Mean L and near-white fall in the range of its kind (What recurs).
- [ ] The top is sky or paper, calm, with nothing where the title or the glass will sit.
- [ ] Nothing sits in the centre; the subject is low or at the sides.
- [ ] Edges are wash edges: no outline on hills, trees, sky, water or plants.
- [ ] The palette is muted: no neon, no pure green, no black; the only bright spots are small flowers.
- [ ] It looks hand-painted at 100%: no plastic sheen, no smooth digital gradient, no repeated texture.
- [ ] None of rule 7's habits, no dots, no glass.
- [ ] Every ant passes mascot.md: one design, two legs, its eyes checked.

The night passes when:

- [ ] Every shape sits on the same pixels as the day.
- [ ] Mean L falls in the range of its kind (What recurs), with no near-white.
- [ ] Blue minus red is +10 or more (the hero is +40; a story night with a lantern can drop to +10). A darkened day sits near 0 and fails.
- [ ] Where the day was blank paper, the night is a calm blue-green wash, not new grass or hills.
- [ ] Warm light in one or two small places at most; no moon or stars unless asked.
- [ ] The ants' pupils are where they were in the day.

Reject on the first failed line and run the prompt again. The only hand fixes are the eyes, in code, and painting out an extra lit window.
