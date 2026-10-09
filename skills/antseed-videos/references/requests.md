# Requests

Every command uses `curl` and `jq` against the local buyer proxy. Build JSON with `jq`; never interpolate unescaped prompts. Run each block in one shell; if your shell resets between commands, set the variables again from the job file.

```bash
proxy_url="${proxy_url:-${ANTSEED_PROXY_URL:-http://127.0.0.1:8377}}"
auth='authorization: Bearer antseed-desktop'
```

## Catalog

```bash
# Video models: id, sellers, frame inputs.
curl -sS --fail-with-body -H "$auth" "$proxy_url/v1/models?type=videos" \
  | jq -r '.data[] | [.id, (.peers | length), ((.peers[0].capabilities.video.inputs // []) | join("+"))] | @tsv'

# One model's offers: protocol, options, pricing.
model_file="$(mktemp)"
curl -sS --fail-with-body -H "$auth" \
  "$proxy_url/v1/models/$(jq -rn --arg id "$model" '$id|@uri')" > "$model_file"
jq '.peers[] | {peerId, protocol, video: .capabilities.video, price: .unitBillingModels[.protocol].components}' "$model_file"

# Image models for frames.
curl -sS --fail-with-body -H "$auth" "$proxy_url/v1/models?type=images" | jq -r '.data[].id'
```

Match the user's model case-insensitively against `id` and `aliases`. Several fal models share short aliases, so prefer an exact `id` and ask when an alias matches more than one model. `capabilities.video` lists `durationsSeconds`, `resolutions`, `aspectRatios`, `inputs`, `requiredInputs`, and `audio`; a missing field means unknown, not unsupported.

## Price

Lists the sellers that support the chosen duration and resolution with their price, cheapest first. A seller whose pricing has no component for the chosen resolution is left out, because the buyer refuses that request.

```bash
jq --argjson dur "$duration" --arg res "${resolution:-}" '
  [.peers[]
   | .capabilities.video as $v | .serviceId as $svc
   | select(($v.durationsSeconds // [$dur]) | index($dur))
   | select($res == "" or (($v.resolutions // [$res]) | index($res)))
   | [.unitBillingModels[.protocol].components[]
      | select((.match.resolution // $res) == $res and (.match.model // $svc) == $svc)] as $parts
   | select($parts | length > 0)
   | {peerId, protocol,
      priceUsd: ($parts | map(if .unit == "video_seconds" then .priceUsd * $dur
                              elif .unit == "video_generations" then .priceUsd else 0 end)
                        | add * 100 | round / 100)}]
  | map(select(.priceUsd <= 5)) | sort_by(.priceUsd)' "$model_file"
```

Pick the first entry and send `"<peerId>@<model>"` so the create goes to that seller. A bare model id applies the buyer's trust filter and can fail with `model_not_found` even when the model is listed. An empty list means no seller supports the options: choose an advertised duration or a lower resolution.

## Frames as data URLs

Local files must be sent inline. Frames over 1 MB are re-encoded as JPEG first, because a large upload can make the seller fail with "fetch failed". Write the data URL to a file, because a large frame does not fit on a command line.

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
  if [ "$(frame_mime "$out")" != image/jpeg ]; then echo "note: no image converter found; sending the frame as-is" >&2; echo "$src"
  elif [ "$(wc -c < "$out")" -lt "$(wc -c < "$src")" ]; then echo "$out"
  else echo "$src"; fi
}

# to_data_url <image> <out-file>
to_data_url() {
  mime="$(frame_mime "$1")"
  case "$mime" in image/png|image/jpeg|image/webp) ;; *) echo "unsupported frame: $1" >&2; return 1 ;; esac
  { printf 'data:%s;base64,' "$mime"; base64 < "$1" | tr -d '\n'; } > "$2"
}
first_url="$(mktemp)"; to_data_url "$(shrink_frame first-frame.png)" "$first_url"
last_url="$(mktemp)";  to_data_url "$(shrink_frame last-frame.png)" "$last_url"   # only when the model takes last_frame
```

Send only the frame inputs the seller advertises; Venice rejects `end_image_url` on models without `last_frame`.

## Create once

Check for a job file first. If `<output>.job.json` exists, go to [Wait and save](#wait-and-save) instead.

**`venice-video`**: duration is a string with an `s` suffix. Send `resolution`, `aspect_ratio`, and `audio` only when advertised and chosen.

```bash
output="${output:-generated-video.mp4}"; job_file="${output%.*}.job.json"
if [ -e "$job_file" ]; then
  echo "job exists: $job_file (resume it; do not create again)"
else
  body="$(mktemp)"; resp="$(mktemp)"
  jq -n --arg model "$route_model" --rawfile prompt prompt.txt --arg duration "${duration}s" \
    --arg resolution "${resolution:-}" --arg aspect_ratio "${aspect_ratio:-}" \
    --rawfile first "${first_url:-/dev/null}" --rawfile last "${last_url:-/dev/null}" '
    {model: $model, prompt: ($prompt | rtrimstr("\n")), duration: $duration}
    + (if $first != "" then {image_url: $first} else {} end)
    + (if $resolution != "" then {resolution: $resolution} else {} end)
    + (if $aspect_ratio != "" then {aspect_ratio: $aspect_ratio} else {} end)
    + (if $last != "" then {end_image_url: $last} else {} end)' > "$body" \
  && curl -sS "$proxy_url/api/v1/video/queue" -H "$auth" -H 'content-type: application/json' \
    --data-binary @"$body" -o "$resp" -w 'HTTP %{http_code}\n'
  job_id="$(jq -r '.queue_id // empty' "$resp" 2>/dev/null)"
  if [ -n "$job_id" ]; then
    jq -n --arg model "$model" --arg protocol venice-video --arg job_id "$job_id" --arg output "$output" \
      '{model: $model, protocol: $protocol, job_id: $job_id, output: $output}' > "$job_file"
    echo "queued $job_id -> $job_file"
  else
    jq -c '.error | if type == "object" then {type, peer_message, peer_status, message} else . end' "$resp" 2>/dev/null \
      || head -c 500 "$resp"
  fi
fi
```

**`fal-video`**: the body is the fal model's own input plus `model`. Most take `duration` as a plain string such as `"10"`; image fields are model-specific (`image_url`, `start_image_url`, `end_image_url`), so check the model's fal page when unsure. Use `/fal/v1/video/queue`, read the id from `.request_id`, and write the job file with `protocol: "fal-video"`.

Set `route_model` to `<peerId>@<model>` from [Price](#price). Write the prompt to `prompt.txt` first. `audio` is sent only when the user asked for a specific setting: add `+ {audio: true}` (or `false`).

A missing job id means the create failed and nothing started. Show the error to the user and fix the field `peer_message` names. Do not create again without asking.

## Wait and save

Polling and downloading are free and never create jobs. The buyer routes them to the seller that accepted the job. Videos commonly take 1 to 10 minutes; this loop waits up to 20.

```bash
job_file="${output%.*}.job.json"
model="$(jq -r .model "$job_file")"; job_id="$(jq -r .job_id "$job_file")"; output="$(jq -r .output "$job_file")"
case "$(jq -r .protocol "$job_file")" in
  venice-video) url="$proxy_url/api/v1/video/retrieve"; field=queue_id ;;
  fal-video)    url="$proxy_url/fal/v1/video/retrieve"; field=request_id ;;
esac
req="$(jq -n --arg model "$model" --arg id "$job_id" --arg f "$field" '{model: $model} + {($f): $id}')"
part="$(mktemp)"; fails=0; st=""
for _ in $(seq 1 120); do
  read -r code type < <(curl -sS "$url" -H "$auth" -H 'content-type: application/json' \
    --data-binary "$req" -o "$part" -w '%{http_code} %{content_type}\n' 2>/dev/null || echo 000)
  if [ "$code" = 200 ] && [[ "$type" == video/mp4* ]] && [ "$(dd if="$part" bs=1 skip=4 count=4 2>/dev/null)" = ftyp ]; then
    mv "$part" "$output"; echo "saved $output"; break
  fi
  case "$code" in
    200) st="$(jq -r '.status // empty' "$part" 2>/dev/null)"; fails=0
         case "$st" in FAILED|ERROR|CANCELLED) jq -c '{status, error}' "$part"; break ;; esac ;;
    000|429|502|503|504) fails=$((fails + 1)); [ "$fails" -ge 5 ] && { echo "proxy unavailable; job $job_id kept" >&2; break; } ;;
    *) jq -c '.error // .' "$part" 2>/dev/null | head -c 1000; echo; break ;;
  esac
  sleep 10
done
```

After the video is saved, keep or delete the job file as the user prefers. If the loop ends without a video, tell the user the job id; run this block again later to resume. A `FAILED` job ended and is not charged.

## Errors

On a failed create, `error.peer_message` carries the seller's reason, including the field it rejected. Fix that field; another seller or model usually rejects it too.

- `402`: the buyer needs more deposited USDC or payment-channel capacity.
- `402 one_off_channel_required`: buyers before `@antseed/cli@0.1.171` hit this; update the buyer. Each failed attempt leaves a funded channel that `antseed buyer channels request-close <channelId>` releases.
- Price above $5.00, or "above the configured limit": choose a shorter duration or lower resolution.
- "Explicit video duration is required" or "No billing component matched": send an advertised `duration`, and an advertised `resolution` (exact case, for example `768P`) when the model lists any.
- `model_not_found`: fetch the catalog again and retry once after a few seconds; routing can briefly exclude a seller after a failed request.
- `404` or `video_route_not_found` on wait: unknown job, or the file expired.
- `502 video_download_failed`: the seller could not reach the upstream video service; the loop retries it.
- Connection refused: start Antseed Desktop or `antseed buyer start`.
