# static/site: the marketing pages

These are the six marketing pages: `/`, `/network/`, `/providers/`, `/ants/`, `/colony/` and `/ecosystem/`. Each is hand-built HTML, CSS and JS, not React. AstraOS designed and built them.

This guide covers this folder. For the rest of the website (docs, React pages, plugins), see `apps/website/AGENTS.md`.

## How the pages are served

- `plugins/static-pages.ts`:
  - Its `PAGES` map pairs each route with a folder here: `/` with `hero/`, `/network/` with `network/`, `/providers/` with `providers/`, `/ants/` with `ants/`, `/colony/` with `colony/`, and `/ecosystem/` with `ecosystem/`.
  - At load, it registers each route with the `src/components/StaticPage` stub. That gives the broken-link check and the sitemap their routes.
  - After the build, it writes `static/site/<folder>/index.html` over the stub's built HTML. It then deletes the build's copy under `/site/<folder>/`, so each page is served only once, at its route.
- The stub renders an empty `<Layout>`. If a visitor reaches one of these routes by a client-side navigation from a React page, the stub reloads the URL, so the host serves the static page.
- **Head tags:** the plugin carries the site's own head tags from the stub into each page. These are GTM (script and noscript), both `google-site-verification` tags, the Open Graph and Twitter tags, canonical, alternates and JSON-LD. Tags the page sets itself, such as its title, description and `og:title`, take precedence. Don't add GTM or verification tags to a page by hand.
- **Paths:**
  - Every path in these files is absolute: `/site/...` for files, and the route itself for pages (`/network/`, `/#gateway`).
  - The pages are served at their routes, not beside their files, so a relative path breaks once built.
  - A script's own `new URL('x', import.meta.url)` is the one exception: it resolves from the script's location, so it works.

## File map

**`hero/`** holds the homepage, plus the files every page shares. The name is historical: read it as "home and shared".

The homepage's own files:
- `index.html`: the homepage, with the hero painting, the mascot, the install panel and the band of figures. Its big inline module draws the hero.
- `sections.html`: everything below the hero, fetched into `#sections` at load (see the module at the end of `index.html`). The homepage's footer is in it.
- `models.json`: the price list's models and the network figures. It's a snapshot of AntSeedStats. To refresh it: `node apps/website/scripts/site-models-refresh.mjs`.
- `launch.css`, `micro.css`, `privacy-v4.css`, `providers-v4.css`, `gw-film.css`: homepage sections. Some other pages load `launch.css`, `micro.css` and `providers-v4.css` too.
- `sections.js` (what moves below the hero), `micro.js` (small card animations), `dither.js`, `unveil.js` (the hero painting's arrival), `card-unveil.js` (each painting's arrival), `wash-led.js` (the LED mosaic under the cursor), `fireflies.js` and `night-loop.js` (night motion), `footer-eyes.js` (the footer ants' eyes), `gw-film.js` (the Gateway film), `providers-live.js` (the Providers cards' films), `count.js` (figures counting up).

The shared files, loaded by every page:
- `theme.js`: day and night, loaded first in the head (see "Day and night").
- `shell.css`: base, type, colours.
- `site-nav.css`, `site-nav.js`: the nav and its Providers menu. Below 1080 px it becomes the phone menu, whose links `site-nav.js` builds itself.
- `nav.js`: the nav's day/night button.
- `v6.css`: the glass windows and cards.
- `sections.css`: sections, titles, buttons, panels.
- `footer.css`: the footer.
- `parts.js` and `parts/`: fragments, filled into slots (see "Parts").

The other five pages each have their own folder: `network/`, `providers/`, `ants/`, `colony/`, `ecosystem/`. Each holds:
- `index.html`: the whole page, with its own copy of the nav and the footer;
- `<page>.css`: its own styles, loaded after the shared sheets;
- for some pages, `<page>.js`: `providers.js`, `ants.js`, `colony.js`;
- `colony/config.json`: the Colony links;
- `ecosystem/shots/`: the project screenshots.

**`assets/`** holds only files a page loads:
- `home/`: homepage paintings and films, icons (`icons/pixel/` for features; `icons/labs/` and `icons/labs-color/` for model makers' marks), the footer meadow, the ant sprites;
- `hero/`: the hero painting, its films, the mascot rig;
- `network/`, `providers/`, `ants/`, `colony/`, `ecosystem/`: each page's paintings;
- `fonts/`: Geist Pixel (Geist, Geist Mono and Instrument Sans come from Google Fonts);
- `hero-panel.js`: the hero's settings panel (see "Known state").

## Parts

A slot is a `<div class="lp-slot" data-part="name">`. `parts.js` fills it with `parts/name.html` and links `parts/name.css` once. If the fragment's root has `data-js`, it also runs `parts/name.js`.

Only the parts listed on `<body data-parts="a,b">` load. Today that's only `cta-band`, the call-to-action band above the footer. `?parts=name` loads another part, to try it in place.

## Duplicated markup: the nav and the footer

Each page carries its own copy of both. To change one, edit every copy.

- **Nav:** the `<nav>` in each of the six `index.html` files (`hero/`, `network/`, `providers/`, `ants/`, `colony/`, `ecosystem/`), and the phone menu's links in `hero/site-nav.js` (`menu.innerHTML`).
- **Footer:**
  - the homepage's is in `hero/sections.html`, not in `hero/index.html`;
  - the other five are the `<footer>` in `network/`, `providers/`, `ants/`, `colony/` and `ecosystem/` `index.html`.

After an edit, search for the old text across `static/site/`. No copy should keep it.

## Day and night

- `theme.js` runs in the head before anything paints.
  - It sets `<html data-theme="light|dark">` from the saved choice (`localStorage` `antseed.theme`: system, light or dark), else from `prefers-color-scheme`.
  - The nav button and the footer switch call `antseedTheme.set()`, which crossfades the page and fires a `themechange` event that the paintings follow.
- Dark styles are written as `:root[data-theme="dark"] ...`.
- **Paintings:**
  - A painted panel is a `.wash` element. Its day picture is the CSS variable `--wash` and its night picture `--wash-d`, set inline: `style="--wash: url(/site/assets/home/vignettes/gw-day.webp); --wash-d: url(/site/assets/home/vignettes/gw-night.webp)"`.
  - `theme.js` makes paintings load as the visitor nears them.
  - A painting in an `<img>` comes as a pair, `<img class="day">` and `<img class="night">`. CSS shows the right one.
- **Films** come per theme: the `-day` and `-night` files. Each ships as `.webm`, with `.mp4` (or `-hevc.mov`) for Safari, and its first frame as a `.webp` poster.

## Common tasks

- **Change copy:** edit the text in the page's `index.html`. For the homepage below the hero, edit `hero/sections.html`. Section titles have two halves; see "Design rules".
- **Change a link:**
  - Edit the `href` in the page.
  - If it's in the nav or the footer, edit every copy (see "Duplicated markup").
  - Internal links are routes (`/network/`), never `../network/`.
- **Swap a painting:**
  1. Make both a day and a night file, in WebP, at the size of the one you replace. Check the current file's pixel size, and keep the same aspect ratio.
  2. Put them in that page's `assets/` folder.
  3. Point `--wash` and `--wash-d`, or the `day`/`night` `<img>` pair, at them.
  4. If the panel has a film, replace its `.webm`, `.mp4` and poster too, and make sure the poster is the film's first frame.
- **Add a section:**
  - Copy an existing `<section class="s-sec ...">` from the same page, or from `hero/sections.html`, and change its content.
  - Keep the shared classes (`s-sec`, `s-rail`, `s-h2`, `s-sub`, `s-btn`, `wash`), so spacing, type and motion come with it.
  - Put new styles in the page's own CSS.
- **Remove a section:** delete its `<section>`. Then search its id across `static/site/` (nav anchors like `/#prices`, footer links, `sections.js` hooks) and fix or remove what pointed to it.
- **Add a page:**
  1. Copy a page folder (for example `ants/`) to `static/site/<name>/`, then rename its CSS and JS and its `<link>`/`import` lines.
  2. Keep the head: `theme.js` first, then the shared sheets. Set the title, description and `og:` tags.
  3. Add `'/<name>/': '<name>'` to `PAGES` in `plugins/static-pages.ts`.
  4. If the old site had a React page at that route, remove it from `src/pages/`, since two pages can't share a route.
  5. Add the link to every nav copy and the phone menu, or to every footer copy (see "Duplicated markup").
  6. Put its paintings under `assets/<name>/`.

## Design rules to keep

- **The homepage is the reference.** Match its spacing, type, buttons, cards and glass windows. Don't invent new ones.
- **Titles are two lines:** the first half is in ink, the second in grey. That's `<h2 class="s-h2">Privacy <span>and trust.</span></h2>`: the `<span>` is the grey line.
- **Shared components:**
  - buttons are `.s-btn`, with `.s-btn.ghost` for the second button;
  - glass windows and cards come from `v6.css`;
  - paintings are `.wash` panels.
- **Icons:**
  - Features use the pixel icons in `assets/home/icons/pixel/`.
  - UI controls (theme switch, menu, chevrons) use line icons.
- **Ants:**
  - Every ant drawn has slightly lost, wall-eyed pupils, looking a little apart. Keep that on any new or edited ant.
  - Watercolour paintings come from AstraOS's painting process. Don't generate replacements in another style.

## Known state

- **Desktop is done. Mobile isn't designed yet.**
  - Below desktop widths, some sections keep their first layout, and `/ecosystem/` overflows sideways on a phone.
  - CSS comments that say "desktop only" mark rules that wait for the mobile pass.
- **The network diagram is a "Work in progress" placeholder,** on the homepage (`#network` in `hero/sections.html`) and on `/network/` (the three layers).
  - Each shows the network's painting with a glass label (`.lp-wip`, in `hero/launch.css`).
  - The old board stays in the page, inside an inert `<template>`.
  - The files for the old diagram and the map are present but unplugged, so nothing loads them:
    - `hero/net.js`, `hero/net-steps.js`;
    - `hero/net-layers.css`, `hero/net-layers.js`;
    - `hero/parts/layers.*`, `hero/parts/layers-large.*`;
    - `hero/parts/net-layers-home.html`, `hero/parts/net-layers-network.html`;
    - `hero/parts/net-map.*`.
  - To plug a board back in:
    1. Take it out of its `<template>`.
    2. Remove the `.lp-wip` panel.
    3. Add its part to `<body data-parts>`.
- **The hero's settings panel:**
  - Pressing P on the homepage, or adding `?panel` to its URL, opens a tuning panel. It changes the hero's mosaic, ants, seeds, cursor and mascot, and it loads Tweakpane from cdn.jsdelivr.net.
  - It's a design tool, and it's harmless for visitors: settings it saves stay in that browser.
  - It's safe to delete:
    1. Remove the `heroPanel(...)` call and its `try` block at the end of the homepage's inline module (`hero/index.html`).
    2. Then remove `assets/hero-panel.js`, but only after moving `settings`, `paperOf` and `store`, which the module imports from it, into the module.
- **Lab URL switches:** these let a designer compare looks, and visitors never see them.
  - `?mascot`, `?whimsical`, `?square` and `?meadow` swap the homepage hero for older looks. The default is Whimsical 2.
  - `?night=a` and `?night=c` show other nights.
  - `?still` and `?demo` freeze motion for captures.
  - Their code paths are in `hero/index.html` and `hero/night-loop.js`.

### Unused, safe to delete

- The unplugged network files listed above, once the new board is in.
- In `hero/index.html`'s hero module: the variants other than Whimsical 2 (`mascot`, `whimsical`, `square`, `meadow`) and their branches. This is a careful edit, because the variants share code with Whimsical 2. Check the hero at 1440 in both themes afterwards.
- In `hero/sections.js`: the `.mz` mosaic (point 1 of its header). No panel uses it now.
- The settings panel, as described above.

## Checks before a PR

Run from the repository root:

```bash
pnpm --filter @antseed/website typecheck
```

```bash
pnpm --filter @antseed/website build
```

- The build fails on a broken internal link, so a page or anchor that moved shows up here.
- Then open the built site and look at the six routes at 1440 px wide, in light and in dark:

```bash
pnpm --filter @antseed/website preview
```

- Check that there are no console errors, no failed requests (a 404 on a `/site/` file means a relative or wrong path), and no horizontal scroll.
- Check that films play, and that day and night swap every painting.

Comments in these files describe intent and measurements. Where a comment mentions Figma, it refers to the design file AstraOS keeps. The values in the CSS are the truth.
