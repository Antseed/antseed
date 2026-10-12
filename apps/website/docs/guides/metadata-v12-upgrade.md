---
sidebar_position: 8
slug: /guides/metadata-v12-upgrade
title: Metadata v12 Upgrade
description: Safe rollout order for Antseed metadata v12, large service catalogs, capabilities, and image unit billing.
---

# Metadata v12 Upgrade

Metadata v12 adds per-service capability hints and widens service catalog and per-service map counts from `uint8` to `uint16`. It builds on metadata v11, which added per-service unit billing for image outputs.

This is a **buyer-first migration**. An older buyer rejects metadata versions newer than it understands and drops that seller from discovery.

## Compatibility Matrix

| Buyer version | Seller v10 | Seller v11 | Seller v12 |
|---|---:|---:|---:|
| v10 | Visible | Not visible | Not visible |
| v11 | Visible | Visible | Not visible |
| v12 | Visible | Visible | Visible |

Updated buyers remain backward-compatible with existing sellers. Updated sellers are not visible to older buyers.

## New Metadata Limits

- 512 services per provider
- 512 entries in service pricing, categories, API protocols, capabilities, and expanded billing models
- 64 categories per service
- 4 API protocols per service
- 128 KiB maximum signed binary metadata
- 256 KiB maximum HTTP metadata response

The seller validates these limits before announcing. Buyers apply the same signed-metadata validation after downloading a bounded HTTP response.

## What Requires an Upgrade

Upgrade every component that performs buyer discovery before upgrading sellers:

- `@antseed/cli` processes running `antseed buyer start`
- Antseed Desktop buyer installations
- Applications embedding `@antseed/node` buyer/discovery APIs
- Routers or long-running services that cache peer metadata

Provider plugins do not independently choose the metadata version. The seller's `@antseed/node` runtime signs and serves metadata v12.

## Recommended Rollout

1. Publish the updated packages and buyer applications.
2. Upgrade buyer CLIs, desktop apps, routers, and embedded SDK deployments.
3. Restart buyers so their discovery runtime accepts metadata v12.
4. Verify updated buyers can still see existing v10/v11 sellers.
5. Upgrade a small seller canary group.
6. Verify the canary sellers appear in `antseed network browse` from updated buyers.
7. Roll the seller update through the remaining fleet.

For a machine running both roles, upgrade the package once but restart the buyer process before restarting the seller process.

## Verification

Check the installed CLI and browse live peers:

```bash
antseed --version
antseed network browse --json
```

In JSON output, upgraded sellers report `"version": 12`. Confirm large providers expose their complete service catalog and that capability/image entries appear where configured.

Test image routing through an updated buyer:

```bash
curl http://localhost:8377/v1/images/generations \
  -H 'content-type: application/json' \
  -d '{"model":"flux.1-schnell","prompt":"migration test","n":1}'
```

## Existing Configuration

No mandatory config-file migration is required. Existing seller services continue loading, and the new fields are optional:

```json
{
  "capabilities": {
    "contextWindow": 200000,
    "inputs": ["text", "image"],
    "outputs": ["image"],
    "toolUse": true,
    "supportedParameters": ["background", "output_format", "quality", "size"]
  },
  "unitBillingModels": {
    "openai-images": {
      "version": 1,
      "components": [
        { "unit": "output_images", "priceUsd": 0.04 }
      ]
    }
  }
}
```

For image services, modality values affect routing rather than serving as cosmetic metadata:

- `inputs: ["text"]`, `outputs: ["image"]` advertises image generation only.
- `inputs: ["text", "image"]`, `outputs: ["image"]` advertises image generation and editing.
- Advertise image input only when the exact provider adapter, upstream endpoint, and configured model support edit requests end to end. Vendor-level edit support through a different API is not sufficient.

Only the built-in `openai` provider currently consumes image unit billing. Seller startup warns when `unitBillingModels` are configured for a plugin that does not support them.

## Health Checks

Text services continue using periodic model health checks. `openai-images` services are skipped because a meaningful health probe would generate and charge for an image. Skipped image services remain advertised.

## Rollback

Removing `capabilities` or `unitBillingModels` from `config.json` does **not** make an updated seller emit older metadata. Metadata version is determined by the seller runtime.

To restore visibility to older buyers during rollback, run the previous seller binary/package version. Once the buyer fleet supports v12, upgrade the seller again.
