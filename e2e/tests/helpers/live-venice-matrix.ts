import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import type { AntseedNode, PeerInfo, Provider } from '@antseed/node';
import venicePlugin from '../../../plugins/provider-venice/src/index.js';

type VideoCase = { model: string; prompt: string; duration: string; resolution?: string; aspect_ratio?: string; audio?: boolean };
type Network = { port: number; discoveredSeller: PeerInfo; buyer: AntseedNode };

export async function runLiveVeniceMatrix(apiKey: string, setup: (provider: Provider) => Promise<Network>): Promise<void> {
  const matrixPath = process.env['ANTSEED_LIVE_VENICE_MATRIX'];
  const outputDir = process.env['ANTSEED_LIVE_VENICE_OUTPUT'];
  const budget = Number(process.env['ANTSEED_LIVE_VENICE_BUDGET_USD']);
  const resumePath = process.env['ANTSEED_LIVE_VENICE_RESUME_REPORT'];
  const previous = resumePath ? JSON.parse(await readFile(resumePath, 'utf8')) : undefined;
  if (previous && !process.env['ANTSEED_LIVE_VENICE_RESUME_STATE']) throw new Error('Resume requires saved buyer and seller state');
  if (!matrixPath || !outputDir || !Number.isFinite(budget) || budget <= 0) throw new Error('An explicit matrix, output directory and positive USD budget are required');
  const cases: VideoCase[] = JSON.parse(await readFile(matrixPath, 'utf8'));
  if (!Array.isArray(cases) || !cases.length || cases.length > 20) throw new Error('Choose between 1 and 20 test cases');
  if (cases.some(body => !body.model || !body.prompt || !/^[1-9][0-9]*s$/.test(body.duration))) throw new Error('Live cases require a model, prompt and explicit duration in seconds');
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const report: Record<string, any> = { startedAt: new Date().toISOString(), chain: 'mocked', upstream: 'live Venice', mode: previous ? 'resume existing jobs; no new generations' : 'create', budgetUsd: budget, quotedUsd: 0, cases: [] };
  const save = () => writeFile(join(outputDir, 'report.json'), JSON.stringify(report, null, 2).replaceAll(apiKey, '[redacted]'), { mode: 0o600 });
  const post = (url: string, body: object, headers: Record<string, string> = {}) => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
  });
  const vendor = (path: string, body: object) => post(`https://api.venice.ai/api/v1/video/${path}`, body, { authorization: `Bearer ${apiKey}` });
  try {
    for (const body of cases) {
      const quoted = await vendor('quote', body);
      const answer = await quoted.json();
      if (quoted.status !== 200 || typeof answer.quote !== 'number' || !Number.isFinite(answer.quote) || answer.quote < 0) throw new Error(`Quote failed for ${body.model}`);
      report.quotedUsd += answer.quote;
      report.cases.push({ request: body, quotedUsd: answer.quote });
    }
    report.quotedUsd = Math.round(report.quotedUsd * 100) / 100;
    await save();
    if (report.quotedUsd > budget) throw new Error(`Quoted $${report.quotedUsd} exceeds $${budget} budget; no generations submitted`);
    const models = [...new Set(cases.map(body => body.model))];
    const provider = await venicePlugin.createProvider({
      VENICE_API_KEY: apiKey,
      ANTSEED_ALLOWED_SERVICES: models.join(','),
      ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: JSON.stringify(Object.fromEntries(models.map(model => [model, {
        'venice-video': { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.01 }] },
      }]))),
    });
    const { port, discoveredSeller, buyer } = await setup(provider);
    const local = (path: string, body: object, headers?: Record<string, string>) => post(`http://127.0.0.1:${port}/api/v1/video/${path}`, body, headers);
    const pending: Array<{ result: Record<string, any>; downloadUrl?: string }> = [];
    let expectedCost = buyer.buyerPaymentManager!.getVerifiedCost(discoveredSeller.peerId);
    for (const result of report.cases) {
      if (previous) {
        const existing = previous.cases[report.cases.indexOf(result)];
        if (JSON.stringify(existing?.request) !== JSON.stringify(result.request) || !existing?.queueId || existing.delivery !== 'P2P stream') throw new Error('Resume requires matching accepted streamed jobs');
        result.queueId = existing.queueId;
        result.delivery = existing.delivery;
        result.originalCreateStatus = existing.createStatus;
        result.originalReplayPassed = existing.replayPassed;
        pending.push({ result });
        continue;
      }
      const headers = { 'x-antseed-idempotency-key': `venice-live-${randomUUID()}` };
      const created = await local('queue', result.request, headers);
      const accepted = await created.json();
      result.createStatus = created.status;
      if (created.status !== 200 || !accepted.queue_id) {
        result.error = accepted;
        await save();
        continue;
      }
      result.queueId = accepted.queue_id;
      result.delivery = accepted.download_url ? 'private URL' : 'P2P stream';
      expectedCost += BigInt(parseInt(result.request.duration, 10)) * 10_000n;
      await save();
      const replay = await local('queue', result.request, headers);
      expect(replay.status).toBe(200);
      expect((await replay.json()).queue_id).toBe(accepted.queue_id);
      expect(buyer.buyerPaymentManager!.getVerifiedCost(discoveredSeller.peerId)).toBe(expectedCost);
      result.replayPassed = true;
      pending.push({ result, downloadUrl: accepted.download_url });
    }
    const unknown = await local('retrieve', { model: models[0], queue_id: `unknown-${randomUUID()}` });
    expect(unknown.status).toBe(404);
    await unknown.arrayBuffer();
    report.unknownJobStatus = unknown.status;
    const invalidBody = { ...cases[0], prompt: '' };
    const directInvalid = await vendor('queue', invalidBody);
    const proxyInvalid = await local('queue', invalidBody);
    report.invalidPrompt = { direct: directInvalid.status, proxy: proxyInvalid.status };
    await directInvalid.arrayBuffer();
    await proxyInvalid.arrayBuffer();
    expect(report.invalidPrompt).toEqual({ direct: 400, proxy: 400 });
    const deadline = Date.now() + 18 * 60_000;
    while (pending.length && Date.now() < deadline) {
      for (const job of [...pending]) {
        const body = { model: job.result.request.model, queue_id: job.result.queueId, delete_media_on_completion: false };
        let response = await local('retrieve', body);
        job.result.polls = (job.result.polls ?? 0) + 1;
        if (response.headers.get('content-type')?.includes('application/json')) {
          const status = await response.json();
          job.result.lastStatus = status;
          job.result.retrieveStatus = response.status;
          await save();
          if (response.status !== 200) {
            job.result.error = status;
            pending.splice(pending.indexOf(job), 1);
            continue;
          }
          if (status.status === 'PROCESSING') continue;
          if (status.status !== 'COMPLETED' || !job.downloadUrl) {
            job.result.error = 'Unexpected JSON status without a usable download URL';
            pending.splice(pending.indexOf(job), 1);
            continue;
          }
          const downloadUrl = new URL(job.downloadUrl);
          if (downloadUrl.protocol !== 'https:' || downloadUrl.username || downloadUrl.password) throw new Error('Unsafe private download URL');
          response = await fetch(downloadUrl, { signal: AbortSignal.timeout(120_000) });
        }
        if (response.status !== 200 || !response.headers.get('content-type')?.includes('video/mp4')) {
          job.result.error = `Download HTTP ${response.status}: ${response.headers.get('content-type')}`;
          await response.body?.cancel();
          pending.splice(pending.indexOf(job), 1);
          continue;
        }
        const chunks: Uint8Array[] = [];
        const reader = response.body!.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const bytes = Buffer.concat(chunks);
        expect(bytes.subarray(4, 8).toString()).toBe('ftyp');
        job.result.downloadPassed = true;
        job.result.bytes = bytes.length;
        job.result.chunks = chunks.length;
        job.result.sha256 = createHash('sha256').update(bytes).digest('hex');
        job.result.file = `case-${report.cases.indexOf(job.result) + 1}.mp4`;
        await writeFile(join(outputDir, job.result.file), bytes, { mode: 0o600 });
        const complete = await local('complete', body);
        job.result.completeStatus = complete.status;
        const completeBody = await complete.text();
        if (complete.status !== 200) job.result.error = { stage: 'complete', status: complete.status, body: completeBody };
        job.result.passed = complete.status === 200;
        pending.splice(pending.indexOf(job), 1);
        await save();
      }
      if (pending.length) await new Promise(resolve => setTimeout(resolve, 15_000));
    }
    for (const job of pending) job.result.error = 'Generation deadline exceeded; job was not resubmitted';
    report.expectedAntseedMicroUsd = String(expectedCost);
    report.verifiedAntseedMicroUsd = String(buyer.buyerPaymentManager!.getVerifiedCost(discoveredSeller.peerId));
    expect(report.verifiedAntseedMicroUsd).toBe(report.expectedAntseedMicroUsd);
    report.downloadsPassed = report.cases.every((result: Record<string, any>) => result.downloadPassed);
    await vi.waitFor(() => {
      const auths = (buyer as any)._verificationStorage.listResponseAuthsBySeller(discoveredSeller.peerId);
      expect(auths.length).toBeGreaterThan(0);
      expect(auths.filter((auth: any) => !auth.verified).map((auth: any) => auth.verificationError)).toEqual([]);
      report.verifiedResponses = auths.length;
    }, { timeout: 10_000 });
    expect(report.cases.filter((result: Record<string, any>) => !result.passed).map((result: Record<string, any>) => ({ model: result.request.model, error: result.error }))).toEqual([]);
    report.passed = true;
  } catch (error) {
    report.error = String(error).replaceAll(apiKey, '[redacted]');
    throw new Error(report.error);
  } finally {
    report.finishedAt = new Date().toISOString();
    await save();
  }
}
