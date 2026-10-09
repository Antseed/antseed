# Requests

Every command uses `curl` and `jq` against the local buyer proxy. Build JSON with `jq`; never interpolate unescaped prompts. Run each block in one shell; if your shell resets between commands, set the variables again from the job file.

```bash
proxy_url="${proxy_url:-${ANTSEED_PROXY_URL:-http://127.0.0.1:8377}}"
auth='authorization: Bearer antseed-desktop'
```

## Catalog

```bash
# Video models, from what each seller advertises. frames=yes lists image-to-video models;
# frames=no lists text-to-video models (only when the user asked to skip frames).
# id, frames, audio (yes / no / ? = not advertised), max height (px), max seconds, from $/s (lowest resolution; higher costs more), sellers(reputation).
curl -sS --fail-with-body -H "$auth" "$proxy_url/v1/models?type=videos" | jq -r --arg frames "${frames:-yes}" '
  def px: ascii_downcase | if . == "4k" then 2160 elif . == "2k" then 1440
          else (capture("(?<n>[0-9]+)").n | tonumber) end;
  .data[] | [.peers[].capabilities.video // {}] as $v
  | ([$v[].inputs // [] | .[]] | unique) as $in
  | select(($in | index("first_frame") != null) == ($frames == "yes"))
  | [.id, (if $in | index("last_frame") then "first+last" elif $in | index("first_frame") then "first" else "text" end),
     (if any($v[]; .audio == true) then "yes" elif all($v[]; .audio == false) then "no" else "?" end),
     ([$v[].resolutions // [] | .[] | px] | max // "?"),
     ([$v[].durationsSeconds // [] | .[]] | max // "?"),
     ([.peers[] | .unitBillingModels[.protocol].components[]? | select(.unit == "video_seconds") | .priceUsd] | min // "?"),
     ([.peers[] | "\(.displayName // .peerId[0:8])(\(.reputationScore // 0 | floor))"] | join(" "))]
  | map(tostring) | @tsv'

# One model's offers: protocol, options, pricing.
model_file="$(mktemp)"
curl -sS --fail-with-body -H "$auth" \
  "$proxy_url/v1/models/$(jq -rn --arg id "$model" '$id|@uri')" > "$model_file"
jq '.peers[] | {peerId, protocol, video: .capabilities.video, price: .unitBillingModels[.protocol].components}' "$model_file"

# Image models for frames: id, inputs, $ per image (low-high), seller count, sellers that take output_format.
curl -sS --fail-with-body -H "$auth" "$proxy_url/v1/models?type=images" | jq -r '
  .data[] | [.id, ([.peers[].capabilities.inputs // [] | .[]] | unique | join("+")),
    "\([.peers[].minImageUsdPerImage // empty] | min // "?")-\([.peers[].maxImageUsdPerImage // empty] | max // "?")",
    (.peers | length),
    ([.peers[] | select(.capabilities.supportedParameters // [] | index("output_format"))] | length)]
  | map(tostring) | @tsv'
```

Match the user's model case-insensitively against `id` and `aliases`. Several fal models share short aliases, so prefer an exact `id` and ask when an alias matches more than one model. `capabilities.video` lists `durationsSeconds`, `resolutions`, `aspectRatios`, `inputs`, `requiredInputs`, and `audio`; a missing field means unknown, not unsupported.

## Price

Lists the sellers that support every chosen option, with their price, cheapest first. Set `last_frame=yes` when a last frame is sent, and `aspect_ratio` when one is sent. A seller is left out when its pricing has no component for the chosen resolution (the buyer refuses that request), when a last frame is sent and it does not advertise `last_frame` (Venice accepts `end_image_url` at create and fails the job later), or when it lists `aspectRatios` without the chosen ratio. A seller that lists no `aspectRatios` is kept.

```bash
jq --argjson dur "$duration" --arg res "${resolution:-}" \
   --arg last "${last_frame:-}" --arg ratio "${aspect_ratio:-}" '
  [.peers[]
   | .capabilities.video as $v | .serviceId as $svc
   | select(($v.durationsSeconds // [$dur]) | index($dur))
   | select($res == "" or (($v.resolutions // [$res]) | index($res)))
   | select($last != "yes" or ($v.inputs // [] | index("last_frame")))
   | select($ratio == "" or (($v.aspectRatios // [$ratio]) | index($ratio)))
   | [.unitBillingModels[.protocol].components[]
      | select((.match.resolution // $res) == $res and (.match.model // $svc) == $svc)] as $parts
   | select($parts | length > 0)
   | {peerId, protocol,
      priceUsd: ($parts | map(if .unit == "video_seconds" then .priceUsd * $dur
                              elif .unit == "video_generations" then .priceUsd else 0 end)
                        | add * 1000 | round / 1000)}]
  | map(select(.priceUsd <= 5)) | sort_by(.priceUsd)' "$model_file"
```

Pick the first entry and send `"<peerId>@<model>"` so the create goes to that seller. A bare model id applies the buyer's trust filter and can fail with `model_not_found` even when the model is listed. Keep the list: if the create fails at the seller, offer the next entry.

An empty list means no seller supports the options. Choose an advertised duration or a lower resolution.

## Frames as data URLs

Local files must be sent inline. Frames over 1 MB are re-encoded as JPEG first, because a large upload can make the seller fail with "fetch failed". When no converter is found (`sips`, ImageMagick, `ffmpeg`, or `python3` with Pillow), `shrink_frame` fails instead of sending the large file: tell the user and ask whether to install one, use a smaller frame, or send it as is. Write the data URL to a file, because a large frame does not fit on a command line.

```bash
frame_mime() {
  case "$(head -c 12 "$1" | od -An -tx1 | tr -d ' \n')" in
    89504e470d0a1a0a*) echo image/png ;;
    ffd8ff*) echo image/jpeg ;;
    52494646????????57454250) echo image/webp ;;
    *) echo unknown ;;
  esac
}

# Prints the frame to send: a smaller JPEG copy of a large frame, or the original.
shrink_frame() {
  src="$1"; out="$(mktemp)"
  if [ "$(wc -c < "$src")" -le 1000000 ] || [ "$(frame_mime "$src")" = image/jpeg ]; then echo "$src"; return; fi
  if command -v sips >/dev/null 2>&1 && sips -s format jpeg -s formatOptions 85 "$src" --out "$out" >/dev/null 2>&1; then :
  elif command -v magick >/dev/null 2>&1 && magick "$src" -quality 85 "jpeg:$out" 2>/dev/null; then :
  elif convert -version 2>/dev/null | grep -q ImageMagick && convert "$src" -quality 85 "jpeg:$out" 2>/dev/null; then :
  elif command -v ffmpeg >/dev/null 2>&1 && ffmpeg -loglevel error -y -i "$src" -frames:v 1 -q:v 3 -f image2 -c:v mjpeg "$out" 2>/dev/null; then :
  elif command -v python3 >/dev/null 2>&1 && python3 -c 'import sys; from PIL import Image; Image.open(sys.argv[1]).convert("RGB").save(sys.argv[2], "JPEG", quality=85)' "$src" "$out" 2>/dev/null; then :
  fi
  if [ "$(frame_mime "$out")" != image/jpeg ]; then
    echo "frame over 1 MB and no image converter found: $src" >&2; return 1
  elif [ "$(wc -c < "$out")" -lt "$(wc -c < "$src")" ]; then echo "$out"
  else echo "$src"; fi
}

# to_data_url <image> <out-file>
to_data_url() {
  mime="$(frame_mime "$1")"
  case "$mime" in image/png|image/jpeg|image/webp) ;; *) echo "unsupported frame: $1" >&2; return 1 ;; esac
  { printf 'data:%s;base64,' "$mime"; base64 < "$1" | tr -d '\n'; } > "$2"
}
first_url="$(mktemp)"; frame="$(shrink_frame first-frame.png)" && to_data_url "$frame" "$first_url"
if [ -e last-frame.png ]; then last_url="$(mktemp)"; frame="$(shrink_frame last-frame.png)" && to_data_url "$frame" "$last_url"; fi
```

Send only the frame inputs the seller advertises.

## Create once

Check for a job file first. If `<output>.job.json` exists, go to [Wait and save](#wait-and-save) instead. Set `protocol` from the chosen [Price](#price) entry and `route_model` to `<peerId>@<model>`. Write the prompt to `prompt.txt` first. Set `aspect_ratio` to the frame's ratio unless the model note in [prompting.md](prompting.md) says not to send it; some sellers fail the job without it even when they list no ratios. Set `audio=false` only when the user wants a silent video and the seller advertises `audio`; never send `audio=true`, because many models make sound by default and fail the job when `audio` is set. Before an approved retry after a failed job, rename `<name>.job.json` to `<name>.failed.job.json`.

- **`venice-video`**: duration is a string with an `s` suffix (`"5s"`); frames are `image_url` and `end_image_url`.
- **`fal-video`**: duration is a plain string (`"5"`); check the frame field names in fal's schema first, because some models (Kling V3, Wan 3.0) require `start_image_url` (set `first_field`):

```bash
curl -sS "https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=$model" | jq -c '[.components.schemas[] | select(.properties.prompt) | {required, fields: [.properties | keys[] | select(test("image|audio|aspect"))]}]'
```

fal names its audio switch `generate_audio`; the block uses it for fal.

```bash
output="${output:-generated-video.mp4}"; job_file="${output%.*}.job.json"
case "$protocol" in
  venice-video) queue_path=/api/v1/video/queue; id_field=queue_id; dur="${duration}s"; audio_field=audio ;;
  fal-video)    queue_path=/fal/v1/video/queue; id_field=request_id; dur="$duration"; audio_field=generate_audio ;;
esac
if [ -e "$job_file" ]; then
  echo "job exists: $job_file (resume it; do not create again)"
else
  body="$(mktemp)"; resp="$(mktemp)"
  jq -n --arg model "$route_model" --rawfile prompt prompt.txt --arg duration "$dur" \
    --arg resolution "${resolution:-}" --arg aspect_ratio "${aspect_ratio:-}" --arg audio "${audio:-}" --arg audio_field "$audio_field" \
    --arg first_field "${first_field:-image_url}" \
    --rawfile first "${first_url:-/dev/null}" --rawfile last "${last_url:-/dev/null}" '
    {model: $model, prompt: ($prompt | rtrimstr("\n")), duration: $duration}
    + (if $first != "" then {($first_field): $first} else {} end)
    + (if $last != "" then {end_image_url: $last} else {} end)
    + (if $resolution != "" then {resolution: $resolution} else {} end)
    + (if $aspect_ratio != "" then {aspect_ratio: $aspect_ratio} else {} end)
    + (if $audio != "" then {($audio_field): ($audio == "true")} else {} end)' > "$body"
  code="$(curl -sS "$proxy_url$queue_path" -H "$auth" -H 'content-type: application/json' \
    --data-binary @"$body" -o "$resp" -w '%{http_code}' || true)"
  job_id="$(jq -r --arg f "$id_field" '.[$f] // empty' "$resp" 2>/dev/null)"
  if [ -n "$job_id" ]; then
    jq -n --arg model "$model" --arg protocol "$protocol" --arg job_id "$job_id" --arg output "$output" \
      '{model: $model, protocol: $protocol, job_id: $job_id, output: $output}' > "$job_file"
    echo "queued $job_id -> $job_file"
  else
    echo "create failed: HTTP $code" >&2
    jq -c '.error | if type == "object" then {code, type, peer_message, peer_status} else . end' "$resp" 2>/dev/null \
      || { head -c 300 "$resp"; echo; } >&2
    false
  fi
fi
```

A missing job id means the create failed and nothing started. Show the error to the user and fix the field `peer_message` names. Do not create again without asking.

## Wait and save

Polling and downloading are free and never create jobs. The buyer routes them to the seller that accepted the job. Videos commonly take 1 to 10 minutes; this loop waits up to 20, prints progress every minute, and exits non-zero unless the video was saved.

```bash
job_file="${output%.*}.job.json"
model="$(jq -r .model "$job_file")"; job_id="$(jq -r .job_id "$job_file")"; output="$(jq -r .output "$job_file")"
case "$(jq -r .protocol "$job_file")" in
  venice-video) url="$proxy_url/api/v1/video/retrieve"; field=queue_id ;;
  fal-video)    url="$proxy_url/fal/v1/video/retrieve"; field=request_id ;;
esac
req="$(jq -n --arg model "$model" --arg id "$job_id" --arg f "$field" '{model: $model} + {($f): $id}')"
part="$(mktemp)"; fails=0; done_no_video=0; st=""; code=""; rc=1
if [ -s "$output" ] && [ "$(dd if="$output" bs=1 skip=4 count=4 2>/dev/null)" = ftyp ]; then
  echo "already saved: $output"; rc=0
else
  for i in $(seq 1 120); do
    read -r code type < <(curl -sS "$url" -H "$auth" -H 'content-type: application/json' \
      --data-binary "$req" -o "$part" -w '%{http_code} %{content_type}\n' 2>/dev/null || echo 000)
    if [ "$code" = 200 ] && [[ "$type" == video/mp4* ]] && [ "$(dd if="$part" bs=1 skip=4 count=4 2>/dev/null)" = ftyp ]; then
      mv "$part" "$output"; echo "saved $output"; rc=0; break
    fi
    case "$code" in
      200) st="$(jq -r '.status // empty' "$part" 2>/dev/null)"; fails=0
           case "$st" in
             FAILED|ERROR|CANCELLED|failed|error|cancelled)
               echo "job $job_id failed (status $st); not charged" >&2; jq -c '.error // empty' "$part" >&2; break ;;
             COMPLETED|completed) done_no_video=$((done_no_video + 1))
               [ "$done_no_video" -ge 3 ] && { echo "job $job_id reports $st but the seller sends no MP4; not charged" >&2; break; } ;;
           esac ;;
      429) st="download slot busy" ;;
      000|502|503|504) fails=$((fails + 1))
           [ "$fails" -ge 5 ] && { echo "proxy or seller unavailable (HTTP $code); job $job_id kept" >&2; break; } ;;
      *) echo "job $job_id stopped: HTTP $code; not charged" >&2
         jq -c '.error | if type == "object" then {code, type, peer_message, peer_status} else . end' "$part" >&2 2>/dev/null \
           || { head -c 300 "$part"; echo; } >&2
         break ;;
    esac
    [ $((i % 6)) = 0 ] && echo "waiting: $((i / 6)) min, ${st:-processing}"
    sleep 10
  done
  [ "$rc" = 0 ] || [ -n "$code" ] || echo "no response; job $job_id kept" >&2
fi
[ "$rc" = 0 ]
```

After the video is saved, delete the job file unless the user wants to keep it; while it exists, a new create with the same output name is refused. If the loop ends without a video, tell the user the job id and the last HTTP status; for `000`, `429`, or `5xx`, run this block again later to resume. A job that failed at the seller is not charged.

## Errors

On a failed create or wait, `error.peer_message` carries the seller's reason, including the field it rejected. Fix that field; another seller or model usually rejects it too.

- `402`: the buyer needs more deposited USDC or payment-channel capacity.
- `402 one_off_channel_required`: buyers before `@antseed/cli@0.1.171` hit this; update the buyer. Each failed attempt leaves a funded channel that `antseed buyer channels request-close <channelId>` releases.
- Price above $5.00, or "above the configured limit": choose a shorter duration or lower resolution.
- "Explicit video duration is required" or "No billing component matched": send an advertised `duration`, and an advertised `resolution` (exact case, for example `768P`) when the model lists any.
- `400` or `422` on wait, for example "does not support audio configuration" or "does not support end_image_url": the job failed at the seller and is not charged. Fix the field and ask before creating again. If the message names no field (for example "Request ID is invalid."), offer the next seller from the price list.
- `502 upstream_error` on create ("pinned peer could not complete the request"): that seller failed and no job started. Offer the next seller from the price list.
- `502` plain text "Pinned peer … is not reachable": usually the pinned seller does not sell that model, or is offline. Run [Price](#price) again and pin a seller from that list.
- `model_not_found`: fetch the catalog again and retry once after a few seconds; routing can briefly exclude a seller after a failed request.
- `404 video_route_not_found` on wait: the buyer has no record of this job (wrong id, or the buyer's record expired). Delete the job file; nothing is charged.
- `429 video_download_busy`: the buyer runs at most two status checks or downloads at once; the loop keeps waiting.
- `502 video_download_failed`: the seller could not reach the upstream video service; the loop retries it.
- Connection refused: start Antseed Desktop or `antseed buyer start`.
