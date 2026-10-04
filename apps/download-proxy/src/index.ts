/**
 * AntSeed download proxy — a Cloudflare Worker on download.antseed.com.
 *
 * Serves the desktop installers from GitHub Releases through our own domain
 * so we can observe what a plain link to GitHub never reveals: whether a
 * download actually started and whether it finished. The worker resolves the
 * latest release server-side, streams the matching asset through a
 * byte-counting pump, and reports download_started / download_completed /
 * download_aborted telemetry (see events.ts).
 *
 * The electron-updater keeps fetching from GitHub directly, so traffic here
 * is purely website-driven fresh downloads — cleanly separated from update
 * traffic on every platform.
 *
 * Routes:
 *   GET /vpr/<platform>-<arch>   stream the latest installer
 *                                (mac|win|linux × arm64|x64)
 *   anything unresolvable        302 to the GitHub releases page, so a stale
 *                                link or partial release still lands somewhere
 *                                useful
 */

import {matchAsset, parseTarget} from './assets';
import {getLatestRelease} from './release';
import {trackedStream} from './stream';
import {
  deliverEvent,
  endEvent,
  parseGaIds,
  segmentEvent,
  segmentRole,
  startEvent,
  unresolvedEvent,
  type DownloadContext,
  type DownloadEvent,
  type GaIds,
} from './events';

export interface Env {
  GITHUB_REPO: string;
  GA4_MEASUREMENT_ID?: string;
  GITHUB_TOKEN?: string;
  GA4_API_SECRET?: string;
}

const PASSTHROUGH_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'etag',
  'last-modified',
  'accept-ranges',
];

function emit(env: Env, ctx: ExecutionContext, event: DownloadEvent, ids?: GaIds): void {
  ctx.waitUntil(
    deliverEvent(event, {
      measurementId: env.GA4_MEASUREMENT_ID,
      apiSecret: env.GA4_API_SECRET,
      ids,
    }),
  );
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const releasesUrl = `https://github.com/${env.GITHUB_REPO}/releases/latest`;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed', {status: 405, headers: {allow: 'GET, HEAD'}});
    }

    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/vpr' || url.pathname === '/vpr/') {
      return Response.redirect(releasesUrl, 302);
    }
    const pathMatch = /^\/vpr\/([^/]+)$/.exec(url.pathname);
    if (!pathMatch) {
      return new Response('not found', {status: 404});
    }
    const target = parseTarget(pathMatch[1]!);
    if (!target) {
      return Response.redirect(releasesUrl, 302);
    }
    // GA attribution ids appended by the website's click handler — joins the
    // proxy's server-side events to the visitor's GA session (see events.ts).
    const gaIds = parseGaIds(url.searchParams);

    const release = await getLatestRelease(env.GITHUB_REPO, env.GITHUB_TOKEN, ctx);
    const asset = release ? matchAsset(release.assets, target) : null;
    if (!asset) {
      emit(
        env,
        ctx,
        unresolvedEvent(target, release?.tag ?? null, release ? 'no_matching_asset' : 'release_lookup_failed'),
        gaIds,
      );
      return Response.redirect(releasesUrl, 302);
    }

    const range = request.headers.get('range');
    const origin = await fetch(asset.url, {
      method: request.method,
      headers: range ? {range} : {},
      redirect: 'follow',
    });
    if (origin.status !== 200 && origin.status !== 206) {
      emit(env, ctx, unresolvedEvent(target, release?.tag ?? null, `origin_status_${origin.status}`), gaIds);
      return Response.redirect(releasesUrl, 302);
    }

    const headers = new Headers();
    for (const name of PASSTHROUGH_HEADERS) {
      const value = origin.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set(
      'content-disposition',
      origin.headers.get('content-disposition') ?? `attachment; filename="${asset.name}"`,
    );
    // The installer bytes are versioned by release, but this URL always means
    // "latest" — don't let an intermediary pin an old installer to it.
    headers.set('cache-control', 'no-store');

    if (request.method === 'HEAD' || !origin.body) {
      return new Response(null, {status: origin.status, headers});
    }

    const rawLength = Number(origin.headers.get('content-length'));
    const contentLength = Number.isFinite(rawLength) && rawLength > 0 ? rawLength : null;
    const downloadCtx: DownloadContext = {
      target,
      asset: asset.name,
      tag: release?.tag ?? null,
      country: (request.cf?.country as string | undefined) ?? 'unknown',
      partial: origin.status === 206,
      totalBytes: contentLength ?? asset.size,
      userAgent: request.headers.get('user-agent') ?? '',
      botCategory: (request.cf?.verifiedBotCategory as string | undefined) || null,
    };

    // One download can arrive as many Range requests (download managers,
    // resumes). Only the segment covering byte 0 starts it and only the one
    // delivering the last byte ends it; middle segments are logged, not
    // reported, so GA counts downloads rather than requests.
    const role = segmentRole(origin.status, origin.headers.get('content-range'));
    if (role.first) {
      emit(env, ctx, startEvent(downloadCtx), gaIds);
    }
    const {readable, done} = trackedStream(origin.body, contentLength);
    ctx.waitUntil(
      done.then(result => {
        if (!role.final) {
          const segment = segmentEvent(downloadCtx, result);
          console.log(JSON.stringify({event: segment.name, ...segment.params, attributed: gaIds.clientId ? 1 : 0}));
          return;
        }
        return deliverEvent(endEvent(downloadCtx, result), {
          measurementId: env.GA4_MEASUREMENT_ID,
          apiSecret: env.GA4_API_SECRET,
          ids: gaIds,
        });
      }),
    );
    return new Response(readable, {status: origin.status, headers});
  },
} satisfies ExportedHandler<Env>;
