/**
 * Latest-release lookup against the GitHub API, cached at the edge for a few
 * minutes so a burst of downloads costs one API request. Unauthenticated
 * requests share GitHub's per-IP rate limit across the Cloudflare PoP, so
 * production should set the optional GITHUB_TOKEN secret.
 */

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number | null;
}

export interface ReleaseInfo {
  tag: string | null;
  assets: ReleaseAsset[];
}

interface GithubReleaseResponse {
  tag_name?: string;
  assets?: {name?: string; browser_download_url?: string; size?: number}[];
}

const RELEASE_CACHE_TTL_SECONDS = 300;

export async function fetchLatestRelease(repo: string, token?: string): Promise<ReleaseInfo | null> {
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'antseed-download-proxy',
        ...(token ? {authorization: `Bearer ${token}`} : {}),
      },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as GithubReleaseResponse;
    const assets: ReleaseAsset[] = [];
    for (const asset of body.assets ?? []) {
      if (typeof asset.name !== 'string' || typeof asset.browser_download_url !== 'string') continue;
      assets.push({
        name: asset.name,
        url: asset.browser_download_url,
        size: typeof asset.size === 'number' ? asset.size : null,
      });
    }
    return {tag: body.tag_name ?? null, assets};
  } catch {
    return null;
  }
}

/** Cached wrapper around {@link fetchLatestRelease} using the edge cache. */
export async function getLatestRelease(
  repo: string,
  token: string | undefined,
  ctx: ExecutionContext,
): Promise<ReleaseInfo | null> {
  // Synthetic key: the cache API needs a URL, not necessarily a reachable one.
  const cacheKey = new Request(`https://antseed-download-proxy.internal/latest-release/${repo}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) {
    return (await hit.json()) as ReleaseInfo;
  }
  const info = await fetchLatestRelease(repo, token);
  if (info) {
    ctx.waitUntil(
      cache.put(
        cacheKey,
        new Response(JSON.stringify(info), {
          headers: {
            'content-type': 'application/json',
            'cache-control': `max-age=${RELEASE_CACHE_TTL_SECONDS}`,
          },
        }),
      ),
    );
  }
  return info;
}
