import { describe, expect, it } from "vitest";
import {
  captureUnitBillingContext,
  computeFinalUnitBilling,
  isFreeUnitBillingModel,
  unitUsageFromReport,
  validateUnitBillingModelV1,
  validateUnitBillingUsage,
  validateUnitBillingUsageReportV1,
} from "../src/billing/unit.js";
import type {
  UnitBillingContext,
  UnitBillingModelV1,
} from "../src/types/billing.js";
import type { SerializedHttpRequest } from "../src/types/http.js";

const imageContext: UnitBillingContext = {
  sellerPeerId: "a".repeat(40),
  provider: "openai",
  service: "gpt-image-2",
  serviceApiProtocol: "openai-images",
  attributes: { model: "gpt-image-2", size: "1024x1024", quality: "low" },
  unitLimits: { output_images: 1 },
};

const imageModel: UnitBillingModelV1 = {
  version: 1,
  components: [
    {
      unit: "output_images",
      priceUsd: 0.04,
      match: { size: "1024x1024" },
    },
  ],
};

describe("unit billing runtime", () => {
  it("rejects positive billingUsage cost when buyer recomputation is zero", () => {
    const mismatchedContext: UnitBillingContext = {
      ...imageContext,
      attributes: { ...imageContext.attributes, size: "256x256" },
    };

    expect(() =>
      validateUnitBillingUsage(
        imageModel,
        mismatchedContext,
        {
          version: 1,
          units: { output_images: "1" },
        },
        40_000n,
        1.4,
        { units: { output_images: 1 } },
      ),
    ).toThrow(/No billing component matched/);
  });

  it("computes final output image cost from delivered response images", () => {
    const result = computeFinalUnitBilling(
      imageModel,
      imageContext,
      {
        requestId: "req-1",
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(JSON.stringify({
          data: [{ b64_json: "first" }, { url: "https://example.test/second.png" }],
        })),
      },
      {
        requestedImages: 4,
        model: "gpt-image-2",
        size: "1024x1024",
        quality: "low",
      },
    );

    expect(result.usage.units.output_images).toBe(2);
    expect(result.costUsdc).toBe(80_000n);
    expect(result.billingUsage).toEqual({
      version: 1,
      units: { output_images: "2" },
    });
  });

  it("caps over-delivered output images to the request limit", () => {
    const result = computeFinalUnitBilling(
      imageModel,
      imageContext,
      {
        requestId: "req-1",
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(JSON.stringify({
          data: [{ b64_json: "first" }, { b64_json: "second" }],
        })),
      },
      {
        requestedImages: 1,
        model: "gpt-image-2",
        size: "1024x1024",
        quality: "low",
      },
    );

    expect(result.usage.units.output_images).toBe(1);
    expect(result.costUsdc).toBe(40_000n);
  });

  it("does not bill placeholder response entries as delivered images", () => {
    const result = computeFinalUnitBilling(
      imageModel,
      imageContext,
      {
        requestId: "req-placeholder",
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(JSON.stringify({ data: [{}, { b64_json: "" }] })),
      },
      {
        requestedImages: 2,
        model: "gpt-image-2",
        size: "1024x1024",
        quality: "low",
      },
    );

    expect(result.usage.units.output_images).toBe(0);
    expect(result.costUsdc).toBe(0n);
  });

  it("rejects seller unit usage above the requested output image count", () => {
    expect(() =>
      validateUnitBillingUsage(
        imageModel,
        imageContext,
        {
          version: 1,
          units: { output_images: "2" },
        },
        80_000n,
        1.4,
      ),
    ).toThrow(/request allowed 1/);
  });

  it("rejects seller unit usage above what the response actually delivered", () => {
    const context: UnitBillingContext = {
      ...imageContext,
      unitLimits: { output_images: 4 },
    };

    expect(() =>
      validateUnitBillingUsage(
        imageModel,
        context,
        {
          version: 1,
          units: { output_images: "4" },
        },
        160_000n,
        1.4,
        { units: { output_images: 1 } },
      ),
    ).toThrow(/response delivered 1/);
  });

  it("rejects positive seller unit usage when the observed response delivered nothing", () => {
    expect(() =>
      validateUnitBillingUsage(
        imageModel,
        imageContext,
        {
          version: 1,
          units: { output_images: "1" },
        },
        40_000n,
        1.4,
        { units: {} },
      ),
    ).toThrow(/response delivered 0/);
  });

  it("accepts seller unit usage matching the observed response", () => {
    expect(
      validateUnitBillingUsage(
        imageModel,
        imageContext,
        {
          version: 1,
          units: { output_images: "1" },
        },
        40_000n,
        1.4,
        { units: { output_images: 1 } },
      ),
    ).toBe(40_000n);
  });

  it("rejects positive cost claims before the buyer observed the delivered response", () => {
    expect(() =>
      validateUnitBillingUsage(
        imageModel,
        imageContext,
        {
          version: 1,
          units: { output_images: "1" },
        },
        40_000n,
        1.4,
        undefined,
      ),
    ).toThrow(/before the buyer observed/);
  });

  it("accepts zero-cost claims without observed usage", () => {
    expect(
      validateUnitBillingUsage(
        imageModel,
        imageContext,
        {
          version: 1,
          units: { output_images: "0" },
        },
        0n,
        1.4,
        undefined,
      ),
    ).toBe(0n);
  });

  it("rejects non-canonical and unsafe unit count strings", () => {
    expect(
      validateUnitBillingUsageReportV1({
        version: 1,
        units: { output_images: "1e3" },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "canonical non-negative integer decimal string",
        ),
      ]),
    );

    expect(
      validateUnitBillingUsageReportV1({
        version: 1,
        units: { output_images: "01" },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "canonical non-negative integer decimal string",
        ),
      ]),
    );

    expect(() =>
      unitUsageFromReport({
        version: 1,
        units: { output_images: String(Number.MAX_SAFE_INTEGER + 1) },
      }),
    ).toThrow(/maximum safe integer/);
  });

  it("does not classify malformed non-finite prices as free", () => {
    const model = {
      version: 1,
      components: [
        { unit: "output_images", priceUsd: Number.NaN },
      ],
    } as UnitBillingModelV1;

    expect(isFreeUnitBillingModel(model)).toBe(false);
    expect(validateUnitBillingModelV1(model)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("non-negative finite number"),
      ]),
    );
  });

  it("captures request-owned unit context without protocol billing vocabulary in api-adapter facts", () => {
    const request: SerializedHttpRequest = {
      requestId: "req-image",
      method: "POST",
      path: "/v1/images/generations",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify({
        model: "gpt-image-2",
        prompt: "cube",
        size: "1024x1024",
        quality: "low",
      })),
    };

    const captured = captureUnitBillingContext({
      sellerPeerId: "a".repeat(40),
      provider: "openai",
      service: "gpt-image-2",
      serviceApiProtocol: "openai-images",
      request,
    });

    expect(captured.context).toMatchObject({
      serviceApiProtocol: "openai-images",
      attributes: {
        model: "gpt-image-2",
        size: "1024x1024",
        quality: "low",
      },
      unitLimits: { output_images: 1 },
    });
    expect(captured.requestFacts).toEqual({
      model: "gpt-image-2",
      size: "1024x1024",
      quality: "low",
      requestedImages: 1,
      promptTokens: 1,
    });
  });

  it("captures unit context from a multipart image edits request", () => {
    const boundary = "----antseedEditBoundary";
    const request: SerializedHttpRequest = {
      requestId: "req-image-edit",
      method: "POST",
      path: "/v1/images/edits",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: new TextEncoder().encode([
        `--${boundary}`,
        'Content-Disposition: form-data; name="model"',
        "",
        "gpt-image-2",
        `--${boundary}`,
        'Content-Disposition: form-data; name="prompt"',
        "",
        "make the cube red",
        `--${boundary}`,
        'Content-Disposition: form-data; name="n"',
        "",
        "2",
        `--${boundary}`,
        'Content-Disposition: form-data; name="size"',
        "",
        "1024x1024",
        `--${boundary}`,
        'Content-Disposition: form-data; name="image"; filename="in.png"',
        "Content-Type: image/png",
        "",
        "\x89PNG-binary",
        `--${boundary}--`,
        "",
      ].join("\r\n")),
    };

    const captured = captureUnitBillingContext({
      sellerPeerId: "a".repeat(40),
      provider: "openai",
      service: "gpt-image-2",
      serviceApiProtocol: "openai-images",
      request,
    });

    expect(captured.context).toMatchObject({
      serviceApiProtocol: "openai-images",
      attributes: { model: "gpt-image-2", size: "1024x1024", quality: "auto" },
      unitLimits: { output_images: 2 },
    });
    expect(captured.requestFacts).toEqual({
      model: "gpt-image-2",
      size: "1024x1024",
      quality: "auto",
      requestedImages: 2,
      promptTokens: 4,
    });
  });

  it("normalizes omitted image tiers and invalid counts before billing", () => {
    const request: SerializedHttpRequest = {
      requestId: "req-image-defaults",
      method: "POST",
      path: "/v1/images/generations",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify({
        model: "gpt-image-2",
        n: 0,
      })),
    };

    const captured = captureUnitBillingContext({
      sellerPeerId: "a".repeat(40),
      provider: "openai",
      service: "gpt-image-2",
      serviceApiProtocol: "openai-images",
      request,
    });

    expect(captured.context.attributes).toEqual({
      model: "gpt-image-2",
      size: "auto",
      quality: "auto",
    });
    expect(captured.context.unitLimits).toEqual({ output_images: 1 });
  });
});
