# @antseed/provider-fal-image

Sells fal.ai image models through the OpenAI Images API. Buyers use any OpenAI images client; the seller translates each request to fal's own API (`POST https://fal.run/<endpoint>`) and the answer back.

## Configuration

```bash
antseed config seller add-provider fal-images --plugin fal-image
export FAL_IMAGE_API_KEY=<seller-fal-key>
```

- `FAL_IMAGE_API_KEY`: fal API key, sent as `Authorization: Key <key>`
- `FAL_IMAGE_BASE_URL`: optional, defaults to `https://fal.run`
- `ANTSEED_ALLOWED_SERVICES`: fal endpoint IDs such as `openai/gpt-image-2` or `fal-ai/nano-banana-pro` (64 characters at most). The service ID is the endpoint ID; aliases are not supported.
- `ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON`: `openai-images` pricing with `output_images`, optionally matched on `size`, `quality` or `resolution`
- `ANTSEED_SERVICE_IMAGE_EDIT_MODEL_MAP_JSON`: optional, service → fal edit endpoint (`imageEditModel` in the seller config), such as `openai/gpt-image-2` → `openai/gpt-image-2/edit`. Edits are billed with the service's own pricing.
- `ANTSEED_SERVICE_CAPABILITIES_JSON`: optional capabilities to advertise
- `FAL_IMAGE_MIN_BALANCE_USD`: optional, default `0`. Models stop being advertised while the fal balance is at or below it. Needs the key to have fal's `billing:usage:read` permission (see the `provider-fal-video` README).

```json
"fal-images": {
  "plugin": "fal-image",
  "apiKeyEnv": "FAL_API_KEY",
  "services": {
    "openai/gpt-image-2": {
      "imageEditModel": "openai/gpt-image-2/edit",
      "categories": ["image", "creative"],
      "unitBillingModels": {
        "openai-images": {
          "version": 1,
          "components": [
            { "unit": "output_images", "priceUsd": 0.06 },
            { "unit": "output_images", "priceUsd": 0.17, "match": { "quality": "high" } }
          ]
        }
      }
    }
  }
}
```

Each health sweep checks fal's model list for every service and its edit endpoint; one fal no longer lists, or reports with a status other than `active` or `deprecated`, stops the service being advertised.

## Requests

| Antseed path | fal call |
| --- | --- |
| `POST /v1/images/generations` (JSON) | `POST {base}/{model}` |
| `POST /v1/images/edits` (multipart, `image` or repeated `image[]`, optional `mask`) | `POST {base}/{edit endpoint}` with the images as data URLs in `image_urls` (or `image_url` for single-image endpoints) and the mask in `mask_url` |

OpenAI fields are mapped to fal's:

- `n` → `num_images` (a model without it takes `n: 1` only)
- `size` → `image_size`: `WxH` as `{width, height}`, or one of the model's preset names (`square_hd`, `landscape_16_9`, …). No size leaves fal's default size; `auto` is sent when the model's schema lists it as a preset, and otherwise also leaves the default.
- `quality`, `resolution` → the same fields, when the model takes them
- `moderation: "low"` → `enable_safety_checker: false`
- `response_format`: `b64_json` (default; fal answers with the images inline) or `url` (fal's public media URL)

`aspect_ratio`, `background`, `enable_safety_checker`, `negative_prompt`, `output_compression`, `output_format`, `safety_tolerance` and `seed` go to fal unchanged when the model takes them. Every other field is refused, as are fal's own `image_size`, `num_images`, `max_images`, `sync_mode`, `image_url(s)` and `mask_url`, so a request can't get a larger or extra image than the one it is billed for. A priced option the model does not take (for example `quality` on a model without it) is refused rather than ignored.

## Pricing

Price each service at fal's price for its dearest output for each billed option. A request that leaves out `size` or `quality` is billed as `auto`: price `auto` at what fal makes by default, or at its dearest choice when the model chooses (`quality: "auto"` on GPT Image). Options passed through unchanged, such as `aspect_ratio`, are not billing attributes, so price a model whose fal price depends on them at its dearest.
