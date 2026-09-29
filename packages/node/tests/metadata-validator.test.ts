import { describe, it, expect } from 'vitest';
import {
  validateMetadata,
  MAX_METADATA_SIZE,
  MAX_PROVIDERS,
  MAX_SERVICES_PER_PROVIDER,
  MAX_SERVICE_NAME_LENGTH,
  MAX_REGION_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_DOMAIN_VERIFICATION_CLAIMS,
  MAX_GITHUB_VERIFICATION_CLAIMS,
  MAX_PUBLIC_ADDRESS_LENGTH,
  MAX_SERVICE_CATEGORIES_PER_SERVICE,
  MAX_SERVICE_CATEGORY_LENGTH,
  MAX_SERVICE_API_PROTOCOLS_PER_SERVICE,
  MAX_PEER_CAPABILITIES,
} from '../src/discovery/metadata-validator.js';
import { METADATA_VERSION, SERVICE_CAPABILITIES_METADATA_VERSION, SERVICE_UNIT_BILLING_METADATA_VERSION, type PeerMetadata } from '../src/discovery/peer-metadata.js';

function validMetadata(overrides?: Partial<PeerMetadata>): PeerMetadata {
  return {
    peerId: 'a'.repeat(40) as any,
    version: METADATA_VERSION,
    providers: [
      {
        provider: 'anthropic',
        services: ['claude-3-opus'],
        defaultPricing: {
          inputUsdPerMillion: 15,
          outputUsdPerMillion: 75,
        },
        maxConcurrency: 10,
        currentLoad: 3,
      },
    ],
    region: 'us-east-1',
    timestamp: Date.now(),
    signature: 'b'.repeat(130),
    ...overrides,
  };
}


describe('validateMetadata', () => {
  it('validates announced video options', () => {
    const metadata = validMetadata();
    metadata.providers[0]!.serviceCapabilities = { [metadata.providers[0]!.services[0]!]: { video: { durationsSeconds: [0, 5, 5], resolutions: ['bad value'], inputs: [], requiredInputs: ['first_frame'] } } };
    expect(validateMetadata(metadata).map(error => error.message)).toEqual(expect.arrayContaining([
      'Invalid video.durationsSeconds value 0',
      'Duplicate video.durationsSeconds value 5',
      'Invalid video.resolutions value "bad value"',
      'video.requiredInputs must also be listed in video.inputs',
    ]));
    metadata.providers[0]!.serviceCapabilities = { [metadata.providers[0]!.services[0]!]: {
      videoDownload: 'video-stream-v1', video: { durationsSeconds: [5] },
    } };
    expect(validateMetadata({ ...metadata, version: 12 })).toEqual([]);
  });

  it('accepts native video unit pricing and video output capabilities', () => {
    const metadata = validMetadata();
    const provider = metadata.providers[0]!;
    provider.provider = 'seedance';
    provider.services = ['video'];
    provider.serviceApiProtocols = { video: ['seedance-video', 'veo-video'] };
    provider.serviceCapabilities = { video: { inputs: ['text'], outputs: ['video'] } };
    provider.serviceUnitBillingModels = { video: {
      'seedance-video': { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.01 }] },
      'veo-video': { version: 1, components: [{ unit: 'video_generations', priceUsd: 0.1 }] },
    } };
    expect(validateMetadata(metadata)).toEqual([]);
  });
  it('should return no errors for valid metadata', () => {
    const errors = validateMetadata(validMetadata());
    expect(errors).toEqual([]);
  });

  it('should reject wrong version', () => {
    const errors = validateMetadata(validMetadata({ version: 99 }));
    expect(errors.some((e) => e.field === 'version')).toBe(true);
  });

  it('should reject invalid peerId (too short)', () => {
    const errors = validateMetadata(validMetadata({ peerId: 'abc' as any }));
    expect(errors.some((e) => e.field === 'peerId')).toBe(true);
  });

  it('should reject invalid peerId (uppercase)', () => {
    const errors = validateMetadata(validMetadata({ peerId: 'A'.repeat(40) as any }));
    expect(errors.some((e) => e.field === 'peerId')).toBe(true);
  });

  it('should reject empty region', () => {
    const errors = validateMetadata(validMetadata({ region: '' }));
    expect(errors.some((e) => e.field === 'region')).toBe(true);
  });

  it('should reject region exceeding max length', () => {
    const errors = validateMetadata(validMetadata({ region: 'x'.repeat(MAX_REGION_LENGTH + 1) }));
    expect(errors.some((e) => e.field === 'region')).toBe(true);
  });

  it('should reject non-positive timestamp', () => {
    const errors = validateMetadata(validMetadata({ timestamp: 0 }));
    expect(errors.some((e) => e.field === 'timestamp')).toBe(true);
  });

  it('should reject NaN timestamp', () => {
    const errors = validateMetadata(validMetadata({ timestamp: NaN }));
    expect(errors.some((e) => e.field === 'timestamp')).toBe(true);
  });

  it('should accept zero providers while a health-checked seller is unavailable', () => {
    const errors = validateMetadata(validMetadata({ providers: [] }));
    expect(errors).toEqual([]);
  });

  it('should reject too many providers', () => {
    const providers = Array.from({ length: MAX_PROVIDERS + 1 }, (_, i) => ({
      provider: `p${i}`,
      services: ['m'],
      defaultPricing: {
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 1,
      },
      maxConcurrency: 1,
      currentLoad: 0,
    }));
    const errors = validateMetadata(validMetadata({ providers }));
    expect(errors.some((e) => e.field === 'providers')).toBe(true);
  });

  it('should reject too many services per provider', () => {
    const services = Array.from({ length: MAX_SERVICES_PER_PROVIDER + 1 }, (_, i) => `service-${i}`);
    const errors = validateMetadata(
      validMetadata({
        providers: [
          {
            provider: 'test',
            services,
            defaultPricing: {
              inputUsdPerMillion: 1,
              outputUsdPerMillion: 1,
            },
            maxConcurrency: 1,
            currentLoad: 0,
          },
        ],
      })
    );
    expect(errors.some((e) => e.field.includes('services'))).toBe(true);
  });

  it('should reject service name exceeding max length', () => {
    const errors = validateMetadata(
      validMetadata({
        providers: [
          {
            provider: 'test',
            services: ['x'.repeat(MAX_SERVICE_NAME_LENGTH + 1)],
            defaultPricing: {
              inputUsdPerMillion: 1,
              outputUsdPerMillion: 1,
            },
            maxConcurrency: 1,
            currentLoad: 0,
          },
        ],
      })
    );
    expect(errors.some((e) => e.field.includes('services'))).toBe(true);
  });

  it('should reject servicePricing entries with service names exceeding max length', () => {
    const longServiceName = 'x'.repeat(MAX_SERVICE_NAME_LENGTH + 1);
    const errors = validateMetadata(
      validMetadata({
        providers: [
          {
            provider: 'test',
            services: ['m'],
            defaultPricing: {
              inputUsdPerMillion: 1,
              outputUsdPerMillion: 1,
            },
            servicePricing: {
              [longServiceName]: {
                inputUsdPerMillion: 2,
                outputUsdPerMillion: 3,
              },
            },
            maxConcurrency: 1,
            currentLoad: 0,
          },
        ],
      })
    );
    expect(errors.some((e) => e.field.includes('servicePricing'))).toBe(true);
  });

  it('should reject negative default input price', () => {
    const errors = validateMetadata(
      validMetadata({
        providers: [
          {
            provider: 'test',
            services: ['m'],
            defaultPricing: {
              inputUsdPerMillion: -1,
              outputUsdPerMillion: 1,
            },
            maxConcurrency: 1,
            currentLoad: 0,
          },
        ],
      })
    );
    expect(errors.some((e) => e.field.includes('defaultPricing.inputUsdPerMillion'))).toBe(true);
  });

  it('should reject negative default output price', () => {
    const errors = validateMetadata(
      validMetadata({
        providers: [
          {
            provider: 'test',
            services: ['m'],
            defaultPricing: {
              inputUsdPerMillion: 1,
              outputUsdPerMillion: -1,
            },
            maxConcurrency: 1,
            currentLoad: 0,
          },
        ],
      })
    );
    expect(errors.some((e) => e.field.includes('defaultPricing.outputUsdPerMillion'))).toBe(true);
  });

  it('should reject service pricing entries with missing output half', () => {
    const errors = validateMetadata(
      validMetadata({
        providers: [
          {
            provider: 'test',
            services: ['m'],
            defaultPricing: {
              inputUsdPerMillion: 1,
              outputUsdPerMillion: 1,
            },
            servicePricing: {
              m: {
                inputUsdPerMillion: 2,
              } as any,
            } as any,
            maxConcurrency: 1,
            currentLoad: 0,
          },
        ],
      })
    );
    expect(errors.some((e) => e.field.includes('servicePricing.m.outputUsdPerMillion'))).toBe(true);
  });

  it('allows services to combine token pricing with image unit billing', () => {
    const tokenOnlyErrors = validateMetadata(validMetadata({
      providers: [
        {
          provider: 'openai',
          services: ['gpt-4.1'],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 2,
          },
          servicePricing: {
            'gpt-4.1': {
              inputUsdPerMillion: 3,
              outputUsdPerMillion: 4,
            },
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(tokenOnlyErrors).toEqual([]);

    const unitOnlyProvider = {
      provider: 'openai',
      services: ['gpt-image-1'],
      defaultPricing: {
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
      },
      serviceApiProtocols: {
        'gpt-image-1': ['openai-images'],
      },
      serviceUnitBillingModels: {
        'gpt-image-1': {
          'openai-images': {
            version: 1,
            components: [
              { unit: 'output_images', priceUsd: 0.04 },
            ],
          },
        },
      },
      maxConcurrency: 1,
      currentLoad: 0,
    } satisfies PeerMetadata['providers'][number];

    const unitOnlyErrors = validateMetadata(validMetadata({
      version: SERVICE_UNIT_BILLING_METADATA_VERSION,
      providers: [unitOnlyProvider],
    }));
    expect(unitOnlyErrors).toEqual([]);

    const bothErrors = validateMetadata(validMetadata({
      version: SERVICE_UNIT_BILLING_METADATA_VERSION,
      providers: [
        {
          ...unitOnlyProvider,
          servicePricing: {
            'gpt-image-1': {
              inputUsdPerMillion: 1,
              outputUsdPerMillion: 1,
            },
          },
        },
      ],
    }));
    expect(bothErrors).toEqual([]);
  });

  it('rejects unit billing for unsupported chat protocols', () => {
    const errors = validateMetadata(validMetadata({
      version: SERVICE_UNIT_BILLING_METADATA_VERSION,
      providers: [
        {
          provider: 'openai',
          services: ['gpt-4.1'],
          defaultPricing: {
            inputUsdPerMillion: 0,
            outputUsdPerMillion: 0,
          },
          serviceApiProtocols: {
            'gpt-4.1': ['openai-chat-completions'],
          },
          serviceUnitBillingModels: {
            'gpt-4.1': {
              'openai-chat-completions': {
                version: 1,
                components: [
                  { unit: 'requests', priceUsd: 1 } as any,
                ],
              },
            },
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'providers[0].serviceUnitBillingModels.gpt-4.1.openai-chat-completions',
          message: 'Unit billing is not supported for openai-chat-completions',
        }),
        expect.objectContaining({
          field: 'providers[0].serviceUnitBillingModels.gpt-4.1.openai-chat-completions',
          message: expect.stringContaining('components[0].unit is unsupported'),
        }),
      ]),
    );
  });

  it('accepts valid service capabilities and rejects malformed ones', () => {
    const capsProvider = {
      provider: 'openai',
      services: ['gpt-5.5'],
      defaultPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
      serviceCapabilities: {
        'gpt-5.5': {
          contextWindow: 200_000,
          maxOutputTokens: 16_384,
          inputs: ['text', 'image'],
          outputs: ['text'],
          reasoning: true,
          supportedParameters: ['seed', 'temperature'],
        },
      },
      maxConcurrency: 1,
      currentLoad: 0,
    } satisfies PeerMetadata['providers'][number];

    expect(validateMetadata(validMetadata({
      version: SERVICE_CAPABILITIES_METADATA_VERSION,
      providers: [capsProvider],
    }))).toEqual([]);

    const badErrors = validateMetadata(validMetadata({
      version: SERVICE_CAPABILITIES_METADATA_VERSION,
      providers: [
        {
          ...capsProvider,
          serviceCapabilities: {
            'gpt-5.5': {
              contextWindow: -5,
              inputs: ['text', 'hologram' as any, 'text'],
              outputs: ['hologram' as any],
              supportedParameters: ['Output_Format' as any, 'seed', 'seed'],
            },
            'not-announced': { contextWindow: 1000 },
          },
        },
      ],
    }));
    expect(badErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'providers[0].serviceCapabilities.gpt-5.5',
          message: expect.stringContaining('contextWindow'),
        }),
        expect.objectContaining({
          field: 'providers[0].serviceCapabilities.gpt-5.5',
          message: expect.stringContaining('hologram'),
        }),
        expect.objectContaining({
          field: 'providers[0].serviceCapabilities.gpt-5.5',
          message: expect.stringContaining('Duplicate'),
        }),
        expect.objectContaining({
          field: 'providers[0].serviceCapabilities.gpt-5.5',
          message: expect.stringContaining('output modality "hologram"'),
        }),
        expect.objectContaining({
          field: 'providers[0].serviceCapabilities.gpt-5.5',
          message: expect.stringContaining('"Output_Format" must be lowercase snake_case'),
        }),
        expect.objectContaining({
          field: 'providers[0].serviceCapabilities.gpt-5.5',
          message: expect.stringContaining('Duplicate supported parameter "seed"'),
        }),
        expect.objectContaining({
          field: 'providers[0].serviceCapabilities.not-announced',
          message: expect.stringContaining('must reference a service'),
        }),
      ]),
    );
  });

  it('rejects service capabilities on pre-v12 metadata', () => {
    const errors = validateMetadata(validMetadata({
      version: SERVICE_UNIT_BILLING_METADATA_VERSION,
      providers: [
        {
          provider: 'openai',
          services: ['gpt-5.5'],
          defaultPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
          serviceCapabilities: { 'gpt-5.5': { contextWindow: 1000 } },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'providers[0].serviceCapabilities',
          message: expect.stringContaining('require metadata version 12'),
        }),
      ]),
    );
  });

  it('should reject maxConcurrency < 1', () => {
    const errors = validateMetadata(
      validMetadata({
        providers: [
          {
            provider: 'test',
            services: ['m'],
            defaultPricing: {
              inputUsdPerMillion: 1,
              outputUsdPerMillion: 1,
            },
            maxConcurrency: 0,
            currentLoad: 0,
          },
        ],
      })
    );
    expect(errors.some((e) => e.field.includes('maxConcurrency'))).toBe(true);
  });

  it('should reject currentLoad > maxConcurrency', () => {
    const errors = validateMetadata(
      validMetadata({
        providers: [
          {
            provider: 'test',
            services: ['m'],
            defaultPricing: {
              inputUsdPerMillion: 1,
              outputUsdPerMillion: 1,
            },
            maxConcurrency: 5,
            currentLoad: 6,
          },
        ],
      })
    );
    expect(errors.some((e) => e.field.includes('currentLoad'))).toBe(true);
  });

  it('should reject invalid signature format', () => {
    const errors = validateMetadata(validMetadata({ signature: 'xyz' }));
    expect(errors.some((e) => e.field === 'signature')).toBe(true);
  });

  it('should reject signature with uppercase hex', () => {
    const errors = validateMetadata(validMetadata({ signature: 'B'.repeat(130) }));
    expect(errors.some((e) => e.field === 'signature')).toBe(true);
  });

  it('should reject empty displayName when present', () => {
    const errors = validateMetadata(validMetadata({ displayName: '   ' }));
    expect(errors.some((e) => e.field === 'displayName')).toBe(true);
  });

  it('should reject too long displayName', () => {
    const errors = validateMetadata(validMetadata({ displayName: 'x'.repeat(MAX_DISPLAY_NAME_LENGTH + 1) }));
    expect(errors.some((e) => e.field === 'displayName')).toBe(true);
  });

  it('should accept valid publicAddress', () => {
    const errors = validateMetadata(validMetadata({ publicAddress: 'peer.example.com:6882' }));
    expect(errors.some((e) => e.field === 'publicAddress')).toBe(false);
  });

  it('should reject empty publicAddress when present', () => {
    const errors = validateMetadata(validMetadata({ publicAddress: '   ' }));
    expect(errors.some((e) => e.field === 'publicAddress')).toBe(true);
  });

  it('should reject too long publicAddress', () => {
    const errors = validateMetadata(validMetadata({ publicAddress: 'a'.repeat(MAX_PUBLIC_ADDRESS_LENGTH + 1) }));
    expect(errors.some((e) => e.field === 'publicAddress')).toBe(true);
  });

  it('should reject malformed publicAddress', () => {
    const errors = validateMetadata(validMetadata({ publicAddress: 'peer.example.com' }));
    expect(errors.some((e) => e.field === 'publicAddress')).toBe(true);
  });

  it('should reject categories for a service not listed by provider', () => {
    const errors = validateMetadata(validMetadata({
      providers: [
        {
          provider: 'test',
          services: ['m1'],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          },
          serviceCategories: {
            m2: ['privacy'],
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(errors.some((e) => e.field.includes('serviceCategories.m2'))).toBe(true);
  });

  it('should allow service categories when provider declares wildcard services', () => {
    const errors = validateMetadata(validMetadata({
      providers: [
        {
          provider: 'test',
          services: [],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          },
          serviceCategories: {
            'any-service': ['privacy'],
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(errors.some((e) => e.field.includes('serviceCategories.any-model'))).toBe(false);
  });

  it('should reject invalid service category value', () => {
    const errors = validateMetadata(validMetadata({
      providers: [
        {
          provider: 'test',
          services: ['m1'],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          },
          serviceCategories: {
            m1: [`${'x'.repeat(MAX_SERVICE_CATEGORY_LENGTH)}!`],
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(errors.some((e) => e.field.includes('serviceCategories.m1'))).toBe(true);
  });

  it('should reject service category entries with service names exceeding max length', () => {
    const longServiceName = 'x'.repeat(MAX_SERVICE_NAME_LENGTH + 1);
    const errors = validateMetadata(validMetadata({
      providers: [
        {
          provider: 'test',
          services: [],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          },
          serviceCategories: {
            [longServiceName]: ['privacy'],
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(errors.some((e) => e.field.includes('serviceCategories'))).toBe(true);
  });

  it('should reject service API protocols for a service not listed by provider', () => {
    const errors = validateMetadata(validMetadata({
      providers: [
        {
          provider: 'test',
          services: ['m1'],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          },
          serviceApiProtocols: {
            m2: ['openai-chat-completions'],
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(errors.some((e) => e.field.includes('serviceApiProtocols.m2'))).toBe(true);
  });

  it('should allow service API protocols when provider declares wildcard services', () => {
    const errors = validateMetadata(validMetadata({
      providers: [
        {
          provider: 'test',
          services: [],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          },
          serviceApiProtocols: {
            'any-service': ['openai-chat-completions'],
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(errors.some((e) => e.field.includes('serviceApiProtocols.any-model'))).toBe(false);
  });

  it('should reject unsupported service API protocol values', () => {
    const errors = validateMetadata(validMetadata({
      providers: [
        {
          provider: 'test',
          services: ['m1'],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          },
          serviceApiProtocols: {
            m1: ['not-a-real-protocol' as any],
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(errors.some((e) => e.field.includes('serviceApiProtocols.m1'))).toBe(true);
  });

  it('should reject too many service API protocols per service', () => {
    const errors = validateMetadata(validMetadata({
      providers: [
        {
          provider: 'test',
          services: ['m1'],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          },
          serviceApiProtocols: {
            m1: Array.from({ length: MAX_SERVICE_API_PROTOCOLS_PER_SERVICE + 1 }, (_, i) =>
              i % 2 === 0 ? 'openai-chat-completions' : 'anthropic-messages',
            ),
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(errors.some((e) => e.field.includes('serviceApiProtocols.m1'))).toBe(true);
  });

  it('should reject service API protocol entries with service names exceeding max length', () => {
    const longServiceName = 'x'.repeat(MAX_SERVICE_NAME_LENGTH + 1);
    const errors = validateMetadata(validMetadata({
      providers: [
        {
          provider: 'test',
          services: [],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          },
          serviceApiProtocols: {
            [longServiceName]: ['openai-chat-completions'],
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(errors.some((e) => e.field.includes('serviceApiProtocols'))).toBe(true);
  });

  it("rejects malformed sellerContract", () => {
    const errors = validateMetadata(validMetadata({ sellerContract: "not-hex" }));
    expect(errors.some(e => e.field === "sellerContract")).toBe(true);
  });

  it("accepts a well-formed sellerContract", () => {
    const errors = validateMetadata(validMetadata({ sellerContract: "bb".repeat(20) }));
    expect(errors.filter(e => e.field === "sellerContract")).toHaveLength(0);
  });

  it("accepts valid domain verification claims", () => {
    const errors = validateMetadata(validMetadata({
      verifications: {
        domains: [
          { domain: "example.com", methods: ["dns-txt", "https-well-known"] },
        ],
      },
    }));
    expect(errors.filter(e => e.field.startsWith("verifications"))).toHaveLength(0);
  });

  it("rejects malformed domain verification claims", () => {
    const errors = validateMetadata(validMetadata({
      verifications: {
        domains: [
          { domain: "https://example.com", methods: ["dns-txt"] },
          { domain: "example.com", methods: ["dns-txt", "dns-txt"] },
          { domain: "bad-method.example.com", methods: ["bogus" as any] },
        ],
      },
    }));
    expect(errors.some(e => e.field === "verifications.domains[0].domain")).toBe(true);
    expect(errors.some(e => e.field === "verifications.domains[1].methods[1]")).toBe(true);
    expect(errors.some(e => e.field === "verifications.domains[2].methods[0]")).toBe(true);
  });

  it("rejects too many domain verification claims", () => {
    const errors = validateMetadata(validMetadata({
      verifications: {
        domains: Array.from({ length: MAX_DOMAIN_VERIFICATION_CLAIMS + 1 }, (_, i) => ({
          domain: `example-${i}.com`,
        })),
      },
    }));
    expect(errors.some(e => e.field === "verifications.domains")).toBe(true);
  });

  it("accepts valid github verification claims", () => {
    const errors = validateMetadata(validMetadata({
      verifications: {
        github: [
          { username: "octocat" },
          { username: "octocat", repository: "antseed-proofs" },
        ],
      },
    }));
    expect(errors.filter(e => e.field.startsWith("verifications"))).toHaveLength(0);
  });

  it("rejects malformed github verification claims", () => {
    const errors = validateMetadata(validMetadata({
      verifications: {
        github: [
          { username: "-bad-" },
          { username: "double--hyphen" },
          { username: "octocat", repository: "bad repo!" },
          { username: "octocat" },
          { username: "octocat" },
        ],
      },
    }));
    expect(errors.some(e => e.field === "verifications.github[0].username")).toBe(true);
    expect(errors.some(e => e.field === "verifications.github[1].username")).toBe(true);
    expect(errors.some(e => e.field === "verifications.github[2].repository")).toBe(true);
    expect(errors.some(e => e.field === "verifications.github[4]")).toBe(true);
  });

  it("rejects too many github verification claims", () => {
    const errors = validateMetadata(validMetadata({
      verifications: {
        github: Array.from({ length: MAX_GITHUB_VERIFICATION_CLAIMS + 1 }, (_, i) => ({
          username: `user-${i}`,
        })),
      },
    }));
    expect(errors.some(e => e.field === "verifications.github")).toBe(true);
  });

  it("accepts well-formed peer capabilities", () => {
    const errors = validateMetadata(validMetadata({ capabilities: ["verification.response-auth.v1"] }));
    expect(errors.filter(e => e.field.startsWith("capabilities"))).toHaveLength(0);
  });

  it("rejects duplicate or malformed peer capabilities", () => {
    const errors = validateMetadata(validMetadata({
      capabilities: ["verification.response-auth.v1", "Verification.Response-Auth.V1", "bad capability"],
    }));
    expect(errors.some(e => e.field === "capabilities[1]")).toBe(true);
    expect(errors.some(e => e.field === "capabilities[2]")).toBe(true);
  });

  it("rejects too many peer capabilities", () => {
    const errors = validateMetadata(validMetadata({
      capabilities: Array.from({ length: MAX_PEER_CAPABILITIES + 1 }, (_, i) => `capability.${i}`),
    }));
    expect(errors.some(e => e.field === "capabilities")).toBe(true);
  });
});

describe('constants', () => {
  it('should export reasonable constant values', () => {
    expect(MAX_METADATA_SIZE).toBe(128 * 1024);
    expect(MAX_PROVIDERS).toBe(10);
    expect(MAX_SERVICES_PER_PROVIDER).toBe(512);
    expect(MAX_SERVICE_NAME_LENGTH).toBe(64);
    expect(MAX_REGION_LENGTH).toBe(32);
    expect(MAX_SERVICE_CATEGORIES_PER_SERVICE).toBe(64);
    expect(MAX_SERVICE_API_PROTOCOLS_PER_SERVICE).toBe(4);
  });
});
