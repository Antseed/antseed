# Antseed mascot

Open this to draw, pose or place the ant. DESIGN.md comes first; paintings are in watercolour.md.

## The character

One ant for everything: a small, chubby, round ant painted in soft watercolour with a thin dark-brown ink line. A cartoon, never an insect. It always looks a bit lost: huge eyes set apart, pupils that drift, a flat little mouth, total serene incomprehension. It carries things and gets amazed. It is never scary, gross, determined, cool or heroic.

The reference is You: `refs/mascot-you.webp` (641 × 992, cut out; the render's white stays under its transparency, so a tool that drops transparency still sees it on white). Attach it to every prompt for an ant.

- **Head:** enormous and round, about half its height without the antennae, a pale wet-in-wet bloom on top.
- **Eyes:** two huge white discs outlined in dark brown, set apart with a gap between them, each about a third of the head's width. In three-quarter view the far eye bulges past the head's outline.
- **Pupils:** small black dots, about a fifth of the eye's width, each with a tiny white catchlight. Where they sit: The eyes, below.
- **Mouth:** a tiny flat line with a small tick at each end, low between the eyes. No eyebrows, no nose.
- **Antennae:** two, thin, slightly curved, each ending in a small ball.
- **Bandana:** lime green, knotted at the back of the neck, its two ends like small leaves, its point at the front. It is You's mark.
- **Body:** a pear-shaped chest under the head, a big round abdomen behind with soft painted segment lines. No waist pinch, no visible joints.
- **Arms and legs:** two thin boneless arms with mitten hands; exactly two short legs with small round feet, both under the body. Nothing grows from the abdomen. **Count the feet in every image: an ant with three or four feet is rejected, whatever else is right.**
- **Paint:** warm brown around `#be7853`, ink line around `#3c1b08`, bandana lime around `#b1c633` (`#9abb19` in its folds), eye white `#ffffff`, pupils near black. These describe the paint; describe them to a model in words, and never use them as UI colours.
- **Delivery:** a cut-out on transparency, no sticker outline, no cast shadow in the file.

## The eyes

Every ant looks a bit lost ("hagard"): two huge white eyes set apart, small pupils, a blank face. Where the pupils go depends on what the ant is doing.

1. **By default, divergent strabismus.** Each pupil drifts outward, toward the outer rim of its own eye: the left pupil to the left, the right pupil to the right, one a little higher than the other. The two never rest on one point: not on the viewer, not on another ant, not on an object.
2. **A passive ant, or one secondary to the action, always keeps it:** an ant resting, waiting, watching or listening, a background character, an onlooker, a queue, a crowd.
3. **An ant concentrating on an action may look at it:** carrying a load, reading a screen or a receipt, planting a flag, eating the seed, catching the coin. Both pupils then turn toward what it is doing. Only that ant: the ants around it keep the lost look.
4. **Never centred pupils.** Never crossed eyes, except on a thing the ant holds close and is busy with (the hero ant on its seed).

`refs/mascot-you.webp` shows rule 1: the near pupil a little out and up, the far pupil at the outer rim. `refs/mascot-carry.webp` shows rule 3: an ant hauling a card, its eyes on the way ahead (the site's sprite gives it the lost look anyway).

### In the prompt

Models return centred, focused eyes by habit. Ask anyway, in words:

```text
passive: Its eyes look lost and wall-eyed: each small black pupil sits at the outer edge of its own eye, the left pupil looking left and a little up, the right pupil looking right and a little down, never both on the same point.
acting: It looks at [THE THING] it is [DOING]: both pupils turned toward it.
crowd: Every ant that is only watching or waiting has lost, wall-eyed eyes: each pupil at the outer edge of its own eye, never both on the same point. Only the ant [DOING THE ACTION] looks at [THE THING].
```

### Check every ant, in every try

Before you pick an image, and again on its night and its 2K repaint (an edit can move the pupils back to the centre):

1. Crop each ant's head and view it at 200%.
2. Decide its role: acting (rule 3) or not (rules 1 and 2). In doubt, it is not acting.
3. Not acting: it passes only if the left pupil sits in the outer half of the left eye and the right pupil in the outer half of the right eye, at least one at or near the rim, the two at different heights. It fails if a pupil is centred, if both turn the same way, or if they cross.
4. Acting: it passes if both pupils point at what it is doing. It fails if they stare at the viewer or at nothing.
5. One failing ant fails the image: fix it in code (below) or run the prompt again.

### Fix it in code: `derp-eyes.py`

`tools/derp-eyes.py` in this kit (the site's own script, Python 3 with Pillow) gives one ant the lost look:

```text
python3 derp-eyes.py in.png out.png [scale] [push]
# scale: the pupil's new size, default 0.72; push: 0 to 1 of the way to the eye's rim, default 1.0
```

It finds the two largest closed white areas (grayscale above 205, not touching the image's border) and takes them for the eye whites. In each it lifts the pupil out (the dark hole in the white, or the dark pixels inside the eye's ellipse when the pupil touches the rim), fills the place with the eye's own white, shrinks the pupil to `scale` and sets it back on the line pointing away from the other eye, `push` of the way to the rim: the left pupil tilted up, the right one down. It prints `ok`, `no two eyes` or `no pupil found`.

Use it this way:

- **One ant per file.** It takes the two biggest white areas in the whole image. On a painting it grabs paper, Mac minis or daisies instead (on /colony/'s join painting it moved two Mac minis). Crop each ant's head with a margin, run the script on the crop, paste the crop back exactly.
- **On the day, before the night.** At night the eye whites are darker than 205 and it finds nothing. Make the night from the fixed day, then check that the night kept the pupils.
- **Vary a crowd.** Every ant it fixes drifts the same way (left up, right down). Flip some crops horizontally before running it and flip them back after.
- **Look at the result at 200%.** It can leave the left pupil centred: that ant still fails, so move that pupil yourself. When a pupil overlaps the eye's outline it can leave the old pupil and clip the new one. Closed eyes and sunglasses are out of its reach; round glasses may work, check.
- **A walk cycle:** one pupil place per eye for every frame, or the eyes jump as it walks (the site's carry sprites, `assets/home/carry/build.py`, `lost()`).

### Where the site still differs

These predate the rule. Don't copy them: the network board's idle, look, cheer, send and receive ants (three or four feet); /colony/'s join painting (the three ants sitting at their Mac minis all look right, at the newcomer); the footer's two awake ants at rest (they look at each other).

## Roles are props

One body, dressed for its role. Never colour-coded tags.

- **You** (your device): the mascot itself, lime bandana.
- **Provider** (runs models, sells answers per request): big round black-rimmed glasses over its eyes (the eyes and pupils still visible through the lenses), a charcoal hoodie with the hood down, no bandana.
- **User** (someone else on the network): a golden-amber ant with a sky-blue bandana.
- **In a crowd** each ant may differ by one prop (a red knitted beanie, lime headphones, a grey hoodie) or a golden-amber tint. The body and the face never change.
- **Sunglasses** mean Private, never night.
- **The seed** is the request: caramel, almond-shaped, carried, hugged or eaten. A soft amber glow at night, never gold.
- **The green coin** with the white Antseed mark is $ANTS.
- **A model card** is carried at its side like a big box, its hand on the card's lower corner.
- **A Mac mini** (a small white rounded box) is a Colony machine: carried overhead, set on a bench, sat at.

## Poses in use

- **Idle**, standing, arms relaxed, the lost look.
- **Carry walk:** an eight-frame walk hauling a price card, the ant a third of the card's height, the lost look fixed in every frame. Under the pointer it stops and looks; a click and it hops, then runs to catch up.
- **Amazed:** arms up, mouth open, looking up at the floating coin (rule 3); its pupils tremble.
- **Incognito:** sunglasses, a faint knowing smile, sitting with its legs over an edge.
- **The hero ant:** its eyes follow the pointer and cross on the seed; it reaches for the seed and eats it (rule 3).
- **The footer:** three ants painted into the meadow, resting on seeds, apart from one another.
- **Story paintings** (/colony/, /network/, /ecosystem/, /providers/, /ants/): ants painted into the scene, at work or watching. Rules 1 to 3 apply to each one.

## At night

The ant takes the night's light, never a costume. Every cut-out ant gets `filter: brightness(.84) saturate(.83) contrast(1.12)` at night, faded in over 1.2 s with the page. An ant painted into a story painting is repainted with its night (watercolour.md, Its night), its pupils kept where they were.

## Where it goes

- A cut-out: one per composition, low or at a side, never in the centre and never over the text. On a painting or on paper; never on glass, never inside a window.
- A story painting may hold many ants, painted in, each following The eyes.
- Big in comms (a post, a banner), a supporting part on the site.
- Anywhere an ant is not a character, it is a dot: 1.9px, acid at night, walking the 8px grid.

## Making a new pose

Re-render, never assemble: no rig, no puppet from parts, no pose moved by script. Only the pupils move in code.

1. Attach You as `@img1` (`refs/mascot-you.webp`); for a costume, its archetype as a second reference; for an ant at work, `refs/mascot-carry.webp`.
2. Nano Banana 2.1 in Magnific, 1K, square, three tries. GPT 2.6 when one leg must be exact.
3. Generate on plain white; cut it out afterwards (no model gives transparency). Describe colours in words, never in hex.
4. Check the eyes (above). Run `derp-eyes.py` on any ant that is not acting and fails.
5. End every prompt with a short tag (`Provider idle.`) so the output can be found.

The template (slots `[COSTUME]`, optional; `[POSE]`; `[EYES]`, a sentence from In the prompt):

```text
The same cute watercolour ant mascot as the reference, same character, same framing, same hand-painted watercolour style with a dark brown outline: round brown head, two huge white eyes set apart with small black pupils, a flat line mouth, two antennae with round ball tips, a lime-green bandana, a round abdomen behind, thin little arms. [COSTUME] [POSE]. [EYES] The ant has exactly TWO legs, both under its body, standing on its two feet; nothing grows from the round abdomen: no legs or feet under it. Two legs and two arms only. Full body, centred, plain pure white background, no shadow, no ground, no text. [TAG].
```

Pose sentences that worked (`@img2` is the seed, `refs/seed.webp`):

```text
idle: standing, calm, arms relaxed at its sides, a blank lost stare.
receive: a seed has just landed in its arms: it hugs the seed against its chest with both little arms, eyes closed in two happy upturned arcs, a small smile, antennae perked up. The seed looks exactly like @img2, small next to the ant.
cheer: both little arms raised up high in joy, eyes wide and shining, mouth open in a small happy round "o", antennae up.
send: it tosses a seed up and forward with both arms, as if passing it to a friend far away; the seed has just left its hands and is a little above and in front of them. The seed looks exactly like @img2, small next to the ant.
look: it turns its head up and to the side, as if watching something fly overhead, curious, antennae tilted, arms relaxed.
```

The provider's costume:

```text
now as a geek: it wears big round black-rimmed glasses over its big eyes (the white eyes and small black pupils still visible through the lenses) and a charcoal-grey hoodie with the hood down, instead of the bandana.
```

Ask for an expression in words ("eyes wide open, mouth open in an amazed 'oh!'"), never by naming a character from elsewhere, and never attach another character's images.

## Never

- A realistic insect, mandibles, jointed or six legs, four legs, legs under the abdomen.
- A second ant design. The earlier slim ant (long jointed limbs, crossed arms, a smirk or a snarl; the site's `assets/home/ant-1.png`, `ant-2.png`, `ant-3.png`) is retired.
- Centred, focused pupils on an ant that is not acting; two passive ants gazing at each other.
- The blue orb, or anything on its head but a role's prop.
- Sunglasses at night; a cool or heroic look.
- An outline on the scenery around it, or a busy painting behind it.
