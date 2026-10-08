# Workflow details

## Ask before paying

Follow the turn order in SKILL.md: what video and which model, then that model's frame inputs, then settings, then frames, then confirmation. `models` already summarizes each model's advertised options under `video` (`durationsSeconds`, `resolutions`, `aspectRatios`, `inputs`, `requiredInputs`, `audio`). Use it for the first question. Then inspect the chosen model per seller:

```bash
node scripts/antseed_video.mjs options --model "$model"
node scripts/antseed_video.mjs image-models   # image models available to generate frames
```

Include only choices advertised by at least one seller:

- **Start and end images (ask right after the model is chosen):** explain what the model takes, for example only a start image or both start and end. Offer two choices: the user uploads images, or you generate them with one of the image models from `image-models`. Prefer a first-last-frame or image-to-video model. Offer text-to-video only if the user explicitly skips images or no compatible model accepts frames.
- **Duration:** list advertised seconds. If no list exists, ask the user for an explicit duration or use the model's automatic duration only when the user accepts it.
- **Resolution:** list advertised values and recommend the highest. If none is advertised, ask whether to omit it.
- **Aspect ratio:** list advertised values. Omit it only when the user does not care. When no seller advertises aspect ratios (for example image-to-video models, which take the shape from the start frame), do not pass `--aspect-ratio`; the helper rejects it.
- **Audio:** ask only when a seller advertises `audio: true`; only then pass `--audio` or `--no-audio`. With `audio: false` or no `audio` field, omit both flags. Some models, such as Flux 3 First/Last Frame, add their own soundtrack and reject an audio setting.
- **Other media:** explain any other supported or required inputs.
- **Output:** default to `generated-video.mp4` in the current directory unless the user chooses a path.

Example exchange (models and options are illustrative; always use the real `models` and `options` output):

> **User:** I want to create a video.
> **Agent:** What should it show? Video models on the network now: Seedance 2.0 (5–15 s, 480p/720p/1080p, start and end image), Wan 2.5 (5 or 10 s, 720p/1080p, text only, audio)…
> **User:** A fox running through snow, Seedance.
> **Agent:** Seedance takes a start shot and an end shot. You can upload them, or I can generate them with an image model on the network (GPT Image 1, Flux 2…). Which do you prefer?
> **User:** Generate them.
> **Agent:** Settings: duration 5, 10 or 15 s? Resolution 480p, 720p or 1080p (recommended)?

Do not ask about options that no seller advertises. Do not infer support from the model name, and do not claim support for a resolution, duration, or aspect ratio that `options` did not show.

## Storyboards and generated frames

For every video request, unless the user supplies the frames or explicitly skips them, draft:

1. a short script or shot description,
2. the final video prompt,
3. a first-frame prompt, and
4. a last-frame prompt when supported.

Ask for approval before generating images or video, and include the image cost with the video cost. Use `antseed-images` for frames, save them as local PNG, JPEG, or WebP files, and pass those paths to the video helper. Keep frames visually consistent: same subject, setting, style, and aspect ratio. Generate images at the target video aspect ratio, or the closest one available.

Ask the user to approve each saved frame, showing it when the agent environment supports images, before generating the video.

In Antseed Desktop:

- Uploaded images include an `<uploaded-image id="...">` tag and generated images a `<generated-image id="...">` tag. Call `get_chat_image_path` with that id to get a local path.
- Call `show_media` with a saved frame or video path to show it inline in the chat.

Map the user's start image to `--first-frame` and end image to `--last-frame`. With two images, ask which is the start and which is the end unless the request makes it clear. With one image, use it as the start image unless the user says otherwise.

## Frame support

Model families often come in variants, for example `seedance-2-0-mini-text-to-video-basic` and `seedance-2-0-mini-image-to-video-basic`. Always check the image-to-video and first-last-frame variants before planning a text-only video.

Check `video.inputs` in `options` output:

- `first_frame` only: the start image is supported, but the end image is not. For an end image, look for a model that lists `last_frame`, for example a first-last-frame model.
- `first_frame` and `last_frame`: both are supported. Use this for start-to-end transitions and for segment chaining.
- No `inputs`: text-to-video only. Frames are not accepted.

Never pass a frame to a seller that does not advertise it, and never drop a user-supplied frame without asking.

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

## Errors

- `402`: buyer needs more deposited USDC or payment-channel capacity.
- `404` or `video_route_not_found`: unknown job, missing route, or expired file.
- `video_retrieve_unavailable`: the job was accepted but status or download kept failing. The job may still finish; retry with `download --job-id` later.
- `502 video_download_failed`: the seller could not reach the upstream video service for this check. The helper retries it.
- `400 unsupported_video_options` or `no_compatible_video_offer`: options do not fit a seller.
- Connection refused: start Antseed Desktop or `antseed buyer start`.
