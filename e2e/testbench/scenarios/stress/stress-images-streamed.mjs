// stress-images with half of the images streamed as OpenAI's image events, with partial previews.
import { GATES, stressRun, stressTopology } from '../../lib/stress.mjs';

export const meta = {
  description: '32 concurrent requests, 40% of them unit-billed image generations, half of those streamed as events with 0 to 3 partial previews; every image is paid per final image and the oracle balances (stress streamed images).',
  targets: ['local', 'fork'],
  requires: ['mockControl'],
};

export const topology = stressTopology();

export async function run(tb) {
  await stressRun(tb, {
    load: { concurrency: 32, requests: 256, imageRatio: 0.4, imageStreamRatio: 0.5 },
    gate: GATES.default,
  });
}
