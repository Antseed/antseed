# Workflow details

## Gate details

The gates in SKILL.md decide the order. This section covers what to read from the helper at each gate.

### Gate 1: ranked models

`models` returns every video model on the network with its advertised options under `video` (`durationsSeconds`, `resolutions`, `aspectRatios`, `inputs`, `requiredInputs`, `audio`), plus its leaderboard position:

- `rank`, `rating`: position on LMArena's `image_to_video` board for models that take a start frame, otherwise on `text_to_video`.
- `tier`: `top` (top 12), `ranked`, or `unranked`.
- `match`: `exact`, or `family` when the score belongs to the base model of a variant such as a fast or lite tier.
- `takesFrames`, `takesLastFrame`: whether the model accepts a start or an end frame.
- `recommended`: the best-ranked model that takes a start frame.
- `rankings`: the source and publish date to cite. `source` is `live`, `cache`, `snapshot` (built-in fallback), or `off`.

Model families often come in variants, for example `seedance-2-0-text-to-video-basic` and `seedance-2-0-image-to-video-basic`. Recommend the variant that takes frames.

Example (models and ranks are illustrative; always use the real output):

> **User:** I want a video of a lighthouse keeper watching a storm roll in.
> **Agent:** Nice mood piece. It will land better with one clear beat: the keeper lights the lamp just as the first wave hits, so the video ends on the beam cutting through the storm. I'd also keep it to one slow push-in rather than several cuts.
>
> I recommend **MiniMax H3 Image To Video**: #1 on LMArena's image-to-video board, takes a start frame, 6 or 10 s. Alternatives: Gemini Omni Flash 1.1 (#2, start frame), Wan 3.0 Prime (#3, start and end frame), Seedance 2.5 (#4, start frame).
>
> Does the sharpened idea work for you? Shall I use MiniMax H3, or another one?

### Gate 2: options, prompts, and image model

`options --model <id>` lists each seller's exact options. Ask only about advertised values, and never claim support the output does not show.

- **Aspect ratio:** ask in Gate 2a and generate the frames at that shape. When no seller advertises aspect ratios (common for image-to-video models, which take the shape from the start frame), do not pass `--aspect-ratio`; the helper rejects it. Still make the frames at the shape the user wants.
- **Frames:** `first_frame` only means one start image. `first_frame` and `last_frame` mean a start-to-end transition. No `inputs` means text only.

`image-models` returns the network's image models ranked on LMArena's `text_to_image` board, with `priceUsd` (cheapest seller per image) and `recommended` (best `top`-tier model). Use the recommended model unless the user picks another. Pass it to `antseed-images` with the approved frame prompt and aspect ratio, save the frames as PNG, JPEG, or WebP, and show each one before moving on.

In Antseed Desktop:

- Uploaded images include an `<uploaded-image id="...">` tag and generated images a `<generated-image id="...">` tag. Call `get_chat_image_path` with that id to get a local path.
- Call `show_media` with a saved frame or video path to show it inline.

Map the start image to `--first-frame` and the end image to `--last-frame`. With two images, ask which is which unless the request makes it clear.

### Gate 3: settings

- **Duration:** offer the advertised seconds. If none are listed, ask for an explicit duration; use the model's automatic duration only when the user accepts it (`fal-video` models have none).
- **Resolution:** offer the advertised values exactly as written (case matters, for example `768P`) and recommend the highest. Sellers price by resolution.
- **Audio:** ask only when a seller advertises `audio: true`; only then pass `--audio` or `--no-audio`. Some models, such as Flux 3 First/Last Frame, add their own soundtrack and reject an audio setting.
- **Output:** default to `generated-video.mp4` in the current directory unless the user chooses a path.

## Long videos

If the requested length is longer than the longest advertised duration, for example 60 s with 15 s clips, plan segments instead of refusing:

1. Split the length into segments of advertised durations, for example 4 × 15 s.
2. Write one prompt per segment and one keyframe prompt per boundary: start, after segment 1, ..., end. N segments need N+1 keyframes. Keep subject, style, lighting and aspect ratio consistent.
3. Get the keyframes:
   - Use the user's uploaded start and end images as the first and last keyframes.
   - Generate the inner keyframes with `antseed-images`, show them, and ask for approval.
4. Pick the model:
   - Prefer a model that supports both `first_frame` and `last_frame`. Segment *i* uses keyframe *i* as `--first-frame` and keyframe *i+1* as `--last-frame`, so every cut lines up.
   - If only `first_frame` is supported, generate segment 1 from the start keyframe. Extract its last frame, then start the next segment from it:

     ```bash
     node scripts/antseed_video.mjs frame --video seg1.mp4 --position last --output seg1-last.png
     ```

   - Use frame-free segments only if the user explicitly skips images or no compatible model accepts frames. Tell the user the subject, look, and cuts will not be consistent.
5. Show the segment plan, model, seller, per-segment price and total price. Ask for one confirmation for the whole plan.
6. Generate the approved segments:
   - If every segment has its prompt and frames, use `batch`. It submits creates one at a time, starts waiting as soon as each job is accepted, and renders the accepted jobs in parallel.
   - If the user asks for a test, the first segment, or only some segments, include only those in the plan.
   - If the next segment needs the previous segment's last frame, generate in order.
   - If a create fails, `batch` creates no more jobs but keeps waiting for jobs already accepted. Do not move the remaining segments to another seller without asking.
7. Stitch the segments with ffmpeg, for example a concat list re-encoded to H.264/AAC, and show the final MP4 when supported. Keep the segment files.

Example `segments.json`; relative paths are resolved from the plan file:

```json
{
  "segments": [
    { "promptFile": "seg1.txt", "firstFrame": "k0.png", "lastFrame": "k1.png", "output": "seg1.mp4" },
    { "promptFile": "seg2.txt", "firstFrame": "k1.png", "lastFrame": "k2.png", "output": "seg2.mp4" }
  ]
}
```

```bash
node scripts/antseed_video.mjs batch \
  --model "$model" \
  --peer "$peer_id" \
  --duration 10 \
  --resolution 1080p \
  --aspect-ratio 16:9 \
  --plan segments.json
```

The result has one entry per segment with `state`, `jobId`, `output`, and any error. Retry an accepted but unavailable job with `download --job-id`; never create it again without asking.

## Select and confirm

Use the exact choices for selection:

```bash
node scripts/antseed_video.mjs select \
  --model "$model" \
  --prompt-file prompt.txt \
  --duration 10 \
  --resolution 1080p \
  --aspect-ratio 16:9 \
  --first-frame first.png \
  --last-frame last.png
```

`select` returns compatible sellers ranked by reputation, then estimated price. If the user wants the cheapest option, pass `--prefer price`. Show the chosen seller id, reputation, and estimated price. Ask for confirmation before generating.

If no seller is compatible, show the alternatives returned by the helper. Do not drop or change a requested option without the user's approval.

## Generate

Run with the same options and the confirmed seller:

```bash
node scripts/antseed_video.mjs generate \
  --model "$model" \
  --peer "$peer_id" \
  --prompt-file prompt.txt \
  --duration 10 \
  --resolution 1080p \
  --aspect-ratio 16:9 \
  --first-frame first.png \
  --last-frame last.png \
  --output generated-video.mp4
```

The helper checks the seller again, creates exactly one job, waits, and saves the MP4. Its JSON result is safe to summarize. Show the returned `output` video when the agent environment supports it.

If the create fails without a job id, do not create again on your own. Report the error and ask the user, because a repeated create can start a second paid job.

While waiting, the helper retries temporary status or download errors (`429`, `502`, `503`, `504`, an unreachable proxy) with backoff, without creating a job. It stops after 5 such errors in a row (about 2 to 3 minutes), or 3 after the video was reported finished, and returns `video_retrieve_unavailable` with `jobId`, `lastStatus`, `lastCode`, and `resumable: true`. Lasting errors such as `400`, `401`, `402`, `404`, or `410` stop at once.

If generation times out or returns `video_retrieve_unavailable` after acceptance, do not create again. Tell the user the job id, then use it later; downloads are free:

```bash
node scripts/antseed_video.mjs download --model "$model" --job-id "$job_id" --output generated-video.mp4
```

For a job on a `fal-video` seller, add `--protocol fal-video`; `generate` reports the job's `protocol`.

## Errors

Failed commands return `error` with `code`, the full `message`, `status`, and, when the seller explained itself, `peerMessage` (the seller's own reason), `peerStatus`, and `details` (per-field validation problems). Read `peerMessage` and `details` before choosing a fix: a `400` that names a field means that field is wrong for this model, so change that field rather than switching sellers or models, and ask the user before creating again.

- `402`: buyer needs more deposited USDC or payment-channel capacity.
- `402 one_off_channel_required`: the buyer retried before the seller registered the video's payment channel. Buyers before `@antseed/cli@0.1.171` hit this; update the buyer. Each failed attempt leaves a funded channel that `antseed buyer channels request-close <channelId>` releases.
- Price above $5.00, or "above the configured limit": choose a shorter duration or lower resolution. `select` already treats such sellers as incompatible.
- "Explicit video duration is required" or "No billing component matched": send an advertised `--duration`, and an advertised `--resolution` when the model lists any.
- `model_not_found`: run `models` again and retry once after a few seconds; routing can briefly exclude a seller right after a failed request.
- `404` or `video_route_not_found`: unknown job, missing route, or expired file.
- `video_retrieve_unavailable`: the job was accepted but status or download kept failing. The job may still finish; retry with `download --job-id` later.
- `502 video_download_failed`: the seller could not reach the upstream video service for this check. The helper retries it.
- `400 unsupported_video_options` or `no_compatible_video_offer`: options do not fit a seller.
- Connection refused: start Antseed Desktop or `antseed buyer start`.
