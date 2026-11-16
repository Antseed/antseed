import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  deliverEvent,
  endEvent,
  parseGaIds,
  segmentEvent,
  segmentRole,
  startEvent,
  unresolvedEvent,
  type DownloadContext,
} from './events';

const ctx: DownloadContext = {
  target: {platform: 'mac', arch: 'arm64'},
  asset: 'AntSeed-VPR-0.2.31-arm64.dmg',
  tag: 'v0.2.31',
  country: 'DE',
  partial: false,
  totalBytes: 200_000_000,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  botCategory: null,
};

describe('download events', () => {
  it('builds a started event with the download context', () => {
    const event = startEvent(ctx);
    expect(event.name).toBe('download_started');
    expect(event.params).toMatchObject({
      platform: 'mac',
      arch: 'arm64',
      release_tag: 'v0.2.31',
      country: 'DE',
      partial: 0,
      total_bytes: 200_000_000,
    });
  });

  it('names the end event by completion and includes transfer stats', () => {
    const completed = endEvent(ctx, {completed: true, durationMs: 30_000});
    expect(completed.name).toBe('download_completed');
    expect(completed.params).toMatchObject({bytes_sent: 200_000_000, duration_ms: 30_000});

    // Aborted transfers delivered an unknown prefix — no bytes_sent claim.
    const aborted = endEvent(ctx, {completed: false, durationMs: 8_000});
    expect(aborted.name).toBe('download_aborted');
    expect(aborted.params['bytes_sent']).toBeUndefined();
    expect(aborted.params['duration_ms']).toBe(8_000);
  });

  it('omits byte counts when the total size is unknown', () => {
    const event = endEvent({...ctx, totalBytes: null}, {completed: true, durationMs: 5});
    expect(event.params['bytes_sent']).toBeUndefined();
    expect(event.params['total_bytes']).toBeUndefined();
  });

  it('marks range responses as partial', () => {
    const event = startEvent({...ctx, partial: true});
    expect(event.params['partial']).toBe(1);
  });

  it('truncates the user agent to the GA4 param limit and tags verified bots', () => {
    const longUa = 'x'.repeat(300);
    const event = startEvent({...ctx, userAgent: longUa, botCategory: 'Search Engine Crawler'});
    expect((event.params['user_agent'] as string).length).toBe(100);
    expect(event.params['bot_category']).toBe('Search Engine Crawler');

    const human = startEvent(ctx);
    expect(human.params['user_agent']).toBe(ctx.userAgent);
    expect(human.params['bot_category']).toBeUndefined();

    const empty = startEvent({...ctx, userAgent: ''});
    expect(empty.params['user_agent']).toBe('unknown');
  });

  it('accepts well-formed GA attribution ids and rejects garbage', () => {
    const good = parseGaIds(new URLSearchParams('cid=1234567890.1699999999&sid=1756223000'));
    expect(good).toEqual({clientId: '1234567890.1699999999', sessionId: '1756223000'});

    expect(parseGaIds(new URLSearchParams(''))).toEqual({clientId: null, sessionId: null});
    expect(parseGaIds(new URLSearchParams('cid=GA1.1.123.456')).clientId).toBeNull();
    expect(parseGaIds(new URLSearchParams('cid=<script>alert(1)</script>')).clientId).toBeNull();
    expect(parseGaIds(new URLSearchParams('sid=abc')).sessionId).toBeNull();
    expect(parseGaIds(new URLSearchParams('cid=123.456&sid=99')).clientId).toBeNull();
  });

  it('builds unresolved events with a reason', () => {
    const event = unresolvedEvent({platform: 'win', arch: 'arm64'}, 'v0.2.31', 'no_matching_asset');
    expect(event.name).toBe('download_unresolved');
    expect(event.params).toMatchObject({platform: 'win', reason: 'no_matching_asset'});
  });

  describe('segmentRole', () => {
    it('treats a full 200 response as the whole download', () => {
      expect(segmentRole(200, null)).toEqual({first: true, final: true});
    });

    it('splits a segmented download into one first and one final segment', () => {
      // IDM-style: 4 concurrent ranges of a 400-byte file.
      expect(segmentRole(206, 'bytes 0-99/400')).toEqual({first: true, final: false});
      expect(segmentRole(206, 'bytes 100-199/400')).toEqual({first: false, final: false});
      expect(segmentRole(206, 'bytes 200-299/400')).toEqual({first: false, final: false});
      expect(segmentRole(206, 'bytes 300-399/400')).toEqual({first: false, final: true});
    });

    it('lets a browser resume end the download it started', () => {
      // First attempt covered the whole file (aborted); the resume takes it to the end.
      expect(segmentRole(206, 'bytes 0-399/400')).toEqual({first: true, final: true});
      expect(segmentRole(206, 'bytes 250-399/400')).toEqual({first: false, final: true});
    });

    it('falls back to first+final when the range cannot be interpreted', () => {
      expect(segmentRole(206, null)).toEqual({first: true, final: true});
      expect(segmentRole(206, 'bytes 0-99/*')).toEqual({first: true, final: true});
      expect(segmentRole(206, 'garbage')).toEqual({first: true, final: true});
    });
  });

  it('names middle-segment events so they are distinguishable in logs', () => {
    expect(segmentEvent({...ctx, partial: true}, {completed: true, durationMs: 10}).name).toBe(
      'download_segment_completed',
    );
    expect(segmentEvent({...ctx, partial: true}, {completed: false, durationMs: 10}).name).toBe(
      'download_segment_aborted',
    );
  });

  describe('deliverEvent', () => {
    const fetchMock = vi.fn(async () => new Response(null, {status: 204}));
    const logMock = vi.fn();
    afterEach(() => {
      fetchMock.mockClear();
      logMock.mockClear();
    });

    async function sentBody(ids?: {clientId: string | null; sessionId: string | null}) {
      vi.stubGlobal('fetch', fetchMock);
      vi.stubGlobal('console', {...console, log: logMock});
      try {
        await deliverEvent(startEvent(ctx), {measurementId: 'G-TEST', apiSecret: 's3cret', ids});
      } finally {
        vi.unstubAllGlobals();
      }
      const call = fetchMock.mock.calls[0] as unknown as [string, {body: string}];
      return {
        url: call[0],
        body: JSON.parse(call[1].body) as {client_id: string; events: {params: Record<string, unknown>}[]},
      };
    }

    it('sends attributed=1 with the visitor ids when the website passed them', async () => {
      const {body} = await sentBody({clientId: '1234567890.1699999999', sessionId: '1756223000'});
      expect(body.client_id).toBe('1234567890.1699999999');
      expect(body.events[0]!.params).toMatchObject({attributed: 1, session_id: 1756223000});
      expect(JSON.parse(logMock.mock.calls[0]![0] as string)).toMatchObject({
        event: 'download_started',
        attributed: 1,
      });
    });

    it('sends attributed=0 under a random client id otherwise', async () => {
      const {body} = await sentBody({clientId: null, sessionId: null});
      expect(body.client_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.events[0]!.params['attributed']).toBe(0);
      expect(body.events[0]!.params['session_id']).toBeUndefined();
    });

    it('does nothing but log when GA is not configured', async () => {
      vi.stubGlobal('fetch', fetchMock);
      vi.stubGlobal('console', {...console, log: logMock});
      try {
        await deliverEvent(startEvent(ctx), {});
      } finally {
        vi.unstubAllGlobals();
      }
      expect(fetchMock).not.toHaveBeenCalled();
      expect(logMock).toHaveBeenCalledTimes(1);
    });
  });
});

