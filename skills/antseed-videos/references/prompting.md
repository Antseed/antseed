# Writing prompts for video and frames

Use this in Gate 2a. Paste every prompt in full so the user can edit it. The guidance below follows each vendor's published prompt guide (sources at the end); when a model is not listed, use the shared formula.

## Shared formula

Every vendor guide converges on the same parts. Write them in this order:

1. **Subject**: who or what, with two or three concrete visual details (color, clothing, material).
2. **Motion**: one clear action with a beginning and an end. Use speed words ("slowly", "suddenly") to control intensity.
3. **Scene**: setting, foreground and background.
4. **Camera**: shot size, angle, and one movement. Each move carries intent: a push-in builds intimacy or tension, a pull-out reveals scale, a tracking shot travels with the subject, an orbit makes the subject important, a fixed camera signals stillness.
5. **Aesthetics**: light source and direction, color tone, lens, film or animation style.
6. **Audio** (only for models with audio on): ambient sound, effects, music, and any spoken line in quotes.

Weak prompts usually stop at subject and motion and get a static camera in an undefined space. Keep prompts to two to five sentences and describe what the camera sees, not the story behind it.

## Image-to-video: the frame already sets the look

When a start frame (and end frame) is used, the image fixes the subject, scene, and style. The video prompt should be **motion + camera**: what moves, how fast, how the camera behaves, and where the shot ends. Do not re-describe the picture or a different scene; contradicting the frame causes jumps. Repeat one short style phrase so the model keeps it.

## Frame prompts (for antseed-images)

- A frame is a still: framing (wide, medium, close-up), subject pose, background, light, at one instant.
- First and last frames share the same style phrase, subject wording, setting, and aspect ratio, and differ only in pose, position, or framing.
- Make the change between frames something the model can animate in the chosen duration: a turn, a few steps, a light switching on, a camera move. Avoid costume changes or new characters between frames.
- Avoid text and logos unless the user asks; video models distort them.
- **Seedance on public APIs rejects frames with recognizable real people.** For Seedance, prefer animated, stylized, non-human, or back-turned subjects, or choose another model.

## Per-model notes

- **Seedance 2.0 / 2.5** (Venice `seedance-*-basic`): Venice's formula is *Subject + Motion + Environment + Camera movement or cut + Aesthetics + Audio*. Image-to-video variants take a first frame and optionally a last frame, and derive the aspect ratio from the image (do not send `aspect_ratio`). Strong at cinematic camera language: dolly zoom, rack focus, tracking shot, POV switch, handheld. Seedance 2.5 image-to-video runs up to 30 s. The Fast tier is lower fidelity (max 720p).
- **MiniMax H3**: MiniMax's own API accepts a first frame, a last frame, or both; on Venice, use only the frames the seller advertises. In text-to-video, camera instructions can be placed in square brackets right after the description they apply to, for example `[pan]`, `[zoom]`, `[static]`. Prompts can be up to 7000 characters.
- **Wan 3.0** (Alibaba): image-to-video prompt = *Motion + Camera movement*; use "fixed camera" to hold still. For several shots in one clip, number them with timings: `Shot 1 [0-3 s] ..., Shot 2 [3-6 s] ...`. Spoken lines in quotes are kept verbatim; write "No dialogue." to suppress speech.
- **Veo 3.1** (Google): describe subject, action, style, camera position and motion, composition, focus, and ambiance. Audio: put dialogue in quotes and name sound effects and ambient noise explicitly. For things to avoid, list the unwanted elements ("wall, frame") rather than writing "no walls".
- **Kling 3.0 / V3**: understands film coverage; can plan cuts itself or follow numbered shots (`Shot 1, profile shot of ... Shot 2, macro shot of ...`). Name the camera's relation to the subject ("tracks her as she walks and holds when she pauses").
- **Gemini Omni Flash**: include scene description, camera movement, lighting, and mood. With a reference image, say in the prompt how the image should be used.
- **Grok Imagine, Flux 3, Runway Gen-4.5, LTX**: no detailed public prompt guide; use the shared formula.

## Example

Idea: a lighthouse keeper lights the lamp as a storm arrives. Model: Seedance 2.0 image-to-video with first and last frame.

- **Style phrase:** "Cinematic live-action film, stormy dusk, cold blue light with warm lamp glow, 35mm lens, light film grain."
- **First frame:** "Cinematic live-action film, stormy dusk, cold blue light with warm lamp glow, 35mm lens, light film grain. Medium shot from behind of a lighthouse keeper in a yellow oilskin coat at the dark lamp room window, rain on the glass, dark sea beyond."
- **Last frame:** "Cinematic live-action film, stormy dusk, cold blue light with warm lamp glow, 35mm lens, light film grain. Wide shot from outside: the lamp is lit and its beam cuts through heavy rain over a breaking wave, the keeper a small silhouette in the window."
- **Video prompt:** "The keeper turns a brass handle and the great lamp flares to life; the camera slowly pulls back through the rain-streaked window and out into the storm as the beam sweeps across a breaking wave. Cinematic, stormy dusk. Sound: heavy rain, wind, a deep wave crash."

## Sources

- Venice, Seedance 2.0 & 2.5: https://docs.venice.ai/guides/media/seedance-2-0
- Venice, Video generation: https://docs.venice.ai/overview/guides/video-generation
- fal, Seedance 2.0 image-to-video: https://fal.ai/models/bytedance/seedance-2.0/image-to-video
- MiniMax H3 video generation: https://platform.minimax.io/docs/guides/video-generation
- Alibaba Cloud Model Studio, video prompt guide (Wan): https://www.alibabacloud.com/help/en/model-studio/text-to-video-prompt
- Google Cloud, Veo prompt guide: https://cloud.google.com/vertex-ai/generative-ai/docs/video/video-gen-prompt-guide
- Kling 3.0 user guide: https://app.klingai.com/global/quickstart/klingai-video-3-model-user-guide
- Google Gemini Omni: https://ai.google.dev/gemini-api/docs/omni
