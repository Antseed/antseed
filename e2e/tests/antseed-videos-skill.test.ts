import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// The antseed-videos skill checks a source video against the limits fal
// publishes for the model. These tests run the skill's own bash function,
// taken from requests.md, against saved fal schemas, with fake `curl` and
// `ffprobe` so they need neither the network nor ffmpeg.
const requestsMd = readFileSync(new URL('../../skills/antseed-videos/references/requests.md', import.meta.url), 'utf8');
const fixtures = new URL('../../plugins/provider-fal-video/src/fixtures/', import.meta.url).pathname;
const hasTools = ['bash', 'jq'].every((tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0);

function bashFunction(name: string): string {
  const match = requestsMd.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, 'm'));
  if (!match) throw new Error(`requests.md has no ${name}()`);
  return match[0];
}

describe.skipIf(!hasTools)('antseed-videos skill: check_fal_source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-check-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // fal's schema endpoint: copy the saved schema of the requested endpoint to `-o`.
  writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash
out=""; id=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift ;; endpoint_id=*) id="\${1#endpoint_id=}" ;; esac
  shift
done
cp "${fixtures}\${id//\\//_}.json" "$out" 2>/dev/null
`);
  // The source's measurements come from the test.
  writeFileSync(join(dir, 'ffprobe'), `#!/usr/bin/env bash
case "$*" in *width,height*) echo "$FAKE_W,$FAKE_H,$FAKE_FPS" ;; *rotation*) echo "$FAKE_ROT" ;; *format=duration*) echo "$FAKE_S" ;; esac
`);
  chmodSync(join(dir, 'curl'), 0o755);
  chmodSync(join(dir, 'ffprobe'), 0o755);
  const script = join(dir, 'check.sh');
  writeFileSync(script, `${bashFunction('check_fal_source')}\ncheck_fal_source "$@"\n`);

  const check = (endpoint: string, source: { w: number; h: number; fps: string; s: number; bytes?: number; rotation?: number }, duration?: number) => {
    const file = join(dir, 'source.mp4');
    writeFileSync(file, Buffer.alloc(source.bytes ?? 1000));
    const result = spawnSync('bash', [script, endpoint, file, ...(duration === undefined ? [] : [String(duration)])], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_W: String(source.w), FAKE_H: String(source.h), FAKE_FPS: source.fps, FAKE_S: String(source.s), FAKE_ROT: source.rotation === undefined ? '' : String(source.rotation) },
    });
    return { status: result.status, lines: result.stdout.trim().split('\n'), stderr: result.stderr };
  };
  const fails = (lines: string[]) => lines.filter((line) => line.startsWith('FAIL'));

  it('passes a source inside Kling v4 edit\'s x-fal limits', () => {
    const { status, lines } = check('kling/v4/video-to-video/edit', { w: 1280, h: 720, fps: '30/1', s: 6.4 }, 6);
    expect(status).toBe(0);
    expect(fails(lines)).toEqual([]);
    expect(lines).toContain('required fields: prompt, video_url');
    expect(lines).toContain('resolution: 720p, 1080p');
    expect(lines).toContain('ok   height 720 px (700 to 4553)');
  });

  it('fails a source below Kling v4 edit\'s minimum size, with the fix', () => {
    const { status, lines } = check('kling/v4/video-to-video/edit', { w: 864, h: 496, fps: '30/1', s: 5.2 }, 5);
    expect(status).toBe(1);
    expect(fails(lines)).toEqual(['FAIL height 496 px is below 700: scale it up']);
  });

  it('checks a phone video turned 90 degrees at its display size', () => {
    const { lines } = check('kling/v4/video-to-video/edit', { w: 1280, h: 690, fps: '30/1', s: 5, rotation: -90 }, 5);
    expect(lines).toContain('source: 5 s, 690x1280, 30 fps, 1000 bytes');
    expect(fails(lines)).toEqual(['FAIL width 690 px is below 700: scale it up']);
  });

  it('fails a frame rate, file size and length outside the limits', () => {
    const { status, lines } = check('kling/v4/video-to-video/edit', { w: 1280, h: 720, fps: '15/1', s: 31.2, bytes: 314_572_801 });
    expect(status).toBe(1);
    expect(fails(lines)).toEqual([
      'FAIL length 31.2 s is above 30.05: trim it: ffmpeg -t 30',
      'FAIL file size 314572801 bytes is above 314572800: re-encode a smaller copy',
      'FAIL frame rate 15 fps is below 23.9: re-encode at -r 24',
    ]);
  });

  it('fails a duration longer than the source', () => {
    const { status, lines } = check('fal-ai/wan/v2.7/edit-video', { w: 1280, h: 720, fps: '30000/1001', s: 6.4 }, 7);
    expect(status).toBe(1);
    expect(fails(lines)).toEqual(['FAIL duration 7 is longer than the source (6 s): send at most 6']);
    expect(check('fal-ai/wan/v2.7/edit-video', { w: 1280, h: 720, fps: '30000/1001', s: 6.4 }, 5).status).toBe(0);
  });

  it('asks for the source length on a model without a duration field, and prints the image limits', () => {
    const { status, lines } = check('fal-ai/kling-video/v3/standard/motion-control', { w: 720, h: 1280, fps: '24/1', s: 2.1 }, 3);
    expect(status).toBe(1);
    expect(fails(lines)).toEqual([
      'FAIL duration 3 is longer than the source (2 s): send at most 2',
      'FAIL length 2.1 s is below 3: use a longer clip',
    ]);
    expect(lines).toContain('required fields: image_url, video_url, character_orientation');
    expect(lines.some((line) => line.startsWith('limits on image_url:') && line.includes('min_width=340'))).toBe(true);
  });

  it('says when fal gives the source limits only in words', () => {
    const { status, lines } = check('minimax/h3-max/recast', { w: 1280, h: 720, fps: '30/1', s: 2.1 }, 2);
    expect(status).toBe(3);
    expect(fails(lines)).toEqual([]);
    expect(lines).toContain('  video_url: The source video, 5 to 30 seconds long, with no single shot longer than 15 seconds.');
    expect(lines).toContain('required fields: video_url, reference_image_urls');
  });

  it('exits 2 when the schema cannot be read', () => {
    const { status, stderr } = check('no/such/endpoint', { w: 1280, h: 720, fps: '30/1', s: 6 });
    expect(status).toBe(2);
    expect(stderr).toContain('could not read fal\'s schema');
  });

  it('runs every bash block of the skill through bash -n', () => {
    const blocks = [...requestsMd.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((match) => match[1]!);
    expect(blocks.length).toBeGreaterThan(10);
    for (const block of blocks) execFileSync('bash', ['-n'], { input: block });
  });
});
