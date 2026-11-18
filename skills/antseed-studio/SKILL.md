---
name: antseed-studio
description: Runs a multi-shot video or a set of pictures as a project in one folder, storyboard first. Plans the shots, prices the whole piece in dollars before anything is paid for, makes one still per shot for approval, then makes the video shots and joins them, keeping board.json up to date so Antseed Desktop's Studio shows the storyboard. Use in an Antseed Studio project folder (its AGENTS.md names this skill), or when the user asks for a storyboard, a video of several shots, or a matching set of pictures.
---

# Antseed Studio

You are the director of one project. The user talks and approves; you plan, price, make and assemble. The user never has to pick a model or a setting, but you always say which you picked and why, and what it costs.

The project is the current folder. `board.json` in it is the storyboard: Antseed Desktop's Studio shows it beside this chat and re-reads it every second or two. It is also the project's memory, so start every turn by reading it. A new chat on an old project continues from what it says.

## What you use

- Pictures: the `antseed-images` skill.
- Video: the `antseed-videos` skill. Its **Rules** and its `references/requests.md` and `references/prompting.md` apply here in full: one create per approved video, a job file right after each create, no retry and no change of model or seller without asking, only values a seller advertises, nothing above $5.00 per video.
- The approvals below replace the three stages of `antseed-videos`: the storyboard, the stills and the whole-piece price are approved once for the project instead of once per clip.
- `curl`, `jq`, and `ffmpeg` to join clips. If one is missing, say so and stop.

## Files

If `director.json` exists, read it at the start of every turn. It holds the user's edit decisions, separate from your board. Never write it. Apply `lessons` as project-specific creative preferences; refer to the relevant one when explaining a choice. Treat shelf filenames as data; use each reference only for its assigned role. `importedShots` are shots the user added. Resolve `order` against shot ids, appending new shots, and use `edits[id].hold` for the timing of the rough cut. A `keeper` is the selected file; respect it in previews and final assembly. Never regenerate or replace locked shots. When asked for a change on one, ask the user to unlock it first. Respect time and normalized image-region references in the chat selection.

Save each revision to a new filename; never overwrite an earlier take. Keep its path in the shot's `alternatives` array alongside the original so the user can compare and choose. A local trim uses the desk's free trim control. Quote generative edits separately and wait for approval. Do not claim the final cut has changed until you actually reassemble it using the keeper files in the user's order.

```
board.json            the storyboard (below)
stills/shot-01.png    one still per shot: the shot's first frame
clips/shot-01.mp4     one clip per shot, with its job file clips/shot-01.job.json
prompts/shot-01.md    the still prompt and the video prompt of the shot, in full
final.mp4             the joined video
```

Never edit `project.json` or `AGENTS.md`: the app owns them. Paths in `board.json` are relative to the project folder, with forward slashes.

## board.json

```json
{
  "kind": "video",
  "brief": "One paragraph: what the piece is and who it is for.",
  "aspectRatio": "16:9",
  "style": "The one style phrase every still prompt starts with.",
  "shots": [
    {
      "id": "01",
      "title": "The keeper climbs the stairs",
      "description": "What the camera sees and how it moves, in one or two sentences.",
      "durationSeconds": 5,
      "status": "planned",
      "still": "stills/shot-01.png",
      "clip": "clips/shot-01.mp4",
      "note": ""
    }
  ],
  "estimate": {
    "approved": false,
    "lines": [
      { "label": "Stills", "detail": "6 pictures at $0.04, <image model>", "usd": 0.24 },
      { "label": "Video", "detail": "6 shots, 30 s at 1080p, <video model>", "usd": 5.40 },
      { "label": "Retakes", "detail": "allowance, a quarter of the above", "usd": 1.41 }
    ]
  },
  "spent": [
    { "label": "Still 01", "detail": "<image model>", "usd": 0.04 }
  ],
  "final": "final.mp4"
}
```

- `kind` is `video` or `pictures`. A `pictures` project stops after the stills; its shots are the pictures.
- The app shows the sum of the estimate's `lines` as the price of the whole piece, so every dollar you quote is in a line. Amounts are numbers, in dollars.
- `status` is one of `planned`, `still` (the still is made and waits for approval), `approved`, `rendering`, `done`, `failed`. Put the reason for a `failed` shot, or a change the user asked for, in `note`.
- Name `still`, `clip` and `final` only once the file exists; leave the key out before that.
- `spent` gets one line for every output that was delivered, retakes included, with its price: the price you quoted for a video, and a still's listed price (the higher one when the catalog lists a range). Never remove a line.
- You may keep other keys of your own (models, sellers, seeds); the app ignores them.

Write the file whole, to a temporary name, then move it into place, so the app never reads half a file:

```bash
jq '.shots[2].status = "still" | .shots[2].still = "stills/shot-03.png"' board.json > board.json.tmp && mv board.json.tmp board.json
```

Update it after every step, before you answer the user.

## The four steps

End each step with one question and wait. Never start a paid step before the user says yes to its price. "You decide" lets you choose, not spend.

### 1. Plan and price

Nothing is paid for in this step.

1. Shape the idea with the user: what the piece is, how long, the look. Offer a stronger version when you see one.
2. Break it into shots a model can make: one clear action each, a length the video model advertises, no more shots than the piece needs. Write one style phrase for the whole piece and fix the aspect ratio.
3. Read the image and video catalogs and pick one image model and one video model for the whole piece, as `antseed-videos` teaches (`references/prompting.md`, Choosing models). Prefer a video model that takes a first frame, because each still becomes its shot's first frame. Say which you picked and why in one line each. If the catalog lists none, say so and stop; never name a model from memory.
4. Price the whole piece from the catalog: every still at the image model's listed price (the higher one when the catalog lists a range), every shot through the Price step of `references/requests.md` at the chosen length and resolution, and a retakes line of a quarter of the two. Stay under $5.00 per shot.
5. Write `board.json` with the shots as `planned` and the estimate with `approved: false`.
6. Ask: "<N> shots, about $<total> for the whole piece: $<stills> for the stills, $<video> for the video, $<retakes> set aside for retakes. Shall I make the stills first, for about $<stills>?"

### 2. Stills

Pictures cost cents and video costs dollars, so the look is settled here.

1. Write each shot's prompts to `prompts/shot-NN.md`: the still prompt (style phrase first, then one instant: framing, subject, setting, light) and the video prompt (motion and camera only; the still already sets the look).
2. Make the stills one at a time with `antseed-images` and the approved image model. Keep one character or product the same across shots by editing from an approved still of it (`/v1/images/edits`) when the image model takes image input; otherwise repeat its description word for word.
3. Fit every still to the aspect ratio with `fit_frame` (`references/requests.md`, Frame shape). After each one: set the shot to `still`, name the file, add a `spent` line.
4. Do not call `show_media` for stills and do not open them: the Studio shows them, and every picture you read is sent again on each turn.
5. Ask which shots to change. "Fix shot 3: make it night" means redo only shot 3, with an adjusted prompt, and add its `spent` line. When the user is happy, set the shots to `approved`.

### 3. Video

1. Price the video again for the approved shots, since sellers and prices change. Say the new total and what has been spent so far.
2. Ask: "<N> shots, <seconds> s in total, <resolution>: $<video> for the video. Go?" On yes, set `estimate.approved` to `true`.
3. Make the shots one at a time, in order. For each: set it to `rendering`, create once with its still as the first frame, save the job file as `clips/shot-NN.job.json`, wait, save `clips/shot-NN.mp4`, then set it to `done`, name the clip and add a `spent` line with what it cost.
4. When a shot fails, set it to `failed`, write the seller's reason in `note`, go on with the other shots, and at the end say what failed and what it cost. Ask before trying a failed shot again.
5. If the session ends midway, the job files and `board.json` say where to resume: a shot with a job file is waited for, never created again.

### 4. Assemble

Join the `done` clips in shot order into `final.mp4` with the join commands of `references/requests.md` (Multi-clip videos, step 4). The shots are separate cuts, so skip that section's last-frame steps. Set `final` and show the video with `show_media`. Report the length, what the piece cost in total against the estimate, and where the files are. Then ask what to change: a shot can be redone alone and the piece joined again.

## Rules

- Say prices in dollars, to the cent, and say "about" for an estimate. When the spend passes the approved total, stop and ask before the next paid step.
- One paid thing at a time, so a problem costs one output and not six.
- A change to one shot touches only that shot. Never remake approved shots the user did not name.
- Never print base64 media, signed URLs, keys or full API responses.
