---
name: antseed-studio
description: Plans and makes the shots of a film in an Antseed Desktop Studio project. The user edits the film in the app as a storyboard of shots (an anchor image each) with a clip between each pair, and talks to you about what is selected; this skill quotes every image and clip before paying, makes it with the antseed-images and antseed-videos skills, and hands the file or the edit back to the track. Use in an Antseed Studio project folder (its AGENTS.md names this skill), or when the user asks for clips between images, a scene that continues from a frame, or a film assembled from stills.
---

# Antseed Studio

The project is the current folder. The user edits the film beside this chat, in Antseed Desktop's Studio: a storyboard of **shots** in order, each with a title and an **anchor image**, and a **clip** leaving each anchor. The app has no settings panel: the user selects a shot or a clip and tells you in this chat what it should be. You make what the user asks for and hand it back; the user trims, replaces, reorders, sets Cut or Extend and exports in the app, for free.

## What you use

- Pictures: the `antseed-images` skill.
- Video: the `antseed-videos` skill. Its **Rules** and its `references/requests.md` and `references/prompting.md` apply in full: one create per approved video, a job file right after each create, no retry and no change of model or seller without asking, only values a seller advertises, nothing above $5.00 per video.
- The user's requests from the app replace that skill's three stages: the frames already exist on the track, so each request goes straight to a quote.
- **The gateway.** Every catalog read, price check, image and video request goes to `$ANTSEED_PROXY_URL` with `$ANTSEED_API_KEY`: Antseed Desktop sets both for this chat to the gateway chosen in its Settings, so Studio spends only through that gateway. If `$ANTSEED_PROXY_URL` is not set, stop and tell the user to open the project from Antseed Desktop; never fall back to `http://127.0.0.1:8377` or any other address, and never ask for or use another key.

## Files

```
track.json                 the track (read it, never write it)
track.history.json         the app's undo history (never touch)
uploads/ stills/ frames/   pictures; frames/ holds frames cut from clips
clips/                     clips you make: clips/<clip id>-v<n>.mp4, with its job file beside it
deliveries/                where you announce each file you made (below)
exports/                   films the app joined
```

Never edit `track.json`, `project.json` or `AGENTS.md`: the app owns them. Never overwrite a file; every new version gets a new name, so the user can always go back to an earlier one from the app's library. Paths are relative to the project folder, with forward slashes.

## track.json

Read it at the start of every turn. The parts you need:

- `aspectRatio`: `16:9`, `9:16` or `1:1`. Every image and clip uses it.
- `anchors`, in film order: the shots. Each has an `id` (`a3`), a `title` (the shot's name on the storyboard), an `image` (or null while it has none), and `prompt`, what it should show. The app calls the anchor at position 3 "Shot 3".
- `anchors[n].clip` is the clip from that anchor to the next one: `id` (`c4`), `plannedSeconds`, `prompt` (the user's direction), `then`, the versions made so far, and `use`, the version in use.
- `then` says how the clip ends. **`extend`**: the clip must land exactly on the next anchor's image, so it is made with the anchor's image as the first frame and the next anchor's image as the last frame. **`cut`**: the film cuts hard to the next anchor, so the clip is made from its first frame only and ends freely. The last anchor's clip, if it has one, ends freely too.
- `scenes`, keyed by the id of a scene's first anchor: `name` and `world`, one line about the place, time and light. A scene runs until the next Cut. Start every prompt in a scene with its world line, so the clips of one scene look like one place.

## Messages from the app

A message about something selected starts with a line from the app, for example:

```
[Studio: Clip 3→4 (clip c4) · empty, planned 5 s · start stills/a3.png · then Extend: must land on stills/a4.png (Shot 4) · aspect 16:9]
slow push in as the lamp flickers on
```

The bracket line names the item, its ids, its files and, for a clip that is playing, the moment the user stopped at. The user's own words follow. Read `track.json` too: the line is a summary, the file is the truth.

- **Something to make** (an empty clip, a new image, a remake): it is one round:
  1. **Quote.** Read the catalog. For an Extend, pick a video model that takes a first and a last frame (`end_image_url` or `last_frame`); for a Cut, one that takes a first frame. If Cut or Extend is not chosen yet, ask the user to click the marker after the clip first: it decides whether the clip has an end frame. Pick the length the user planned when the model offers it, otherwise the nearest one it offers, and say so. Price it through the Price step of `references/requests.md`. Answer with one line per item and one total: "Clip 3→4, 5 s, <model>, <resolution>: $<price>. Total $<total>. Go?" If no offer takes the frames an Extend needs, say so and ask; never fall back silently to a model that ignores the last frame.
  2. **Wait for yes.** Nothing is paid before the user says yes to that quote in this chat. "You decide" lets you choose, not spend. A quote is for those items at those settings only; a change of model, length or frames needs a new quote.
  3. **Make it.** One paid thing at a time. Use the image files the track names, exactly; do not regenerate an anchor the user did not ask for.
  4. **Deliver** the file (below), then say what it cost.
- **A note on a clip or image** (what to change at a moment): look at that file (a frame at that moment, with `ffmpeg`, when it is a clip), then propose what to change: what stays, what is remade, and the price. Some changes are free in the app (a shorter clip with "End clip here", another version or image from the library); say so instead of quoting a render.
- **A change to the track** ("make it 8 seconds", "call this shot The chase", "extend into the next one"): deliver it as an edit (below). Edits are free and the user can undo them.

For an image, quote one image with the image model and its listed price (the higher one when the catalog lists a range), make it at the track's aspect ratio with `fit_frame` (`references/requests.md`, Frame shape), and deliver it. Generate each image fresh from its own prompt with `/v1/images/generations`: every shot shows something new, and the scene's world line and the same style words keep the shots looking like one film. Use `/v1/images/edits` from a neighbouring shot only when the user asks for the same subject or framing, and then say in the prompt what must change.

## Planning a film

When the user describes a film and the track is empty or nearly so, propose the shots first: a numbered list of titles with one line each and the length of each clip. Then quote the images exactly, as their own line: "Images: <n> × <model> at $<price> = $<total>." Give the clips an estimate only, since each needs Cut or Extend chosen first: "Clips, later: about $<total> with <model>." End with "Say yes to put the shots on the storyboard and make the images." Nothing is made at this step.

A yes to that plan covers the shots and exactly those images: add the shots as edits (`add-anchor` with `title` and `prompt`, below) so they appear on the storyboard, then make and deliver the images one at a time, without asking again. Say when each one is on the storyboard, and the total when all are. Then ask the user to choose Cut or Extend on the marker after each clip (the **?** between two shots), and quote the clips after that; each clip needs its own yes.

## Delivering a file

When a file is saved, write a small JSON file into `deliveries/` (create the folder if it is missing). Name the file exactly as it was saved, extension included (a model may return a `.jpg` for a `.png` you asked for): check with `ls` first. The app reads it within a second or two, puts the file on the track as the version in use, keeps the earlier versions in the library, and moves the delivery to `deliveries/done/`.

```bash
mkdir -p deliveries
jq -n --arg file clips/c4-v2.mp4 '{clip: "c4", file: $file, usd: 0.36, model: "<video model>", startFrame: "stills/a4.png", endFrame: "stills/a5.png"}' > deliveries/.c4-v2.tmp && mv deliveries/.c4-v2.tmp deliveries/c4-v2.json
```

- A clip: `{"clip": "<clip id>", "file": "clips/...mp4", "usd": <price paid>, "model": "<model>", "startFrame": "<image it started from>", "endFrame": "<image it landed on>"}`. `startFrame` and `endFrame` are the image files you gave the model, as paths in the project folder; `endFrame` is `null` for a clip without an end frame. The app checks the clip against these, so if the user replaced one of them while you worked, the clip shows as out of date. Always include them.
- An image: `{"anchor": "<anchor id>", "file": "stills/...png", "usd": <price paid>, "model": "<model>"}`.
- Write to a temporary name starting with a dot, then move it, so the app never reads half a file. `usd` is what the output cost, as you quoted it; the app shows the sum as spent by your count.
- A delivery whose clip or anchor is no longer on the track lands in `deliveries/failed/`; tell the user, since the user may have removed it while you worked.

## Changing the track

You never write `track.json`; you ask the app for an edit by delivering `{"edit": {...}}` the same way as a file. The app applies it like the user's own edit, so Undo takes it back. Use the anchor id from `track.json`; a clip is named by the anchor it leaves.

```bash
jq -n '{edit: {type: "title", anchor: "a3", title: "Grand theft ladybug"}}' > deliveries/.title-a3.tmp && mv deliveries/.title-a3.tmp deliveries/title-a3.json
```

| Edit | Fields |
| --- | --- |
| `title` | `anchor`, `title` |
| `anchor-prompt` | `anchor`, `prompt`: what the image should show |
| `clip` | `anchor`, and `plannedSeconds` (1 to 30) and/or `prompt` |
| `then` | `anchor`, `then`: `"cut"` or `"extend"`; only when the user said which |
| `scene` | `anchor` (first of the scene), `name`, `world` |
| `add-anchor` | `index` (0 = first), optional `title`, `prompt`, `file` (an image already in the project), `scene`: `"continue"` or `"new"` when added at the end |
| `move-anchor` | `anchor`, `to` (new index) |
| `remove-anchor` | `anchor`; only when the user asked. Its files stay in the library |
| `use-version` | `anchor`, `file`: a version the clip already has |
| `aspect` | `aspectRatio`: `16:9`, `9:16` or `1:1` |

Several edit files are applied in name order, so number them (`01-…`, `02-…`). An edit the track refuses lands in `deliveries/failed/` and the user sees why; read the reason and fix it. Undo, trims, exports and replacing an image are the user's alone.

Do not call `show_media` for files you deliver and do not open them: the app shows them, and every picture you read is sent again on each turn.

## Rules

- Talk to the user in the app's words: "Shot 3 · The Heist", "Clip 3→4", the model's name and dollars. Never show ids (`a3`, `c4`), file paths, JSON, commands or what a command printed; the chat hides your tool calls, and the storyboard shows the files.
- Say prices in dollars, to the cent. Never start a paid step without a yes to its price in this chat.
- One paid thing at a time, so a problem costs one output and not six.
- When a video fails, say the seller's reason and what it cost, and ask before trying again. A clip with a job file is waited for, never created again.
- Never print base64 media, signed URLs, keys or full API responses.
