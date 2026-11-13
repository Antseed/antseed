# @antseed/website

antseed.com: marketing pages, the docs (`/docs`), the blog, the integration guides (`/integrations`) and the files agents and installers fetch (`/skill.md`, `/llms.txt`, `/install.sh`). Docusaurus 3 with React 19, built to static files. Private, never on npm. Every fact about Antseed here follows the root `AGENTS.md` (Product and docs). `README.md` describes an old Vite site; ignore it.

## Inside

- `docusaurus.config.ts` — site config, client redirects, navbar, announcement bar. `sidebars.ts` — the one docs sidebar.
- `docs/<section>/*.md` — the docs; `blog/` — posts (`authors.yml`, images in `static/img/blog/<slug>/`); `src/pages/` — marketing pages.
- `src/integrations/integrations.ts` — the integration catalog. `plugins/integrations-pages.ts` turns it into routes and `llms-connect.txt`, and copies `skills/join-buyer/SKILL.md` to `static/skill.md`.
- `static/` — served as is, including `install.sh`, `install-gateway.sh`, `llms.txt`, `_headers` and `_redirects`.
- Where to add: a doc page is a file in its section with `id`, `slug`, `title`, `description` frontmatter, plus a `sidebars.ts` entry. An integration guide is an entry in `integrations.ts`. A moved doc URL is a `redirects` entry in `docusaurus.config.ts`, and a `_redirects` line when agents or curl fetch it.

| Rule | Enforced by |
| --- | --- |
| Every link resolves. A broken internal link fails the build. | `onBrokenLinks: 'throw'` in `docusaurus.config.ts` (build only) |
| Every doc sets a `slug`, and a published slug never changes without a redirect. The CLI, the desktop, the gateway console and `skills/*/SKILL.md` link to these URLs. | review only |
| `static/skill.md` and `static/llms-connect.txt` are generated and git-ignored. Edit `skills/join-buyer/SKILL.md` and `src/integrations/integrations.ts`. | `.gitignore` |
| `docs/reference/contracts.md` lists every address in `packages/contracts/deployments/base-mainnet/history/001-recognized-usage-deployed.json`. | `scripts/deploy-contracts.test.mjs`, which CI does not run |
| `static/install-gateway.sh` passes `bash -n` and shellcheck. | `.github/workflows/ci.yml` `installer-lint` |
| A hidden state that loses to a shown state is structurally weaker (`.reveal:not(.revealShown)`), never an equal-specificity rule placed earlier. | review only (`src/components/ui/ui.module.css` comment) |
| The FAQ keeps each answer twice in `docs/reference/faq.mdx`: in the `faqLd` structured data and under its `###` heading. Change both. | review only |
| Every blog post has a `<!-- truncate -->` marker. | review only |

## Connections

- No `@antseed/*` dependencies; at build time it reads `skills/join-buyer/SKILL.md` and `apps/desktop/package.json` (version in JSON-LD).
- Docs and code move together: `docs/reference/commands.md` and `flags.md` mirror the CLI, `docs/gateway/*` the console, `docs/protocol/*` the node. A user-facing change updates its page in the same PR.
- `install.sh` downloads `install-gateway.sh` from the live site, so an older `install.sh` keeps calling the new one.
- `src/lib/useLatestDesktopDownload.ts` builds download.antseed.com URLs; a change to desktop asset names touches `apps/download-proxy` and this file.

## Traps

- The folder does not set the URL (`docs/connect/api.md` is `/docs/api/`). Read the `slug` before you link.
- Only the build checks broken links, and client redirects and GTM do nothing on the dev server. Build before you push a docs change.
- Client redirects are meta-refresh pages: curl and agents do not follow them. A URL agents fetch gets a real 301 in `static/_redirects` too.
- `trailingSlash: true` matches the host, which redirects `/path` to `/path/`. Link to the slash form.
- The production CSS minifier reorders equal-specificity rules across chunks; the dev server keeps source order. Check order-sensitive CSS with `build` and `preview`.
- React 19 types have no global `JSX`; import it.
- `showLastUpdateTime` takes the date from git. A page whose date must not move pins `last_update` in frontmatter.
- `static/mika/*` is unlisted and `noindex`; do not link it. `package-lock.json` is stale; install with pnpm from the root.

**Ask first:** changing or removing a published doc `slug`, a redirect or a page agents fetch (`/skill.md`, `/llms.txt`, `/llms-connect.txt`, `/install.sh`, `/install-gateway.sh`); TEE, privacy or positioning copy; the announcement bar, navbar or analytics (GTM, site verification tags).

**Prove it:** `pnpm --filter @antseed/website typecheck` and `pnpm --filter @antseed/website build` (broken links fail it). For CSS or layout, open the built site with `preview` at desktop and phone width. After an installer change, `bash -n` and `shellcheck` on it. After a contracts table change, `node --test scripts/deploy-contracts.test.mjs`.
