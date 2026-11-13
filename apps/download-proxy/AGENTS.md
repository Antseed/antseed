# @antseed/download-proxy

A Cloudflare Worker on download.antseed.com that serves the desktop installers from the latest GitHub release under stable URLs (`/vpr/<platform>-<arch>`) and reports each download as started, completed or aborted (Workers Logs, and GA4 when configured). The website's download buttons link here; the desktop's auto-updater keeps fetching from GitHub. Private, never published, deployed by hand with wrangler. `README.md` explains the telemetry model and the secrets.

## Inside

- `wrangler.toml` — Worker, route and public vars.
- `src/index.ts` — the fetch handler. `src/assets.ts` — which release asset a target gets. `src/release.ts` — the cached latest-release lookup.
- `src/stream.ts` — completion and abort detection on the native pipe. `src/events.ts` — event building and GA4 delivery.

| Rule | Enforced by |
| --- | --- |
| Mac downloads are the `.dmg` only. The updater's `-mac.zip` stays on GitHub, which is what separates fresh installs from update traffic. | `src/assets.test.ts` |
| One download is one started and one completed or aborted event, however many range requests it takes. Middle segments only log. | `src/events.test.ts` |
| GA ids (`cid`, `sid`) from the website are accepted only in their digits-and-dot shapes; otherwise the event goes under a random client id with `attributed=0`. | `src/events.test.ts` |
| Without `GA4_MEASUREMENT_ID` or `GA4_API_SECRET`, events are logged and nothing is sent. | `src/events.test.ts` |
| A missing asset, a failed lookup or a bad origin status never errors: it redirects to the releases page. | review only (`src/index.ts`) |

## Connections

- `apps/website/src/lib/useLatestDesktopDownload.ts` builds the links and `withGaAttribution` (`src/lib/analytics.ts`) appends `cid`/`sid`. A route or parameter change lands on both sides.
- Asset names come from `apps/desktop/electron-builder.yml` and `electron-builder.linux.cjs`. A naming change (arch out of the file name, a universal build, a new extension) changes what `matchAsset` picks.
- "Latest" is GitHub's latest release: drafts and prereleases are not served, so an alpha never reaches the website buttons. CI runs the tests; nothing in CI deploys it.

## Traps

- Per-chunk byte counting is not possible on the native pipe: `download_completed` means `FixedLengthStream` delivered `total_bytes`; `download_aborted` carries only the duration.
- A platform-arch pair with no published asset (a Windows arm64 build that does not exist) is a 302 to the releases page and a `download_unresolved` event, not a 404.
- Without `GITHUB_TOKEN`, release lookups share GitHub's unauthenticated per-IP limit across the Cloudflare PoP.
- The custom domain needs the `antseed.com` zone on the same Cloudflare account. Remove the `[[routes]]` block to try a deploy on workers.dev. `dev` and `deploy` need Cloudflare credentials; tests and typecheck do not.

**Ask first:** `wrangler deploy` or any secret change (it is production); the URL scheme or redirect target; what an event contains or where it is sent.

**Prove it:** `pnpm --filter @antseed/download-proxy test` and `pnpm --filter @antseed/download-proxy typecheck`.
