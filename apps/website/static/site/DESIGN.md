---
version: alpha
name: Antseed
description: The open intelligence network. A clean developer product page on white rails and a dot-matrix margin, with soft watercolor landscapes and one round, slightly lost ant.
colors:
  primary: "#4f7a24"
  primary-hover: "#436a1e"
  primary-hover-night: "#5b8a2b"
  primary-lip: "#3b5e17"
  on-primary: "#ffffff"
  primary-text-night: "#98c463"
  acid: "#c8f53c"
  ink: "#0a1a12"
  title: "#000000"
  text: "#30382c"
  title-gray: "#929292"
  body: "#56656f"
  small: "#66746b"
  nav-gray: "#737373"
  tab-off: "#6b6b6b"
  page: "#fcfcfc"
  rail: "#ffffff"
  dot: "#e2e2e2"
  ring: "#e4dfd2"
  track: "#f7f8f5"
  tile: "rgba(214, 219, 211, 0.2)"
  tile-line: "rgba(64, 76, 66, 0.1)"
  wash: "#f6f3ea"
  band: "#181d1b"
  night-page: "#0f1312"
  night-rail: "#181d1b"
  night-text: "#eceee9"
  night-gray: "#9ba49e"
  night-dot: "#3d4340"
  night-wash: "#39403d"
  night-tile: "rgba(255, 255, 255, 0.06)"
  night-tile-line: "rgba(255, 255, 255, 0.1)"
  night-ring: "rgba(236, 238, 233, 0.14)"
  glass: "rgba(255, 255, 255, 0.62)"
  glass-smoked: "rgba(14, 33, 23, 0.64)"
typography:
  display:
    fontFamily: Geist Pixel
    fontSize: 90px
    fontWeight: 400
    lineHeight: 93px
    letterSpacing: -0.08em
    fontVariation: '"ELSH" 11'
  headline:
    fontFamily: Geist Pixel
    fontSize: 48px
    fontWeight: 400
    lineHeight: 46px
    letterSpacing: -2px
    fontVariation: '"ELSH" 40'
  figure:
    fontFamily: Geist Pixel
    fontSize: 52px
    fontWeight: 400
    lineHeight: 1
    fontVariation: '"ELSH" 20'
    fontFeature: '"tnum"'
  headline-sm:
    fontFamily: Geist Pixel
    fontSize: 30px
    fontWeight: 400
    lineHeight: 34px
    letterSpacing: -1px
    fontVariation: '"ELSH" 40'
  eyebrow:
    fontFamily: Geist Pixel
    fontSize: 18px
    fontWeight: 400
    lineHeight: 27px
    fontVariation: '"ELSH" 20'
  lede:
    fontFamily: Geist
    fontSize: 26px
    fontWeight: 400
    lineHeight: 36px
    letterSpacing: -0.01em
  subtitle:
    fontFamily: Geist
    fontSize: 18px
    fontWeight: 400
    lineHeight: 27px
  title-sm:
    fontFamily: Geist
    fontSize: 18px
    fontWeight: 500
    lineHeight: 26px
  body:
    fontFamily: Geist
    fontSize: 16px
    fontWeight: 400
    lineHeight: 24px
  body-sm:
    fontFamily: Geist
    fontSize: 14px
    fontWeight: 400
    lineHeight: 20px
  button:
    fontFamily: Geist
    fontSize: 15px
    fontWeight: 500
    lineHeight: 20px
  control:
    fontFamily: Instrument Sans
    fontSize: 14px
    fontWeight: 500
    lineHeight: 20px
  label:
    fontFamily: Geist
    fontSize: 13px
    fontWeight: 400
    lineHeight: 16px
  mono:
    fontFamily: Geist Mono
    fontSize: 13px
    fontWeight: 400
    lineHeight: 20px
  mono-sm:
    fontFamily: Geist Mono
    fontSize: 12.5px
    fontWeight: 400
    lineHeight: 16px
rounded:
  min: 2px
  tile: 3px
  control: 5px
  popover: 6px
  window: 8px
  button: 10px
  card: 11px
  field: 12px
  plate: 14px
  full: 999px
spacing:
  grid: 8px
  body-margin: 16px
  gutter: 96px
  rail-max: 1312px
  rail-pad: 145px
  section: 120px
  section-phone: 72px
  head-gap: 16px
  head-to-content: 56px
  duo-pad: 64px
  duo-gap: 36px
  card-gap: 24px
  lane-gap: 12px
  actions-gap: 12px
  feature-row: 8px
  bp-phone: 760px
  bp-tablet: 1023px
  bp-stack: 1199px
components:
  nav:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    height: 69px
    padding: 0 16px
  nav-button:
    backgroundColor: "{colors.primary}"
    textColor: "#fafafa"
    typography: "{typography.control}"
    rounded: "{rounded.button}"
    height: 36px
    padding: 0 13px
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.button}"
    height: 44px
    padding: 0 20px
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-ghost:
    backgroundColor: "{colors.tile}"
    textColor: "{colors.text}"
    typography: "{typography.button}"
    rounded: "{rounded.button}"
    height: 44px
    padding: 0 20px
  pill:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    height: 24px
    padding: 0 11px
  install-block:
    backgroundColor: "rgba(255, 253, 219, 0.33)"
    rounded: "{rounded.field}"
    padding: 12px
    width: 600px
  command-line:
    backgroundColor: "rgba(10, 26, 18, 0.1)"
    textColor: "{colors.ink}"
    typography: "{typography.mono}"
    rounded: "{rounded.window}"
    height: 48px
    padding: 0 6px 0 16px
  segmented-tabs:
    backgroundColor: "{colors.track}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.window}"
    height: 36px
    padding: 4px
  media-tab:
    textColor: "{colors.tab-off}"
    height: 48px
  media-tab-selected:
    textColor: "{colors.text}"
  model-card:
    backgroundColor: "{colors.tile}"
    textColor: "{colors.text}"
    rounded: "{rounded.card}"
    padding: 18px
    size: 176px
  glass-window:
    backgroundColor: "{colors.glass}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.window}"
  glass-window-night:
    backgroundColor: "{colors.glass-smoked}"
    textColor: "#ecf3ee"
  step-card:
    backgroundColor: "rgba(255, 255, 255, 0.36)"
    textColor: "#1b211e"
    rounded: "{rounded.window}"
    padding: 20px
---

# Antseed

## Overview

Picture the spec sheet of a peer-to-peer network printed on watercolor paper. The layout is a serious developer product page: one white rail, generous space, titles in a face made of dots, numbers in monospace, one green button. The pictures are small, sparse watercolor landscapes from a nature picture book, and a single round ant lives in them, a little lost, carrying things.

It speaks to prosumers: people who run agents, choose models and read docs, and still like a product with a face. Every page has two halves. The layout is the technical half and says what Antseed sells within two seconds. The paintings, the round shapes and the ant are the friendly half. Neither swallows the other.

Four ideas hold the whole system:

- **The dot is the ant.** A point that walks, queues, gathers and carries is an ant seen from far away. The margins are a matrix of dots, outlines are rows of dots, the titles are set in a pixel face with round dots, and paintings arrive as an LED matrix of dots.
- **Nothing has a center.** Antseed has no middleman. No layout, diagram or picture is built around a hub. Peers sit apart; a painting's subject sits low or at the sides.
- **The seed is the request.** It is what gets passed along: the cursor in the hero, what the ants carry. Caramel by day, a soft amber glow at night.
- **Day and night are two paintings.** Night is never a filter on the day. Every image has its own night, and the interface follows the reader's system theme by default, with a switch.

## Colors

Two families: a paper-and-ink UI with one green, and the paintings' own colors, which never become UI colors.

- **Meadow green** {colors.primary} is the one action color: the filled button, the eyebrow, links, the saving on a price card, a selected tab's line. Hover darkens it to {colors.primary-hover} by day and lightens it to {colors.primary-hover-night} at night. Its button keeps a darker lip of {colors.primary-lip} along the bottom edge.
- **Acid** {colors.acid} is light, not paint: the walking dot-ants, the lit line on the network board at night, a cursor's trail. Never a button, never text on white, never a large fill.
- **Ink** {colors.ink} is the controls' text (nav, tabs, command line). **Text** {colors.text} carries titles and running copy. The three product sections (prices, Gateway, Desktop) set their titles in pure {colors.title}; anything new uses {colors.text}.
- **Grays:** {colors.title-gray} for the second half of a two-part title and the dimmed half of the lede; {colors.body} for subtitles and captions; {colors.small} for small print; {colors.nav-gray} for the band's labels and the theme switch. Inactive media tabs are {colors.tab-off} (5.3:1 on white).
- **Paper:** the margins are {colors.page} with dots in {colors.dot}; the rail is {colors.rail}. Hairlines and control rings are a warm {colors.ring}. Ghost buttons and price cards fill with {colors.tile}; ghost buttons add a 1px {colors.tile-line} border, price cards have none. A painting panel waits in {colors.wash} before its painting arrives.
- **The privacy band** is {colors.band} from margin to margin in both themes: the one dark place on the day page.

Night swaps the paper, not the green. The page becomes {colors.night-page}, the rail {colors.night-rail}, text {colors.night-text}, every gray {colors.night-gray}, dots {colors.night-dot}, the waiting panel {colors.night-wash}, tiles {colors.night-tile} with a {colors.night-tile-line} edge, hairlines {colors.night-ring}. Green text lifts to {colors.primary-text-night}; the filled button keeps {colors.primary} with only its dark lip. The logo goes from black to near-white with `invert(.93)`. Glass over a painting turns smoked green ({colors.glass-smoked}). Shadows at night use deep green-black, never gray.

## Typography

Three faces of one family, plus one for controls.

- **Geist Pixel** (variable, axis ELSH: 1 square to 100; served as a file, since Google Fonts serves only its solid shape) for the H1, titles, eyebrows and figures: ELSH 11 for the H1, 40 for titles, 20 for eyebrows, figures and step numbers. Load it under its own name, `@font-face { font-family: "Geist Pixel Var"; src: url(fonts/GeistPixel-VariableFont_ELSH.ttf); }`, and leave font smoothing at the browser's default: `-webkit-font-smoothing: antialiased` thins its dots to a faint grid.
- **Geist** 400 and 500 for everything people read: lede, subtitles, body, buttons, captions.
- **Geist Mono** 400 and 500 for code, commands, prices, hashes and a card's small detail line.
- **Instrument Sans** 500 for the controls in the hero and nav (nav buttons, the install tabs, the media tabs).

Hierarchy, top down:

- **Display** {typography.display}: the H1 only, in two tones (the first line #1c1c1c, the second #595959; at night #eceee9 and #9ba49e), opacity 0.82, centered, no full stop. On a phone 46/50; between 761 and 1023 px it scales at 8.4vw so it holds on one line.
- **Headline** {typography.headline}: every section title, as a two-part sentence. The second part is gray ({colors.title-gray}). The FAQ's is 42px. On a phone 34/36, tracking -1.4px.
- **Headline-sm** {typography.headline-sm}: a card's title under its painting (26/30 below 1200px).
- **Eyebrow** {typography.eyebrow}: green, above the title, the product or the topic followed by " ›", linking to its docs page. Optional: the prices and the FAQ have none.
- **Figure** {typography.figure}: live numbers, tabular, 34px at the smallest; a 13px gray label sits 14px above each.
- **Lede** {typography.lede}: the introduction only, its second paragraph in gray.
- **Subtitle** {typography.subtitle}, at most 780px wide (620px for a narrow one), in {colors.body}.
- **Title-sm** {typography.title-sm}: FAQ questions and the privacy levels' names. Card names drop to 500 15/20 or 16/22.
- **Body** {typography.body}; **body-sm** {typography.body-sm} inside cards and windows.
- **Label** {typography.label} for small print (the pill and a card's provider count 12/16); **mono-sm** {typography.mono-sm} for prices.

Sentence case everywhere. Two weights only, 400 and 500. No bold display type, no italics, no all-caps labels.

## Layout

The page is a stack of white **rails** on a dotted margin, like sheets laid on a cutting mat.

- **The margin** is {colors.page} with a 2px round dot every 8px (`radial-gradient(circle at 4px 4px, dot .85px, transparent 1.25px)` on an 8px tile, one dot on the page's center line).
- **The rail** is {spacing.rail-max} wide at most, the gutter `clamp(16px, 6.4vw, 96px)` each side ({spacing.gutter} at 1504), its width rounded down to a multiple of 16 so its edges land on dots. Inside, content keeps `clamp(20px, 9.64vw, 145px)` from the rail's edge ({spacing.rail-pad} at 1504).
- **Each section is its own stretch of rail**, stacked edge to edge with no gap and no radius. Each draws a dotted outline on its left, top and right edges (so a dotted line runs across the top of every section): 2px round dots every 8px, the first on the corner, in {colors.dot}. Dotted, never dashed. They mark the rail, never the content inside it.
- **Every section is a multiple of 8px tall**, so each top lands on the matrix.
- The hero fills the first screen with a 16px margin all round (at least 600px tall). Under it, a band of four live figures in equal columns, 48px above and 40px below, two columns on a phone.

Section rhythm: {spacing.section} top and bottom (72 on a phone); title block gap {spacing.head-gap} (20 in a section whose head is wider); {spacing.head-to-content} from the head to its content. Button rows keep {spacing.actions-gap} between buttons.

Section types, all on the same rail:

- **Split intro:** a 320px eyebrow column beside a lede up to 702px.
- **Head and content:** eyebrow, headline, subtitle at the left, then the content full width.
- **Duo:** half text, half painting panel, 624px tall at least. The text half has {spacing.duo-pad} padding and {spacing.duo-gap} between head, features and buttons; features are 16/24 rows of {spacing.feature-row} with a 24px icon 12px from its line. Alternate sides from one section to the next.
- **Lanes:** the head, then the media tabs 56px below, then two rows of price cards 32px below the tabs, running edge to edge of the screen over the margins, {spacing.lane-gap} apart on a band of the rail's white with 12px above and below; the section's link 56px under the band.
- **Paths:** two cards side by side, 24px apart, 64px under the head and only 24px in from the rail's edges. Each card, with no fill of its own: a 3:2 painting panel cropped toward its foot (`background-position: 50% 85%`) with a faint 1px inner ring (ink .06; white .08 at night), 16px, its title in headline-sm, 12px, one paragraph in body 16/24 {colors.body}, 12px, its buttons. The two cards share their rows, so titles, text and buttons line up. One column below 760px, 56px apart.
- **Band:** the privacy section, dark from margin to margin, with fine dots round its edges only.
- **Points:** three columns separated by dotted lines, 40/32/48 padding.
- **FAQ:** one column of questions, each separated by a dotted line.

**Formats.** A social image or a slide is one section drawn on a smaller board and scaled up whole, type, radii and dots together: an X post of 1600 × 900 is a 1024 × 576 board at 1.5625×, 1200 × 675 a 768 × 432 board at 1.5625×, a link preview of 1200 × 630 a 960 × 504 board at 1.25×. The board keeps a 16px dotted margin round its rail; the logo sits on the rail's paper.

Breakpoints: {spacing.bp-phone} (phone: one column, smaller type, 72px sections), 899px (duo stacks its panel), {spacing.bp-tablet} (the nav's links hide), {spacing.bp-stack} (the network's step cards stack in a column). Below 520px the nav keeps only its main button.

## Elevation & Depth

The page is flat: paper, rails and dots, no shadows on the page itself. Depth exists only where something floats over a painting, and it is made of glass.

- **Day glass:** {colors.glass}, a 0.5px white edge, `blur(10px)`, shadow `0 14px 40px rgba(20, 51, 89, .14)`. Over the Gateway painting the windows are thinner (white .52, `blur(18px) saturate(1.3)`) on a plate of white .2 with a 0.5px ink line.
- **Night glass, smoked green:** {colors.glass-smoked}, a 0.5px edge in rgba(150, 200, 145, .42), `blur(10px) saturate(1.3)`, shadow `0 12px 32px rgba(8, 26, 14, .26)` and a faint inner top light rgba(190, 228, 170, .16). Text on it #cbd8d0, strong text #ecf3ee.
- **Popover:** white .96, 0.5px ink edge at .08, `blur(6px)`, shadow `0 10px 28px rgba(20, 51, 89, .2)`; at night rgba(16, 38, 26, .94).
- **Step cards on the network board:** white .36 over the painting, a 0.5px white .9 edge, a white .5 top light, `blur(10px) saturate(1.15)`, shadow `0 10px 30px rgba(20, 51, 30, .14)`; at night rgba(14, 33, 23, .3) and `brightness(.82)`.
- **The nav** is white with a 2% shadow 20px down; the install block is warm frosted glass (rgba(255, 253, 219, .33), `blur(7px)`) with a 0.5px #c3c3c3 ring inside a white .75 ring.

Shadows are tinted blue-green or warm brown, never neutral black. Buttons carry their own small relief: a 3.5px soft drop, a pale inner top line, a darker 2px lip at the bottom. Everything else is flat.

## Shapes

Round, soft and nested. Dots are always round; pixel type uses round dots; pills are full.

Radii nest from the outside in, each a step smaller: card {rounded.card}, window in a card {rounded.window}, popover {rounded.popover}, control {rounded.control}, small tile {rounded.tile}, never under {rounded.min}. Where a box shares a corner with its container, its radius is the container's less the inset. Buttons are {rounded.button}; the install block {rounded.field}; the gateway plate and the privacy levels {rounded.plate}; pills and the theme switch {rounded.full}.

No sharp corners anywhere, and no square pixels or dashes.

## Components

- **Nav:** 69px, white (night: the page color), the black lockup at the left, centered links in Geist 500 14/20, then two buttons 8px apart: "Download Desktop" filled green, "Set up gateway" ghost (ink .04 fill, 1px ink .12 ring inside), both 36px, {rounded.button}, Instrument Sans 500 14. A sun–moon slider sits before them: a 52 × 28 track, a 22px round knob that slides 24px in 0.25s.
- **Buttons:** one filled green button per row of actions, 44px, 20px sides, its relief `0 3.5px .5px rgba(46, 74, 14, .1), inset 0 -.5px 0 rgba(200, 230, 170, .63), inset 0 -2px 1px #3b5e17` (at night only the last); then ghosts: {colors.tile} fill (hover rgba(214, 219, 211, .4)), a 1px {colors.tile-line} border, relief `0 1.5px 0 rgba(255, 255, 255, .6), inset 0 -1px 2px rgba(48, 56, 44, .2)` (at night `inset 0 -1px 1px rgba(0, 0, 0, .2)`). A verb and two or three words ("Get Antseed Desktop", "Become a provider"); the second is "Learn more" or a docs name. 48px and 16px type for the hero's own.
- **Pill:** the news item above the H1, 24px, full radius, 12/16, white by day with a white ring, dark glass rgba(24, 29, 27, .78) at night. Neutral: no green, no acid.
- **Section head:** eyebrow, headline in two tones, subtitle, left aligned, 16–20px apart.
- **Install block:** 600px of frosted glass, 12px inside: the segmented tabs (36px), 12px, the command line (48px), 12px, a 12.5/20 foot line with one link.
- **Command line:** the terminal of the system. Geist Mono 13, ink .1 fill, {rounded.window}, the prompt `$` in #789f00, the command cut with an ellipsis, a 36px copy button at the right. At night a light fill rgba(190, 228, 170, .1).
- **Segmented tabs:** a {colors.track} track with a 0.5px ring inside a {colors.ring} ring, 4px padding; a white 28px thumb, {rounded.popover}, slides under the chosen tab in 0.35s.
- **Media tabs:** four equal columns across the rail's full width, out of its inner padding to the dotted edges, labels centered, 48px tall, Instrument Sans 500 16; a {colors.ring} hairline under all ({colors.night-ring} at night), a 2px line slides under the chosen one in the green-text color ({colors.primary} by day, {colors.primary-text-night} at night); inactive {colors.tab-off}, hover a 4% ink fill.
- **Model card:** a 176px square, {rounded.card}, 18px inside, {colors.tile} over the rail's white so it stays opaque over the margins, no border in either theme. The maker's logo (24px, in the text color) top left, the saving top right, always in mono 500 14 green with a true minus ("−98%"); no border. At the bottom the name (Geist 500 15/20), then one line: the price at the left in mono 12.5/16 (its unit in {colors.small}), the provider count at the right (a 12px nodes icon and the number, Geist 12/16, {colors.small}).
- **Painting panel:** a {rounded.card} panel holding a 4:3 watercolor, cover-cropped, its windows centered on it. It waits in {colors.wash} until its painting arrives.
- **Glass window:** a {rounded.window} window on a painting panel, three traffic lights (13px, 8.7px apart) or a title bar, content in body-sm and mono. Light by day, smoked green at night.
- **Step card:** the network's five steps in a row, 40px apart, 20px inside: a square painting ({rounded.popover}), the icon and "N Name" (the number in Geist Pixel green), one 14/20 line, a mono 12px detail at the foot. A 4px line joins each card to the next.
- **Links:** Geist 500 16/24 in the green-text color, an arrow after them (→ inside the site, ↗ out of it); a section's closing link sits at the left under its content.
- **Live figures:** a gray 13px label over a Geist Pixel figure that counts up once when seen.
- **FAQ item:** the question in title-sm, a + that turns into a −, the answer in body; a dotted line between items.
- **Footer:** the wide painted meadow with three ants apart, and four link columns: Product, Network, Resources, Legal.

## Motion & Effects

Motion is ants and arrivals: things walk, queue, rise into place, settle. Nothing bounces for fun, nothing loops for attention. With `prefers-reduced-motion: reduce` every effect below is off: paintings are there from the start, figures don't count, lanes scroll by hand.

- **LED arrival.** A painting grows from its center in an oval; the moving edge breaks into an LED matrix of round dots on the 8px grid (dot radius 0.42 of the pitch), dense near the picture, scattering further out, the painting filling in cell by cell just inside (flat cells, there for an instant: the only squares in the system). The hero plays it once at load (100ms delay, 1500ms, ease-out cubic `1 − (1 − t)³`); every painting panel plays it once as it comes into view (150ms, 1500ms, panels in one view 160ms apart), its windows popping from 0.9 to full size (opacity 0.55s ease-out, scale 0.9s `cubic-bezier(.2, .9, .25, 1.12)`). Use it for an image's first appearance only, never on text or on a loop.
- **Mosaic under the cursor.** Over a painting panel, the picture breaks into the same round dots where the pointer passes, 88px reach, the paper (the rail's color) coming up round them toward the trail's heart; the trail fades with a 0.3s half-life and the painting is whole again. Mouse only, never on touch, never before the panel has arrived, never on text.
- **Dither.** Fine round points, ordered by an R2 sequence (never a Bayer matrix, which draws crosses): at the edges of the hero's clouds, and as the privacy band's fine dot frame, where single acid dots (1.9px radius) walk the grid like ants and gather at a click. A texture of light, never a wallpaper over content and never asked of an image model.
- **Day and night.** The theme switch crossfades the whole page (a view transition); the hero's painting fades to its night in 1.2s ease-in-out; cut-out ants take `brightness(.84) saturate(.83) contrast(1.12)` over 1.2s. Fireflies appear at night only, drawn in code.
- **Reveal on scroll.** Blocks rise 20px and fade in once (opacity 0.6s, transform 0.7s, `cubic-bezier(.2, .7, .2, 1)`), 50ms apart in a batch; big panels rise 24px from 0.98 over 0.8s.
- **Count-up.** Figures start at 70% of their value (never 0) and count in 2200ms with an exponential ease-out, once, when a third of the band is visible.
- **Controls.** Feedback 0.15s (hover fills); sliding thumbs and lines 0.35s `cubic-bezier(.65, 0, .35, 1)`; the theme knob 0.25s `cubic-bezier(.3, .7, .2, 1)`.
- **Lanes.** Price rows slide slowly (about 120s a loop), alternate rows the other way; only the row under the pointer pauses; still while off screen.

## Imagery

**Watercolor landscapes** are suggested, sparse and mostly white paper: transparent washes on cold-pressed paper, few elements, cropped close, the subject low or at the side edges, the quiet center and top left for titles and glass. No ink outline on scenery. The ant's world: wheat, grass and clover, ferns, hedgerows, a pond, a shore, fields at golden hour. Nights are deep blue-green under soft moonlight; warmth comes only from seeds, one window or fireflies. No people, ants, buildings or text inside a background. Recipes and references: watercolour.md.

**The ant** is one character: chubby and round, warm brown watercolor with a thin dark-brown ink line, an enormous round head, huge white eyes with tiny pupils looking two ways, a small flat mouth, ball-tipped antennae, a lime bandana, two thin arms, exactly two legs. Deadpan and a bit lost by default; it carries things and gets amazed. Roles are props on the same body (glasses and a hoodie for a provider), never color codes. At night a cut-out ant takes `filter: brightness(.84) saturate(.83) contrast(1.12)`, in a post as on the site. Anywhere else, an ant is a dot. Rules and poses: mascot.md.

**The logo** is black on light, near-white on dark, nothing else. It sits on paper or frosted glass, never straight on a painting or a dither, with clear space at least the height of its capitals; never redrawn, recolored, given a face or placed at the center of a network.

## Do's and Don'ts

- **Do** name the half a piece serves, friendly or technical, and check the other half is still there.
- **Do** keep one filled green button per row of actions. Everything else is a ghost or a link.
- **Do** write titles as two-part sentences, the second half gray, with a full stop. The H1 alone has none.
- **Do** put every dot on the 8px grid, round, and every section on a multiple of 8.
- **Do** give every image a night of its own.
- **Do** let paintings arrive through the LED matrix, once.
- **Don't** draw anything with a center: no hub, no star diagram, no subject in the middle of a painting.
- **Don't** use acid as a fill, a button or text on white.
- **Don't** add a third weight, italics, all caps or a display serif. Two families of dots and letters are enough.
- **Don't** put shadows on the page or cards inside cards. Depth is glass over a painting, nowhere else.
- **Don't** use square pixels, dashes, gradients, glows, photography, 3D or stock imagery.
- **Don't** darken a day image for its night, or put the logo on a painting.
- **Don't** draw a realistic insect, a second ant design, or an ant with four legs.
- **Don't** invent a figure, a model or a price. Every number comes from AntSeedStats, with the date it was read.
