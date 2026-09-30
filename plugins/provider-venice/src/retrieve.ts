import { nativeVideoRoute, parseJsonObject, requestService } from '@antseed/api-adapter';
import { VIDEO_DOWNLOAD_STREAM_HEADER, VIDEO_DOWNLOAD_STREAM_VERSION, type Provider, type SerializedHttpRequest, type SerializedHttpResponse } from '@antseed/node';
import { streamVideoResponse, videoDownloadError, videoDownloadSignal } from '@antseed/provider-core';

const MAX_STATUS_BYTES = 1024 * 1024;
const MAX_ACTIVE_DOWNLOADS = 2;

/**
 * The seller rebuilds retrieve bodies from the owned job and the routed
 * service, so a buyer cannot point `model` or other fields elsewhere.
 */
function retrieveBody(service: string, queueId: string, deleteMedia?: unknown): Uint8Array {
  return Buffer.from(JSON.stringify({ model: service, queue_id: queueId, ...(typeof deleteMedia === 'boolean' ? { delete_media_on_completion: deleteMedia } : {}) }));
}

/**
 * Venice `/video/retrieve` answers with JSON while a job runs (and for private
 * models, which deliver through `download_url`), or with the finished MP4
 * itself. MP4 answers are streamed to the buyer; JSON answers are returned as is.
 */
export function withVeniceRetrieve(provider: Provider, baseUrl: string, apiKey: string): Provider {
  let activeDownloads = 0;
  const retrieveUrl = `${baseUrl.replace(/\/+$/, '')}/api/v1/video/retrieve`;
  const followUp = (request: SerializedHttpRequest) => {
    const route = nativeVideoRoute(request);
    const service = requestService(request);
    return { route, service: service && provider.services.includes(service) ? service : undefined };
  };
  const handleRequest = async (request: SerializedHttpRequest): Promise<SerializedHttpResponse> => {
    if (nativeVideoRoute(request)?.action === 'download') return videoDownloadError(request, 400, 'unsupported_video_download', 'A streaming video download is required');
    return provider.handleRequest(request);
  };
  return {
    ...provider,
    handleRequest,
    async handleRequestStream(request, callbacks): Promise<SerializedHttpResponse> {
      const { route, service } = followUp(request);
      if (route?.action !== 'download') return handleRequest(request);
      const error = (statusCode: number, code: string, message: string) => videoDownloadError(request, statusCode, code, message);
      if (!service || !route.resourceId) return error(400, 'unsupported_video_request', 'Unsupported video service or queue_id');
      if (request.headers[VIDEO_DOWNLOAD_STREAM_HEADER] !== VIDEO_DOWNLOAD_STREAM_VERSION || !callbacks.signal) return error(400, 'unsupported_video_download', 'A streaming video download is required');
      const download = videoDownloadSignal(callbacks.signal);
      let streaming = false;
      try {
        const upstream = await fetch(retrieveUrl, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'accept-encoding': 'identity' },
          body: retrieveBody(service, route.resourceId, parseJsonObject(request.body)?.delete_media_on_completion),
          redirect: 'error', signal: download.signal,
        });
        const contentType = upstream.headers.get('content-type')?.split(';')[0]?.trim();
        if (upstream.status === 200 && contentType === 'video/mp4') {
          if (activeDownloads >= MAX_ACTIVE_DOWNLOADS) {
            await upstream.body?.cancel();
            return error(429, 'video_download_busy', 'Too many concurrent video downloads');
          }
          activeDownloads += 1;
          streaming = true;
          try { return await streamVideoResponse(request, upstream, callbacks, download); }
          finally { activeDownloads -= 1; }
        }
        const text = await upstream.text();
        if (text.length > MAX_STATUS_BYTES || contentType !== 'application/json') return error(502, 'video_status_unavailable', 'Video status is unavailable');
        return { requestId: request.requestId, statusCode: upstream.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: Buffer.from(text) };
      } catch (cause) {
        if (streaming) throw cause;
        return error(download.signal.aborted ? 504 : 502, 'video_download_failed', 'Could not retrieve video from Venice');
      } finally {
        download.done();
      }
    },
  };
}
