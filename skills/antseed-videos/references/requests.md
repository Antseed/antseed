# Requests

Every command uses `curl` and `jq` against the local buyer proxy. Build JSON with `jq`; never interpolate unescaped prompts. Run each block in one shell; if your shell resets between commands, set the variables again from the job file.

```bash
proxy_url="${proxy_url:-${ANTSEED_PROXY_URL:-http://127.0.0.1:8377}}"
auth='authorization: Bearer antseed-desktop'
```

## Catalog

```bash
# Video models, from what each seller advertises. frames=yes lists image-to-video models;
# frames=ref lists reference-to-video models (images guide the subject or style, not the first frame);
# frames=edit lists video edit models (they take a source video: Edit a video, below);
# frames=no lists text-to-video models (only when the user asked to skip frames).
# id, frames, audio (yes / no / ? = not advertised), max height (px), max seconds, from price (lowest resolution; higher costs more: `$/s` per second, `$/clip` per video), sellers(reputation).
curl -sS --fail-with-body -H "$auth" "$proxy_url/v1/models?type=videos" | jq -r --arg frames "${frames:-yes}" '
  def px: ascii_downcase | if . == "4k" then 2160 elif . == "2k" then 1440
          else (capture("(?<n>[0-9]+)").n | tonumber) end;
  .data[] | [.peers[].capabilities.video // {}] as $v
  | ([$v[].inputs // [] | .[]] | unique) as $in
  | (if $in | index("video") then "edit" elif $in | index("first_frame") then "yes" elif $in | index("reference_image") then "ref" else "no" end) as $kind
  | select($kind == $frames)
  | (($in | index("last_frame")) or any(.peers[].capabilities.supportedParameters // [] | .[];
      IN("end_image_url", "tail_image_url", "last_frame_url", "last_image_url"))) as $last
  | [.id, (if $kind == "yes" and $last then "first+last" elif $kind == "yes" then "first" elif $kind == "ref" then "ref" elif $kind == "edit" then "edit" else "text" end),
     (if any($v[]; .audio == true) then "yes" elif all($v[]; .audio == false) then "no" else "?" end),
     ([$v[].resolutions // [] | .[] | px] | max // "?"),
     ([$v[].durationsSeconds // [] | .[]] | max // "?"),
     ([.peers[] | .unitBillingModels[.protocol].components[]?] as $c
      | ([$c[] | select(.unit == "video_seconds") | .priceUsd] | min) as $s
      | ([$c[] | select(.unit == "video_generations") | .priceUsd] | min) as $g
      | if $s then "$\($s)/s" elif $g then "$\($g)/clip" else "?" end),
     ([.peers[] | "\(.displayName // .peerId[0:8])(\(.reputationScore // 0 | floor))"] | join(" "))]
  | map(tostring) | @tsv'

# One model's offers: protocol, options, pricing.
model_file="$(mktemp)"
curl -sS --fail-with-body -H "$auth" \
  "$proxy_url/v1/models/$(jq -rn --arg id "$model" '$id|@uri')" > "$model_file"
jq '.peers[] | {peerId, protocol, video: .capabilities.video, fields: .capabilities.supportedParameters, price: .unitBillingModels[.protocol].components}' "$model_file"

# Image models for frames: id, inputs, $ per image (low-high), seller count, sellers that take output_format.
curl -sS --fail-with-body -H "$auth" "$proxy_url/v1/models?type=images" | jq -r '
  .data[] | [.id, ([.peers[].capabilities.inputs // [] | .[]] | unique | join("+")),
    "\([.peers[].minImageUsdPerImage // empty] | min // "?")-\([.peers[].maxImageUsdPerImage // empty] | max // "?")",
    (.peers | length),
    ([.peers[] | select(.capabilities.supportedParameters // [] | index("output_format"))] | length)]
  | map(tostring) | @tsv'
```

Match the user's model case-insensitively against `id` and `aliases`. Several fal models share short aliases, so prefer an exact `id` and ask when an alias matches more than one model. `capabilities.video` lists `durationsSeconds`, `resolutions`, `aspectRatios`, `inputs`, `requiredInputs`, and `audio`; a missing field means unknown, not unsupported. `fields` (`capabilities.supportedParameters`) lists the request fields the seller's model takes, with the upstream API's own names (for example `start_image_url` on fal's Kling V3, `generate_audio` on fal, `audio` on Venice). Show it to the user with the offer. A seller that lists no `fields` runs an older plugin: for `fal-video`, [Create once](#create-once) reads the field names from fal's public schema instead, because some fal models (Kling V3, Wan 3.0) require `start_image_url`; Venice sellers take the common names.

## Price

Lists the sellers that support every chosen option, with their price, cheapest first. Set `last_frame=yes` when a last frame is sent, `refs=yes` when reference images are sent, and `aspect_ratio` to the agreed video ratio (for example `16:9`). A seller is left out when its pricing has no component for the chosen resolution (the buyer refuses that request), when a last frame is sent and it neither advertises `last_frame` nor lists an end-frame field in `fields` (Venice accepts `end_image_url` at create and fails the job later), when reference images are sent and it does not advertise `reference_image` (or they are not sent and it requires them), or when it lists `aspectRatios` without the chosen ratio. A seller that lists no `aspectRatios` is kept. `sendRatio` says whether to send `aspect_ratio` to that seller ([Aspect ratio](#aspect-ratio)), and `fields` is the seller's field list.

```bash
jq --argjson dur "$duration" --arg res "${resolution:-}" \
   --arg last "${last_frame:-}" --arg refs "${refs:-}" --arg ratio "${aspect_ratio:-}" '
  [.peers[]
   | .capabilities.video as $v | .serviceId as $svc
   | select(($v.durationsSeconds // [$dur]) | index($dur))
   | select($res == "" or (($v.resolutions // [$res]) | index($res)))
   | select($last != "yes" or ($v.inputs // [] | index("last_frame"))
            or any(.capabilities.supportedParameters // [] | .[];
                   IN("end_image_url", "tail_image_url", "last_frame_url", "last_image_url")))
   | select(if $refs == "yes" then ($v.inputs // [] | index("reference_image")) != null
            else ($v.requiredInputs // [] | index("reference_image")) == null end)
   | select($ratio == "" or (($v.aspectRatios // [$ratio]) | index($ratio)))
   | [.unitBillingModels[.protocol].components[]
      | select((.match.resolution // $res) == $res and (.match.model // $svc) == $svc)] as $parts
   | select($parts | length > 0)
   | {peerId, protocol,
      fields: (.capabilities.supportedParameters // []),
      sendRatio: ($ratio != "" and (($v.aspectRatios // []) | index($ratio)) != null
                  and ((.capabilities.supportedParameters // ["aspect_ratio"]) | index("aspect_ratio")) != null),
      priceUsd: ($parts | map(if .unit == "video_seconds" then .priceUsd * $dur
                              elif .unit == "video_generations" then .priceUsd else 0 end)
                        | add * 1000 | round / 1000)}]
  | map(select(.priceUsd <= 5)) | sort_by(.priceUsd)' "$model_file"
```

Pick the first entry and send `"<peerId>@<model>"` so the create goes to that seller. A bare model id applies the buyer's trust filter and can fail with `model_not_found` even when the model is listed. Keep the list: if the create fails at the seller, offer the next entry.

An empty list means no seller supports the options. Choose an advertised duration or a lower resolution.

## Aspect ratio

One rule for every model: send `aspect_ratio` only when the chosen seller lists that ratio in `aspectRatios` and, if it lists `fields`, lists `aspect_ratio` there too (`sendRatio: true` in [Price](#price)). Otherwise do not send it, and the frame's shape sets the video's shape. Image-to-video models that take the ratio from the frame (for example Seedance on Venice) list no ratios, so the rule covers them. If a job fails and `peer_message` names `aspect_ratio`, the seller needs it even though it lists none: ask, then create again with the frame's ratio. Reference images do not set the shape, so a reference-to-video video gets the default ratio when `aspect_ratio` is not sent; pick a seller with `sendRatio: true`.

So the frame must already have the video's shape. Ask for the agreed ratio when making frames, then always check each saved frame with `frame_size` and crop it with `fit_frame` ([Frame shape](#frame-shape)).

## Frame shape

Prints a frame's `<width>x<height>` without loading the image into the chat.

```bash
frame_size() {
  if command -v sips >/dev/null 2>&1; then
    sips -g pixelWidth -g pixelHeight "$1" 2>/dev/null | awk '/pixelWidth/ {w=$2} /pixelHeight/ {h=$2} END {if (w) print w "x" h}'
  elif command -v magick >/dev/null 2>&1; then magick identify -format '%wx%h\n' "$1"
  elif command -v ffprobe >/dev/null 2>&1; then ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$1"
  elif command -v python3 >/dev/null 2>&1; then python3 -c 'import sys; from PIL import Image; w, h = Image.open(sys.argv[1]).size; print(f"{w}x{h}")' "$1"
  else file "$1"
  fi
}
```

Image models often ignore the requested ratio (for example flux-2-pro returns 4:3 when asked for 16:9), so run `fit_frame` on every frame as a normal step, not only when something looks wrong. `fit_frame` center-crops a frame to a ratio and leaves one within 1% of it unchanged. Write the output with the same extension as the source. Show the cropped frame to the user; if the crop cuts off the subject, make the frame again instead. When no image tool is found, `fit_frame` fails: tell the user and ask whether to install one.

```bash
# fit_frame <image> <W:H> <out>
fit_frame() {
  size="$(frame_size "$1")"
  case "$size" in ''|*[!0-9x]*) echo "cannot read frame size: $1" >&2; return 1 ;; esac
  w="${size%x*}"; h="${size#*x}"; rw="${2%:*}"; rh="${2#*:}"
  diff=$((w * rh - h * rw)); [ "$diff" -lt 0 ] && diff=$((-diff))
  if [ $((diff * 100)) -le $((h * rw)) ]; then cp "$1" "$3" && echo "$3: $size"; return; fi
  if [ $((w * rh)) -gt $((h * rw)) ]; then nw=$((h * rw / rh)); nh=$h; else nw=$w; nh=$((w * rh / rw)); fi
  if command -v sips >/dev/null 2>&1; then sips -c "$nh" "$nw" "$1" --out "$3" >/dev/null 2>&1
  elif command -v magick >/dev/null 2>&1; then magick "$1" -gravity center -crop "${nw}x${nh}+0+0" +repage "$3"
  elif command -v ffmpeg >/dev/null 2>&1; then ffmpeg -loglevel error -y -i "$1" -vf "crop=$nw:$nh" -frames:v 1 "$3"
  elif command -v python3 >/dev/null 2>&1; then python3 -c 'import sys; from PIL import Image; i = Image.open(sys.argv[1]); w, h, nw, nh = map(int, sys.argv[3:]); l, t = (w - nw) // 2, (h - nh) // 2; i.crop((l, t, l + nw, t + nh)).save(sys.argv[2])' "$1" "$3" "$w" "$h" "$nw" "$nh"
  else echo "no image tool to crop $1" >&2; return 1
  fi && echo "$3: $(frame_size "$3")"
}
```

## Frames as data URLs

Local files must be sent inline. Send the original frames, without re-encoding or resizing. Only if the create is rejected for size (HTTP 413, `request_too_large`, or another body-size error), tell the user, rebuild the data URLs with `shrink_frame` (frames over 1 MB re-encoded as JPEG), and create again. When no converter is found (`sips`, ImageMagick, `ffmpeg`, or `python3` with Pillow), `shrink_frame` fails: tell the user and ask whether to install one or use a smaller frame. Write the data URL to a file, because a large frame does not fit on a command line.

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
first_url="$(mktemp)"; to_data_url first-frame.png "$first_url"
if [ -e last-frame.png ]; then last_url="$(mktemp)"; to_data_url last-frame.png "$last_url"; fi
```

Send only the frame inputs the seller advertises.

For a reference-to-video model, put the reference images in a `ref_images` array instead of `first-frame.png`. Each becomes one entry of a JSON list (`refs_json`), in the order given; the prompt can name them as `@Image1`, `@Image2`, and so on where the model supports it. Use no more images than the model's upstream limit (Venice allows 30; fal models often 4 to 7), and leave `first_url` unset.

```bash
refs_json="$(mktemp)"; echo '[]' > "$refs_json"
for ref in "${ref_images[@]}"; do
  ref_url="$(mktemp)"; to_data_url "$ref" "$ref_url" || break
  jq --rawfile url "$ref_url" '. + [$url]' "$refs_json" > "$refs_json.tmp" && mv "$refs_json.tmp" "$refs_json"
done
unset first_url last_url
echo "references: $(jq length "$refs_json")"
```

## Create once

Check for a job file first. If `<output>.job.json` exists, go to [Wait and save](#wait-and-save) instead. Set `protocol` and `peer_id` from the chosen [Price](#price) entry and `route_model` to `<peerId>@<model>`. Write the prompt to `prompt.txt` first. Set `aspect_ratio` only when the chosen Price entry has `sendRatio: true`; otherwise leave it unset ([Aspect ratio](#aspect-ratio)). Set `audio=false` only when the user wants a silent video and the seller advertises `audio`; never send `audio=true`, because many models make sound by default and fail the job when `audio` is set. Before an approved retry after a failed job, rename `<name>.job.json` to `<name>.failed.job.json`.

Send each field under the name the seller lists in `fields` ([Price](#price)); the seller passes the body to its upstream API unchanged. The block below takes the frame, reference and audio field names from that list and prints them. Check them against the list before the create. When a `fal-video` seller lists no `fields`, the block reads the model's field names from fal's public schema (free, no key) and picks from those. Otherwise, with no list, it uses `image_url` and `end_image_url`, and the audio switch only if the seller advertises `audio` (`generate_audio` on fal). Prefer the listed name; fall back to the common name only when the seller lists no name for that input. A field missing from `fields` is not proof the model refuses it (the list can be incomplete), so a field the user needs may still be sent under its common name; a `400` on create then says the seller refused it and nothing was charged.

```bash
schema_fields='[]'
if [ "$protocol" = fal-video ] && [ "$(jq --arg peer "$peer_id" '[.peers[] | select(.peerId == $peer) | .capabilities.supportedParameters // [] | length] | first // 0' "$model_file")" = 0 ]; then
  schema_fields="$(curl -sS --max-time 20 "https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=$model" \
    | jq -c '[.components.schemas[] | select(.properties.prompt) | .properties | keys[]] | unique' 2>/dev/null)"
  [ -n "$schema_fields" ] || schema_fields='[]'
fi
read -r first_field last_field ref_field audio_field < <(jq -r --arg peer "$peer_id" --argjson schema "$schema_fields" '
  (.peers[] | select(.peerId == $peer)) as $o
  | ($o.capabilities.supportedParameters // [] | if length > 0 then . else $schema end) as $p
  | def pick(names): (names | map(select(. as $n | $p | index($n))) | first) // (if ($p | length) > 0 then "-" else names[0] end);
    [pick(["image_url", "start_image_url", "first_frame_url", "first_image_url"]),
     pick(["end_image_url", "tail_image_url", "last_frame_url", "last_image_url"]),
     pick(["reference_image_urls", "image_urls"]),
     (if ($p | length) > 0 then pick(["audio", "generate_audio"])
      elif $o.capabilities.video.audio == true then (if $o.protocol == "fal-video" then "generate_audio" else "audio" end)
      else "-" end)] | join(" ")' "$model_file")
[ "$audio_field" = - ] && audio=""
echo "fields: first=$first_field last=$last_field references=$ref_field audio=$audio_field aspect_ratio=${aspect_ratio:-not sent}"
```

`-` means the seller lists no such field: do not send that input. A missing field for a frame or reference images the user has means the wrong seller or model; pick another from [Price](#price).

- **`venice-video`**: duration is a string with an `s` suffix (`"5s"`).
- **`fal-video`**: duration is a plain string (`"5"`).

```bash
output="${output:-generated-video.mp4}"; job_file="${output%.*}.job.json"
if [ -e "$job_file" ]; then
  echo "job exists: $job_file (resume it; do not create again)"
elif { [ -n "${first_url:-}" ] && [ "${first_field:-}" = - ]; } || { [ -n "${last_url:-}" ] && [ "${last_field:-}" = - ]; } \
  || { [ -n "${refs_json:-}" ] && [ "${ref_field:-}" = - ]; }; then
  echo "this seller lists no field for a frame or reference images you have; pick another seller" >&2; false
else
  case "$protocol" in
    venice-video) queue_path=/api/v1/video/queue; id_field=queue_id; dur="${duration}s" ;;
    fal-video)    queue_path=/fal/v1/video/queue; id_field=request_id; dur="$duration" ;;
  esac
  body="$(mktemp)"; resp="$(mktemp)"
  jq -n --arg model "$route_model" --rawfile prompt prompt.txt --arg duration "$dur" \
    --arg resolution "${resolution:-}" --arg aspect_ratio "${aspect_ratio:-}" --arg audio "${audio:-}" --arg audio_field "$audio_field" \
    --arg first_field "${first_field:-image_url}" --arg last_field "${last_field:-end_image_url}" --arg ref_field "${ref_field:-reference_image_urls}" \
    --rawfile first "${first_url:-/dev/null}" --rawfile last "${last_url:-/dev/null}" --slurpfile refs "${refs_json:-/dev/null}" '
    {model: $model, prompt: ($prompt | rtrimstr("\n")), duration: $duration}
    + (if $first != "" then {($first_field): $first} else {} end)
    + (if $last != "" then {($last_field): $last} else {} end)
    + (if ($refs[0] // []) != [] then {($ref_field): $refs[0]} else {} end)
    + (if $resolution != "" then {resolution: $resolution} else {} end)
    + (if $aspect_ratio != "" then {aspect_ratio: $aspect_ratio} else {} end)
    + (if $audio != "" then {($audio_field): ($audio == "true")} else {} end)' > "$body"
  code="$(curl -sS "$proxy_url$queue_path" -H "$auth" -H 'content-type: application/json' -H 'Expect:' \
    --data-binary @"$body" -o "$resp" -w '%{http_code}' || true)"
  job_id="$(jq -r --arg f "$id_field" '.[$f] // empty' "$resp" 2>/dev/null)"
  if [ -n "$job_id" ]; then
    jq -n --arg model "$model" --arg protocol "$protocol" --arg job_id "$job_id" --arg output "$output" \
      '{model: $model, protocol: $protocol, job_id: $job_id, output: $output}' > "$job_file"
    echo "queued $job_id -> $job_file"
  elif [ "$code" = 000 ]; then
    echo "create got no answer; the job may have started. Do not create again without asking the user" >&2
    false
  else
    echo "create failed: HTTP $code" >&2
    jq -c '.error | if type == "object" then {code, message, type, peer_message, peer_status} else . end' "$resp" 2>/dev/null \
      || { head -c 300 "$resp"; echo; } >&2
    false
  fi
fi
```

A missing job id after an HTTP answer means the create failed, nothing started, and nothing was charged. Show the error to the user and fix the field `peer_message` names. Do not create again without asking. With no answer at all (HTTP `000`, for example a dropped connection), the job may have started at the seller: tell the user, and do not create again unless they agree to risk paying for a second video. If it was rejected for size, use the `shrink_frame` fallback in [Frames as data URLs](#frames-as-data-urls). The `-H 'Expect:'` stops curl from sending `Expect: 100-continue` on bodies over 1 MiB, which makes sellers fail with "fetch failed".

## Wait and save

Every status answer has one `status`: `processing`, `failed` (with `error`; `video_not_delivered` when the seller says the job is done but sends no MP4), `unknown` (the seller answered but could not read the job's state; poll again), or `seller_unreachable` (HTTP 502/504; the seller could not be reached and the job is kept). `upstream_status` keeps the seller's own word. Polling never creates jobs or charges anything. The video's price is charged once, when it is first downloaded; downloading it again does not charge again. The buyer routes them to the seller that accepted the job. Videos commonly take 1 to 10 minutes; this loop waits up to 20, prints progress every minute, and exits non-zero unless the video was saved.

```bash
job_file="${output%.*}.job.json"
model="$(jq -r .model "$job_file")"; job_id="$(jq -r .job_id "$job_file")"; output="$(jq -r .output "$job_file")"
case "$(jq -r .protocol "$job_file")" in
  venice-video) url="$proxy_url/api/v1/video/retrieve"; field=queue_id ;;
  fal-video)    url="$proxy_url/fal/v1/video/retrieve"; field=request_id ;;
esac
req="$(jq -n --arg model "$model" --arg id "$job_id" --arg f "$field" '{model: $model} + {($f): $id}')"
part="$(mktemp)"; fails=0; unknowns=0; done_no_video=0; st=""; code=""; rc=1
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
             unknown) unknowns=$((unknowns + 1))
               [ "$unknowns" -ge 30 ] && { echo "seller cannot read job $job_id status for 5 min; job kept" >&2; break; } ;;
             processing|PROCESSING|IN_QUEUE|IN_PROGRESS) unknowns=0 ;;
             FAILED|ERROR|CANCELLED|failed|error|cancelled)
               echo "job $job_id failed (status $st); the video is not charged (a price above \$1.00 keeps the opening fee)" >&2; jq -c '.error // empty' "$part" >&2; break ;;
             COMPLETED|completed) done_no_video=$((done_no_video + 1))
               [ "$done_no_video" -ge 3 ] && { echo "job $job_id reports $st but the seller sends no MP4; not charged" >&2; break; } ;;
           esac ;;
      429) st="download slot busy" ;;
      000|502|503|504) fails=$((fails + 1)); st="$(jq -r '.status // empty' "$part" 2>/dev/null)"
           [ "$fails" -ge 5 ] && { echo "${st:-proxy or seller} unavailable (HTTP $code); job $job_id kept" >&2; break; } ;;
      *) echo "job $job_id stopped: HTTP $code; the video is not charged" >&2
         jq -c '.error | if type == "object" then {code, message, type, peer_message, peer_status} else . end' "$part" >&2 2>/dev/null \
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

The `COMPLETED|completed` branch is for older buyers; newer buyers report `failed` with `video_not_delivered` instead. After the video is saved, delete the job file unless the user wants to keep it; while it exists, a new create with the same output name is refused. If the loop ends without a video, tell the user the job id and the last HTTP status; for `000`, `429`, or `5xx`, run this block again later to resume. A job that failed at the seller is not charged for the video; for a video priced above $1.00 the opening fee ($0.65 on Base) is kept, and the rest of the reserve is released at once.

## Edit a video

A video edit model takes a source video (`video` in `inputs`) and changes part of it: a new character from an image, a new style, or a text instruction. The output follows the source's motion, timing, and camera. Run [Catalog](#catalog) with `frames=edit` to list them.

### Source

Read the length without opening the file. MOV and other MP4-family files that are not fast-start are remuxed (no re-encode, no quality change), so the seller can read the length quickly.

```bash
source_video="dance.mov"   # in Antseed Desktop: the path from get_chat_video_path
src="$(mktemp -d)/source.mp4"
codec="$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$source_video")" \
  || { echo "ffprobe could not read $source_video" >&2; false; }
case "$codec" in
  h264|hevc|mpeg4) ffmpeg -loglevel error -y -i "$source_video" -map 0:v:0 -map '0:a:0?' -c copy -movflags +faststart "$src" ;;
  # WebM, VP9, AV1 and others: the sellers read only MP4 with H.264/H.265, so re-encode (tell the user).
  *) ffmpeg -loglevel error -y -i "$source_video" -map 0:v:0 -map '0:a:0?' -c:v libx264 -crf 18 -preset medium -c:a aac -movflags +faststart "$src" ;;
esac || { echo "ffmpeg could not convert $source_video" >&2; false; }
seconds="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$src")" && [ -n "$seconds" ] \
  || { echo "could not read the source length" >&2; false; }
IFS=, read -r width height fps < <(ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate -of csv=p=0 "$src")
duration="$(awk -v s="$seconds" 'BEGIN { d = int(s); if (d < 1) d = 1; print d }')"
echo "source: $(wc -c < "$src" | tr -d ' ') bytes, ${seconds}s, ${width}x${height} at ${fps} fps -> duration $duration"
```

`duration` is the source length in whole seconds, rounded down. It is what the buyer pays for, and the seller refuses any other value before payment, with `invalid_video_duration` and the value to send. On fal, Kling v4 edit and Wan 2.7 edit cut the output to their own `duration`, so a shorter value is allowed there, never a longer one. On Venice every edit model, Wan included, needs exactly the source length. fal's Recast takes no `duration`: the seller checks it and removes it before sending.

Check the source against the model's limits before pricing it ([prompting.md](prompting.md#editing-a-video)): length, size (`width`x`height`), aspect ratio, and frame rate (`fps` above is a fraction such as `24/1`). The seller refuses a source outside them for free, with the limit in the message. Too long: trim it, then measure again. Too small (Kling v4 edit needs at least 700x700): scale it up. Wrong frame rate (Kling v4 edit takes 24 to 60): re-encode it.

```bash
ffmpeg -loglevel error -y -i "$src" -t 30 -c copy -movflags +faststart "${src%.mp4}-cut.mp4" && src="${src%.mp4}-cut.mp4"
# Scale so the short side is at least 720, keeping the shape (re-encodes):
ffmpeg -loglevel error -y -i "$src" -vf "scale='if(lt(iw,ih),720,-2)':'if(lt(iw,ih),-2,720)'" -r 24 -c:v libx264 -crf 18 -c:a copy -movflags +faststart "${src%.mp4}-720.mp4" && src="${src%.mp4}-720.mp4"
```

A source too long for the $5.00 limit is refused by the price step (and by the buyer), not by the seller: trim it or pick a cheaper model or resolution.

### Inline or URL

Send the source inline as a data URL when it fits, otherwise as a public `https` URL the user gives you (a file they already host). The buyer never uploads files anywhere else.

- **`venice-video`**: the whole request must be at most 32.5 MB, character images included, so the raw video at most about 24 MB less the images (base64 adds a third).
- **`fal-video`**: up to the Antseed request limit of 64 MiB, so the raw video at most about 47 MB, and within the model's own file limit.

Too large for inline and no URL: re-encode a smaller copy, and tell the user it is re-encoded.

```bash
ffmpeg -loglevel error -y -i "$src" -c:v libx264 -crf 23 -preset medium -c:a aac -b:a 128k -movflags +faststart "${src%.mp4}-small.mp4" && src="${src%.mp4}-small.mp4"
video_url="$(mktemp)"; { printf 'data:video/mp4;base64,'; base64 < "$src" | tr -d '\n'; } > "$video_url"
echo "video part about $(( $(wc -c < "$video_url") / 1000000 )) MB (check the whole body after building it below)"
```

For a URL instead: `video_url="$(mktemp)"; printf '%s' "https://example.com/dance.mp4" > "$video_url"`.

### Character images

For a character swap, put one clear image per person to replace in `ref_images`, in the order the people appear from left to right, and build `refs_json` as in [Frames as data URLs](#frames-as-data-urls). Then run [Price](#price) with `refs=yes` and the `duration` above. A model that requires a character (`requiredInputs` has `reference_image`) is left out when none is sent.

fal's motion control takes a character image of at least 340x340, aspect ratio 0.4 to 2.5, up to 10 MB; the seller refuses an inline image outside that with `invalid_image_input`, for free.

### Create the edit

Check for a job file first, exactly as in [Create once](#create-once). The field names come from the seller's `fields`: the character goes in `reference_image_urls` when listed (Recast), then `image_urls`, otherwise in `image_url` as one image (motion control). Put other fields the model needs in `extra.json` (for example `{"character_orientation": "video"}` for fal's motion control). `duration` is a number (seconds) on fal and the string `"<n>s"` on Venice. `prompt` is optional for Recast, required for motion control on Venice and for Kling and Wan edits; the seller refuses a missing one before payment. `resolution` must be one the seller lists, in the same case (`768P`/`1080P` for Recast, `720p`/`1080p` for Kling and Wan); the price `match` uses the same values.

```bash
output="${output:-edited-video.mp4}"; job_file="${output%.*}.job.json"
[ -e extra.json ] || echo '{}' > extra.json
[ -e prompt.txt ] || : > prompt.txt
ref_field="$(jq -r --arg peer "$peer_id" '(.peers[] | select(.peerId == $peer) | .capabilities.supportedParameters // []) as $p
  | if ($p | index("reference_image_urls")) then "reference_image_urls" elif ($p | index("image_urls")) then "image_urls"
    elif ($p | index("image_url")) then "image_url" else "reference_image_urls" end' "$model_file")"
if [ -e "$job_file" ]; then
  echo "job exists: $job_file (resume it; do not create again)"
else
  case "$protocol" in
    venice-video) queue_path=/api/v1/video/queue; id_field=queue_id ;;
    fal-video)    queue_path=/fal/v1/video/queue; id_field=request_id ;;
  esac
  body="$(mktemp)"; resp="$(mktemp)"
  jq -n --arg model "$route_model" --arg protocol "$protocol" --argjson duration "$duration" \
    --rawfile prompt prompt.txt --rawfile video "$video_url" --arg resolution "${resolution:-}" \
    --arg ref_field "$ref_field" --slurpfile refs "${refs_json:-/dev/null}" --slurpfile extra extra.json '
    {model: $model, video_url: $video,
     duration: (if $protocol == "venice-video" then "\($duration)s" else $duration end)}
    + (if ($prompt | rtrimstr("\n")) != "" then {prompt: ($prompt | rtrimstr("\n"))} else {} end)
    + (if ($refs[0] // []) == [] then {}
       elif $ref_field == "image_url" then {image_url: $refs[0][0]}
       else {($ref_field): $refs[0]} end)
    + (if $resolution != "" then {resolution: $resolution} else {} end)
    + ($extra[0] // {})' > "$body"
  echo "request body: $(( $(wc -c < "$body") / 1000000 )) MB"   # Venice: at most 32.5 MB in total
  code="$(curl -sS "$proxy_url$queue_path" -H "$auth" -H 'content-type: application/json' -H 'Expect:' \
    --data-binary @"$body" -o "$resp" -w '%{http_code}' || true)"
  job_id="$(jq -r --arg f "$id_field" '.[$f] // empty' "$resp" 2>/dev/null)"
  if [ -n "$job_id" ]; then
    jq -n --arg model "$model" --arg protocol "$protocol" --arg job_id "$job_id" --arg output "$output" \
      '{model: $model, protocol: $protocol, job_id: $job_id, output: $output}' > "$job_file"
    echo "queued $job_id -> $job_file"
  elif [ "$code" = 000 ]; then
    echo "create got no answer; the job may have started. Do not create again without asking the user" >&2
    false
  else
    echo "create failed: HTTP $code" >&2
    jq -c '.error | if type == "object" then {code, message, type, peer_message, peer_status} else . end' "$resp" 2>/dev/null \
      || { head -c 300 "$resp"; echo; } >&2
    false
  fi
fi
```

Then [Wait and save](#wait-and-save). The upload of a large source takes a while (the buyer sends it twice: once to get the price, once after opening the payment channel); a create that takes a minute is normal. Recast often takes 15 minutes or more to finish; Venice's Wan edit adds an audio track to the output.

## Multi-clip videos

For a video longer than one clip, make the clips one after another, each from the previous clip's last frame, then join them. Each clip is its own approved, paid video: show the user the price for every clip up front, and create the next clip only after the previous one is saved.

1. Make clip 1 as usual, with its own output name (`clip1.mp4`, so its job file is `clip1.job.json`).
2. Take clip 1's last frame and crop it to the video's ratio. Video models can return a size slightly off the ratio (for example 736x400 for 16:9), so crop it like any frame:

   ```bash
   ffmpeg -loglevel error -y -sseof -0.5 -i clip1.mp4 -update 1 -frames:v 1 clip1-last.jpg
   fit_frame clip1-last.jpg 16:9 clip2-first.jpg
   ```

3. Make clip 2 with `clip2-first.jpg` as its first frame and `output=clip2.mp4`. Its prompt continues the motion and camera from where clip 1 ends ([prompting.md](prompting.md#image-to-video-the-frame-already-sets-the-look)). Repeat for more clips.
4. Join the clips. Some MP4s (Venice) carry an attached cover image as an extra stream, which breaks a plain `ffmpeg -c copy` join, so map only the first video and audio streams:

   ```bash
   printf "file '%s'\n" "$PWD"/clip1.mp4 "$PWD"/clip2.mp4 > clips.txt
   ffmpeg -loglevel error -y -f concat -safe 0 -i clips.txt -map 0:v:0 -map '0:a:0?' -c copy final.mp4
   ```

   If the clips differ in size, frame rate, or codec, or the joined video stutters at the cut, re-encode instead:

   ```bash
   ffmpeg -loglevel error -y -i clip1.mp4 -i clip2.mp4 \
     -filter_complex "[0:v:0][0:a:0][1:v:0][1:a:0]concat=n=2:v=1:a=1[v][a]" -map "[v]" -map "[a]" final.mp4
   ```

   For clips without sound, drop the audio parts (`'0:a:0?'` is already optional; in the re-encode use `[0:v:0][1:v:0]concat=n=2:v=1:a=0[v]` and `-map "[v]"`).

## Errors

On a failed create or wait, `error.peer_message` carries the seller's reason, including the field it rejected. Fix that field; another seller or model usually rejects it too.

- `400` on create whose `peer_message` names fields, for example "Unrecognized key(s) in object: 'bogus_field'; aspect_ratio: This model does not support aspect_ratio": the seller rejected the body, no job started, and nothing was charged. Remove or fix each named field and ask before creating again. The buyer only logs a warning for a field the seller does not list and still forwards it, so this `400` is where an unlisted field shows up. `error.code` can be empty, with the seller's reason in `error.type`.
- `402`: the buyer needs more deposited USDC or payment-channel capacity.
- `402 one_off_channel_required`: buyers before `@antseed/cli@0.1.171` hit this; update the buyer. Each failed attempt leaves a funded channel that `antseed buyer channels request-close <channelId>` releases.
- Price above $5.00, or "above the configured limit": choose a shorter duration or lower resolution.
- "Explicit video duration is required" or "No billing component matched": send an advertised `duration`, and an advertised `resolution` (exact case, for example `768P`) when the model lists any. Neither the buyer nor the seller checks `duration` against `durationsSeconds`; the upstream does, and its answer can name another field (one unlisted duration came back as "Invalid or missing prompt"), so only send a listed duration.
- `400` or `422` on wait, for example "does not support audio configuration" or "does not support end_image_url": the job failed at the seller and is not charged. Fix the field and ask before creating again. If the message names no field (for example "Request ID is invalid."), offer the next seller from the price list.
- `502 upstream_error` on create ("pinned peer could not complete the request"): that seller failed and no job started. Offer the next seller from the price list.
- `502` plain text "Pinned peer … is not reachable" or "Pinned peer … does not support this request": usually the pinned seller does not sell that model, or is offline. Run [Price](#price) again and pin a seller from that list.
- `model_not_found`: fetch the catalog again and retry once after a few seconds; routing can briefly exclude a seller after a failed request.
- `video_not_delivered` on wait: the seller says the job finished but sends no video. Nothing is charged. Waiting longer or trying the same seller again will most likely fail the same way, so rename the job file to `<name>.failed.job.json` and offer the next seller from the price list; create with it once the user agrees.
- `404 video_route_not_found` on wait: the buyer has no record of this job (wrong id, or the buyer's record expired). Delete the job file; nothing is charged.
- `429 video_download_busy`: the buyer runs at most two status checks or downloads at once; the loop keeps waiting.
- `status: unknown`: the seller is up but could not read the job's state from its video service; the loop keeps polling and stops after 5 minutes of it, keeping the job.
- `502 status: seller_unreachable`: the seller holding the job could not be reached; the loop retries it, then keeps the job so it can resume later.
- `502 video_download_failed` without a `status`: the seller started sending the video and the stream broke; the loop retries it.
- `400 invalid_video_duration` on an edit: `duration` is not the source length. The message gives the value to send (`"duration": 12`). Nothing was charged.
- `400 invalid_video_source`: the seller could not read the source (not an MP4/MOV, a data URL not labelled `video/mp4`, a broken file, a URL that is not public `https`, or a length, size, aspect ratio, or frame rate outside the model's limits; the message says which). Remux, trim, scale, or re-encode it ([Edit a video](#edit-a-video)).
- `400 invalid_image_input`: an inline character image is outside the model's image limits (size, aspect ratio, bytes). Use a larger or less extreme image.
- `400 unsupported_parameter` naming `video_url`, or `422 required_capability_unavailable` from a pinned seller: that model does not take a source video. Pick one from the `frames=edit` catalog.
- `400 video_source_unavailable`: the seller could not fetch the source URL (not found, not public, or too slow). Check the URL opens in a browser without signing in, or send the file inline.
- `504 upstream_upload_timeout`: the seller could not hand the request to fal in time. Nothing was charged; send a smaller file or a URL.
- Job `FAILED` after it started (for example Venice "No person detected" from motion control or Recast): the source has no real person, or the upstream rejected it. The job's payment channel is closed at once; a video priced above $1.00 costs the opening fee ($0.65 on Base), a cheaper one nothing.
- `413 video_source_too_large`: the source file is larger than the model accepts. Re-encode a smaller copy.
- `413 request_too_large`: the request body is larger than the seller's upstream accepts (Venice: 32.5 MB). Re-encode a smaller copy or send a public `https` URL.
- `400 missing_required_field`: the model needs a field that was not sent (for example `reference_image_urls` on Recast, or `character_orientation` on fal's motion control). Add it.
- `422 required_capability_unavailable` naming `video_url`: no seller of that model takes a source video. Pick a model from the `frames=edit` catalog.
- `429 video_check_busy`: the seller is checking too many source URLs at once. Wait a minute and send the same create again; nothing started.
- Connection refused: start Antseed Desktop or `antseed buyer start`.
