import type { DomainVerificationMethod, PeerMetadata } from "./peer-metadata.js";
import { METADATA_VERSION, MIN_SUPPORTED_METADATA_VERSION, SERVICE_CAPABILITIES_METADATA_VERSION, SERVICE_UNIT_BILLING_METADATA_VERSION, WELL_KNOWN_SERVICE_API_PROTOCOLS, isNativeVideoProtocol, validateServiceCapabilityFields } from "./peer-metadata.js";
import { encodeMetadata } from "./metadata-codec.js";
import { MAX_PUBLIC_ADDRESS_LENGTH, parsePublicAddress } from "./public-address.js";
import { validateUnitBillingModelV1 } from "../billing/unit.js";

// Metadata is fetched from an untrusted HTTP endpoint. Keep the signed binary
// snapshot bounded while allowing large aggregator catalogs.
export const MAX_METADATA_SIZE = 128 * 1024;
export const MAX_PROVIDERS = 10;
export const MAX_SERVICES_PER_PROVIDER = 512;
export const MAX_SERVICE_NAME_LENGTH = 64;
export const MAX_REGION_LENGTH = 32;
export const MAX_DISPLAY_NAME_LENGTH = 64;
export const MAX_DOMAIN_VERIFICATION_CLAIMS = 5;
export const MAX_DOMAIN_LENGTH = 253;
export const MAX_GITHUB_VERIFICATION_CLAIMS = 5;
export const MAX_GITHUB_USERNAME_LENGTH = 39;
export const MAX_GITHUB_REPOSITORY_LENGTH = 100;
export const MAX_SERVICE_CATEGORIES_PER_SERVICE = 64;
export const MAX_SERVICE_CATEGORY_LENGTH = 32;
export const MAX_SERVICE_API_PROTOCOLS_PER_SERVICE = 4;
export const MAX_BILLING_COMPONENTS_PER_MODEL = 8;
export const MAX_BILLING_MATCH_ENTRIES_PER_COMPONENT = 3;
export const MAX_BILLING_MATCH_VALUE_BYTES = 32;
export const MAX_PEER_CAPABILITIES = 16;
export const MAX_PEER_CAPABILITY_LENGTH = 64;
export { MAX_CAPABILITY_TOKEN_COUNT } from "./peer-metadata.js";
const SERVICE_CATEGORY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN_VERIFICATION_METHODS = new Set<DomainVerificationMethod>(["dns-txt", "https-well-known"]);
const GITHUB_USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const GITHUB_REPOSITORY_PATTERN = /^[a-z0-9._-]+$/;
const VERIFICATION_NAMESPACES = new Set(["domains", "github"]);
const PEER_CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;
const SERVICE_API_PROTOCOL_SET = new Set<string>(WELL_KNOWN_SERVICE_API_PROTOCOLS);

function isValidDomainName(value: string): boolean {
  if (value.length === 0 || value.length > MAX_DOMAIN_LENGTH) return false;
  if (value.includes("..") || value.endsWith(".")) return false;
  const labels = value.split(".");
  if (labels.length < 2) return false;
  return labels.every((label) => DOMAIN_LABEL_PATTERN.test(label));
}

function isValidGithubUsername(value: string): boolean {
  return value.length > 0
    && value.length <= MAX_GITHUB_USERNAME_LENGTH
    && !value.includes("--")
    && GITHUB_USERNAME_PATTERN.test(value);
}

function isValidGithubRepository(value: string): boolean {
  return value.length > 0
    && value.length <= MAX_GITHUB_REPOSITORY_LENGTH
    && value !== "."
    && value !== ".."
    && GITHUB_REPOSITORY_PATTERN.test(value);
}

export interface ValidationError {
  field: string;
  message: string;
}

export function validateMetadata(metadata: PeerMetadata): ValidationError[] {
  const errors: ValidationError[] = [];

  // version
  if (metadata.version < MIN_SUPPORTED_METADATA_VERSION || metadata.version > METADATA_VERSION) {
    errors.push({
      field: "version",
      message: `Expected version ${MIN_SUPPORTED_METADATA_VERSION}..${METADATA_VERSION}, got ${metadata.version}`,
    });
  }

  // peerId length (40 hex chars = 20 bytes, EVM address)
  if (!/^[0-9a-f]{40}$/.test(metadata.peerId)) {
    errors.push({
      field: "peerId",
      message: "PeerId must be exactly 40 lowercase hex characters",
    });
  }

  // region
  if (!metadata.region || metadata.region.length === 0) {
    errors.push({
      field: "region",
      message: "Region must not be empty",
    });
  } else if (metadata.region.length > MAX_REGION_LENGTH) {
    errors.push({
      field: "region",
      message: `Region length ${metadata.region.length} exceeds max ${MAX_REGION_LENGTH}`,
    });
  }

  if (metadata.displayName !== undefined) {
    if (metadata.displayName.trim().length === 0) {
      errors.push({
        field: "displayName",
        message: "Display name must not be empty when provided",
      });
    } else if (metadata.displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      errors.push({
        field: "displayName",
        message: `Display name length ${metadata.displayName.length} exceeds max ${MAX_DISPLAY_NAME_LENGTH}`,
      });
    }
  }

  if (metadata.publicAddress !== undefined) {
    const value = metadata.publicAddress.trim();
    if (value.length === 0) {
      errors.push({
        field: "publicAddress",
        message: "Public address must not be empty when provided",
      });
    } else if (value.length > MAX_PUBLIC_ADDRESS_LENGTH) {
      errors.push({
        field: "publicAddress",
        message: `Public address length ${value.length} exceeds max ${MAX_PUBLIC_ADDRESS_LENGTH}`,
      });
    } else if (parsePublicAddress(value) === null) {
      errors.push({
        field: "publicAddress",
        message: 'Public address must be in the form "host:port" with a valid port',
      });
    }
  }

  if (metadata.sellerContract !== undefined) {
    if (!/^[0-9a-f]{40}$/.test(metadata.sellerContract)) {
      errors.push({ field: "sellerContract", message: "Must be 40 lowercase hex chars" });
    }
  }

  if (metadata.verifications !== undefined) {
    if (!metadata.verifications || typeof metadata.verifications !== "object" || Array.isArray(metadata.verifications)) {
      errors.push({ field: "verifications", message: "Must be an object when provided" });
    } else {
      const domainClaims = metadata.verifications.domains;
      if (domainClaims !== undefined) {
        if (!Array.isArray(domainClaims)) {
          errors.push({ field: "verifications.domains", message: "Must be an array when provided" });
        } else {
          if (domainClaims.length === 0) {
            errors.push({ field: "verifications.domains", message: "Must not be empty when provided" });
          }
          if (domainClaims.length > MAX_DOMAIN_VERIFICATION_CLAIMS) {
            errors.push({
              field: "verifications.domains",
              message: `Domain verification claim count ${domainClaims.length} exceeds max ${MAX_DOMAIN_VERIFICATION_CLAIMS}`,
            });
          }
          const domains = new Set<string>();
          for (let i = 0; i < domainClaims.length; i += 1) {
            const claim = domainClaims[i];
            if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
              errors.push({ field: `verifications.domains[${i}]`, message: "Domain verification claim must be an object" });
              continue;
            }
            const domain = typeof claim.domain === "string" ? claim.domain.trim().toLowerCase() : "";
            if (!isValidDomainName(domain)) {
              errors.push({
                field: `verifications.domains[${i}].domain`,
                message: "Domain must be a lower-case hostname with at least two labels",
              });
            } else if (domains.has(domain)) {
              errors.push({
                field: `verifications.domains[${i}].domain`,
                message: "Domain verification claims must be unique",
              });
            }
            domains.add(domain);

            if (claim.methods !== undefined) {
              if (!Array.isArray(claim.methods) || claim.methods.length === 0) {
                errors.push({
                  field: `verifications.domains[${i}].methods`,
                  message: "Methods must be a non-empty string array when provided",
                });
              } else {
                const methods = new Set<string>();
                for (let j = 0; j < claim.methods.length; j += 1) {
                  const method = claim.methods[j];
                  if (typeof method !== "string" || !DOMAIN_VERIFICATION_METHODS.has(method as DomainVerificationMethod)) {
                    errors.push({
                      field: `verifications.domains[${i}].methods[${j}]`,
                      message: "Unsupported domain verification method",
                    });
                    continue;
                  }
                  if (methods.has(method)) {
                    errors.push({
                      field: `verifications.domains[${i}].methods[${j}]`,
                      message: "Domain verification methods must be unique per claim",
                    });
                  }
                  methods.add(method);
                }
              }
            }
          }
        }
      }
      const githubClaims = metadata.verifications.github;
      if (githubClaims !== undefined) {
        if (!Array.isArray(githubClaims)) {
          errors.push({ field: "verifications.github", message: "Must be an array when provided" });
        } else {
          if (githubClaims.length === 0) {
            errors.push({ field: "verifications.github", message: "Must not be empty when provided" });
          }
          if (githubClaims.length > MAX_GITHUB_VERIFICATION_CLAIMS) {
            errors.push({
              field: "verifications.github",
              message: `GitHub verification claim count ${githubClaims.length} exceeds max ${MAX_GITHUB_VERIFICATION_CLAIMS}`,
            });
          }
          const seen = new Set<string>();
          for (let i = 0; i < githubClaims.length; i += 1) {
            const claim = githubClaims[i];
            if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
              errors.push({ field: `verifications.github[${i}]`, message: "GitHub verification claim must be an object" });
              continue;
            }
            const username = typeof claim.username === "string" ? claim.username.trim().toLowerCase() : "";
            if (!isValidGithubUsername(username)) {
              errors.push({
                field: `verifications.github[${i}].username`,
                message: "Username must be a valid lower-case GitHub username",
              });
            }
            if (claim.repository !== undefined) {
              const repository = typeof claim.repository === "string" ? claim.repository.trim().toLowerCase() : "";
              if (!isValidGithubRepository(repository)) {
                errors.push({
                  field: `verifications.github[${i}].repository`,
                  message: "Repository must be a valid lower-case GitHub repository name",
                });
              }
            }
            const key = `${username}/${typeof claim.repository === "string" ? claim.repository.trim().toLowerCase() : ""}`;
            if (seen.has(key)) {
              errors.push({
                field: `verifications.github[${i}]`,
                message: "GitHub verification claims must be unique",
              });
            }
            seen.add(key);
          }
        }
      }
      const unknownKeys = Object.keys(metadata.verifications).filter((key) => !VERIFICATION_NAMESPACES.has(key));
      for (const key of unknownKeys) {
        errors.push({
          field: `verifications.${key}`,
          message: "Unsupported verification namespace",
        });
      }
      if (domainClaims === undefined && githubClaims === undefined && unknownKeys.length === 0) {
        errors.push({
          field: "verifications",
          message: "Must include at least one verification namespace when provided",
        });
      }
    }
  }

  if (metadata.capabilities !== undefined) {
    if (!Array.isArray(metadata.capabilities)) {
      errors.push({ field: "capabilities", message: "Capabilities must be a string array" });
    } else {
      if (metadata.capabilities.length > MAX_PEER_CAPABILITIES) {
        errors.push({
          field: "capabilities",
          message: `Capability count ${metadata.capabilities.length} exceeds max ${MAX_PEER_CAPABILITIES}`,
        });
      }
      const deduped = new Set<string>();
      for (let i = 0; i < metadata.capabilities.length; i++) {
        const capability = metadata.capabilities[i];
        if (typeof capability !== "string" || capability.trim().length === 0) {
          errors.push({
            field: `capabilities[${i}]`,
            message: "Capability must be a non-empty string",
          });
          continue;
        }
        const normalized = capability.trim().toLowerCase();
        if (normalized.length > MAX_PEER_CAPABILITY_LENGTH) {
          errors.push({
            field: `capabilities[${i}]`,
            message: `Capability length ${normalized.length} exceeds max ${MAX_PEER_CAPABILITY_LENGTH}`,
          });
        }
        if (!PEER_CAPABILITY_PATTERN.test(normalized)) {
          errors.push({
            field: `capabilities[${i}]`,
            message: "Capability must use lowercase letters, digits, hyphen, or dot",
          });
        }
        if (deduped.has(normalized)) {
          errors.push({
            field: `capabilities[${i}]`,
            message: "Capability values must be unique",
          });
        }
        deduped.add(normalized);
      }
    }
  }

  // timestamp
  if (metadata.timestamp <= 0 || !Number.isFinite(metadata.timestamp)) {
    errors.push({
      field: "timestamp",
      message: "Timestamp must be a positive finite number",
    });
  }

  // A health-checked seller may temporarily have zero available providers.
  // It remains discoverable so buyers can observe recovery, but advertises no
  // inference route until at least one service becomes healthy again.
  if (metadata.providers.length > MAX_PROVIDERS) {
    errors.push({
      field: "providers",
      message: `Provider count ${metadata.providers.length} exceeds max ${MAX_PROVIDERS}`,
    });
  }

  // each provider
  for (let i = 0; i < metadata.providers.length; i++) {
    const p = metadata.providers[i]!;
    const hasWildcardServices = p.services.length === 0;

    // services count
    if (p.services.length > MAX_SERVICES_PER_PROVIDER) {
      errors.push({
        field: `providers[${i}].services`,
        message: `Service count ${p.services.length} exceeds max ${MAX_SERVICES_PER_PROVIDER}`,
      });
    }

    // service name length
    for (let j = 0; j < p.services.length; j++) {
      const service = p.services[j]!;
      if (service.length > MAX_SERVICE_NAME_LENGTH) {
        errors.push({
          field: `providers[${i}].services[${j}]`,
          message: `Service name length ${service.length} exceeds max ${MAX_SERVICE_NAME_LENGTH}`,
        });
      }
    }

    // default pricing
    if (!Number.isFinite(p.defaultPricing?.inputUsdPerMillion) || p.defaultPricing.inputUsdPerMillion < 0) {
      errors.push({
        field: `providers[${i}].defaultPricing.inputUsdPerMillion`,
        message: "Default input price must be a non-negative finite number",
      });
    }
    if (!Number.isFinite(p.defaultPricing?.outputUsdPerMillion) || p.defaultPricing.outputUsdPerMillion < 0) {
      errors.push({
        field: `providers[${i}].defaultPricing.outputUsdPerMillion`,
        message: "Default output price must be a non-negative finite number",
      });
    }

    // service pricing (optional)
    if (p.servicePricing !== undefined) {
      for (const [serviceName, servicePricing] of Object.entries(p.servicePricing)) {
        if (serviceName.length > MAX_SERVICE_NAME_LENGTH) {
          errors.push({
            field: `providers[${i}].servicePricing.${serviceName}`,
            message: `Service name length ${serviceName.length} exceeds max ${MAX_SERVICE_NAME_LENGTH}`,
          });
        }
        if (!servicePricing || !Number.isFinite(servicePricing.inputUsdPerMillion) || servicePricing.inputUsdPerMillion < 0) {
          errors.push({
            field: `providers[${i}].servicePricing.${serviceName}.inputUsdPerMillion`,
            message: "Service input price must be a non-negative finite number",
          });
        }
        if (!servicePricing || !Number.isFinite(servicePricing.outputUsdPerMillion) || servicePricing.outputUsdPerMillion < 0) {
          errors.push({
            field: `providers[${i}].servicePricing.${serviceName}.outputUsdPerMillion`,
            message: "Service output price must be a non-negative finite number",
          });
        }
      }
    }

    if (p.serviceCategories !== undefined) {
      for (const [serviceName, categories] of Object.entries(p.serviceCategories)) {
        if (serviceName.length > MAX_SERVICE_NAME_LENGTH) {
          errors.push({
            field: `providers[${i}].serviceCategories.${serviceName}`,
            message: `Service name length ${serviceName.length} exceeds max ${MAX_SERVICE_NAME_LENGTH}`,
          });
        }
        if (!hasWildcardServices && !p.services.includes(serviceName)) {
          errors.push({
            field: `providers[${i}].serviceCategories.${serviceName}`,
            message: "Service categories must reference a service listed in providers[].services",
          });
        }
        if (!Array.isArray(categories) || categories.length === 0) {
          errors.push({
            field: `providers[${i}].serviceCategories.${serviceName}`,
            message: "Service categories must be a non-empty string array",
          });
          continue;
        }
        if (categories.length > MAX_SERVICE_CATEGORIES_PER_SERVICE) {
          errors.push({
            field: `providers[${i}].serviceCategories.${serviceName}`,
            message: `Service category count ${categories.length} exceeds max ${MAX_SERVICE_CATEGORIES_PER_SERVICE}`,
          });
        }
        const deduped = new Set<string>();
        for (let j = 0; j < categories.length; j++) {
          const category = categories[j];
          if (typeof category !== "string" || category.trim().length === 0) {
            errors.push({
              field: `providers[${i}].serviceCategories.${serviceName}[${j}]`,
              message: "Service category must be a non-empty string",
            });
            continue;
          }
          const normalized = category.trim().toLowerCase();
          if (normalized.length > MAX_SERVICE_CATEGORY_LENGTH) {
            errors.push({
              field: `providers[${i}].serviceCategories.${serviceName}[${j}]`,
              message: `Service category length ${normalized.length} exceeds max ${MAX_SERVICE_CATEGORY_LENGTH}`,
            });
          }
          if (!SERVICE_CATEGORY_PATTERN.test(normalized)) {
            errors.push({
              field: `providers[${i}].serviceCategories.${serviceName}[${j}]`,
              message: "Service category must use lowercase letters, digits, or hyphen",
            });
          }
          if (deduped.has(normalized)) {
            errors.push({
              field: `providers[${i}].serviceCategories.${serviceName}[${j}]`,
              message: "Service category values must be unique per service",
            });
          }
          deduped.add(normalized);
        }
      }
    }

    if (p.serviceApiProtocols !== undefined) {
      for (const [serviceName, protocols] of Object.entries(p.serviceApiProtocols)) {
        if (serviceName.length > MAX_SERVICE_NAME_LENGTH) {
          errors.push({
            field: `providers[${i}].serviceApiProtocols.${serviceName}`,
            message: `Service name length ${serviceName.length} exceeds max ${MAX_SERVICE_NAME_LENGTH}`,
          });
        }
        if (!hasWildcardServices && !p.services.includes(serviceName)) {
          errors.push({
            field: `providers[${i}].serviceApiProtocols.${serviceName}`,
            message: "Service API protocols must reference a service listed in providers[].services",
          });
        }
        if (!Array.isArray(protocols) || protocols.length === 0) {
          errors.push({
            field: `providers[${i}].serviceApiProtocols.${serviceName}`,
            message: "Service API protocols must be a non-empty string array",
          });
          continue;
        }
        if (protocols.length > MAX_SERVICE_API_PROTOCOLS_PER_SERVICE) {
          errors.push({
            field: `providers[${i}].serviceApiProtocols.${serviceName}`,
            message: `Service API protocol count ${protocols.length} exceeds max ${MAX_SERVICE_API_PROTOCOLS_PER_SERVICE}`,
          });
        }
        const deduped = new Set<string>();
        for (let j = 0; j < protocols.length; j++) {
          const protocol = protocols[j];
          if (typeof protocol !== "string" || protocol.trim().length === 0) {
            errors.push({
              field: `providers[${i}].serviceApiProtocols.${serviceName}[${j}]`,
              message: "Service API protocol must be a non-empty string",
            });
            continue;
          }
          const normalized = protocol.trim().toLowerCase();
          if (!SERVICE_API_PROTOCOL_SET.has(normalized)) {
            errors.push({
              field: `providers[${i}].serviceApiProtocols.${serviceName}[${j}]`,
              message: `Unsupported service API protocol "${normalized}"`,
            });
          }
          if (deduped.has(normalized)) {
            errors.push({
              field: `providers[${i}].serviceApiProtocols.${serviceName}[${j}]`,
              message: "Service API protocol values must be unique per service",
            });
          }
          deduped.add(normalized);
        }
      }
    }

    if (p.serviceUnitBillingModels !== undefined) {
      if (metadata.version < SERVICE_UNIT_BILLING_METADATA_VERSION) {
        errors.push({
          field: `providers[${i}].serviceUnitBillingModels`,
          message: `Service unit billing models require metadata version ${SERVICE_UNIT_BILLING_METADATA_VERSION}`,
        });
      }
      let expandedBillingModelCount = 0;
      for (const [serviceName, protocolModels] of Object.entries(p.serviceUnitBillingModels)) {
        if (serviceName.length > MAX_SERVICE_NAME_LENGTH) {
          errors.push({
            field: `providers[${i}].serviceUnitBillingModels.${serviceName}`,
            message: `Service name length ${serviceName.length} exceeds max ${MAX_SERVICE_NAME_LENGTH}`,
          });
        }
        if (!hasWildcardServices && !p.services.includes(serviceName)) {
          errors.push({
            field: `providers[${i}].serviceUnitBillingModels.${serviceName}`,
            message: "Service unit billing models must reference a service listed in providers[].services",
          });
        }
        if (!protocolModels || typeof protocolModels !== "object" || Array.isArray(protocolModels)) {
          errors.push({
            field: `providers[${i}].serviceUnitBillingModels.${serviceName}`,
            message: "Service unit billing model entry must be an object keyed by service API protocol",
          });
          continue;
        }
        for (const [protocol, model] of Object.entries(protocolModels)) {
          expandedBillingModelCount += 1;
          const serviceProtocols = p.serviceApiProtocols?.[serviceName];
          if (!SERVICE_API_PROTOCOL_SET.has(protocol)) {
            errors.push({
              field: `providers[${i}].serviceUnitBillingModels.${serviceName}.${protocol}`,
              message: `Unsupported service API protocol "${protocol}"`,
            });
          } else if (protocol !== 'openai-images' && !isNativeVideoProtocol(protocol)) {
            errors.push({
              field: `providers[${i}].serviceUnitBillingModels.${serviceName}.${protocol}`,
              message: "Service unit billing models support openai-images and native video protocols only",
            });
          } else if (serviceProtocols && !serviceProtocols.includes(protocol as typeof serviceProtocols[number])) {
            errors.push({
              field: `providers[${i}].serviceUnitBillingModels.${serviceName}.${protocol}`,
              message: "Billing model protocol must be announced for the service",
            });
          }
          const modelErrors = validateUnitBillingModelV1(model);
          for (const message of modelErrors) {
            errors.push({
              field: `providers[${i}].serviceUnitBillingModels.${serviceName}.${protocol}`,
              message,
            });
          }
          if (model.components.length > MAX_BILLING_COMPONENTS_PER_MODEL) {
            errors.push({
              field: `providers[${i}].serviceUnitBillingModels.${serviceName}.${protocol}.components`,
              message: `Billing component count ${model.components.length} exceeds max ${MAX_BILLING_COMPONENTS_PER_MODEL}`,
            });
          }
          model.components.forEach((component, componentIndex) => {
            const matchEntries = Object.entries(component.match ?? {});
            if (matchEntries.length > MAX_BILLING_MATCH_ENTRIES_PER_COMPONENT) {
              errors.push({
                field: `providers[${i}].serviceUnitBillingModels.${serviceName}.${protocol}.components[${componentIndex}].match`,
                message: `Billing match entry count ${matchEntries.length} exceeds max ${MAX_BILLING_MATCH_ENTRIES_PER_COMPONENT}`,
              });
            }
            for (const [key, value] of matchEntries) {
              const byteLength = new TextEncoder().encode(value).length;
              if (byteLength > MAX_BILLING_MATCH_VALUE_BYTES) {
                errors.push({
                  field: `providers[${i}].serviceUnitBillingModels.${serviceName}.${protocol}.components[${componentIndex}].match.${key}`,
                  message: `Billing match value length ${byteLength} exceeds max ${MAX_BILLING_MATCH_VALUE_BYTES} bytes`,
                });
              }
            }
          });
        }
      }
      if (expandedBillingModelCount > MAX_SERVICES_PER_PROVIDER) {
        errors.push({
          field: `providers[${i}].serviceUnitBillingModels`,
          message: `Expanded billing model count ${expandedBillingModelCount} exceeds max ${MAX_SERVICES_PER_PROVIDER}`,
        });
      }
    }

    if (p.serviceCapabilities !== undefined) {
      if (metadata.version < SERVICE_CAPABILITIES_METADATA_VERSION) {
        errors.push({
          field: `providers[${i}].serviceCapabilities`,
          message: `Service capabilities require metadata version ${SERVICE_CAPABILITIES_METADATA_VERSION}`,
        });
      }
      const capabilityEntries = Object.entries(p.serviceCapabilities);
      if (capabilityEntries.length > MAX_SERVICES_PER_PROVIDER) {
        errors.push({
          field: `providers[${i}].serviceCapabilities`,
          message: `Service capability entry count ${capabilityEntries.length} exceeds max ${MAX_SERVICES_PER_PROVIDER}`,
        });
      }
      for (const [serviceName, caps] of capabilityEntries) {
        const field = `providers[${i}].serviceCapabilities.${serviceName}`;
        if (serviceName.length > MAX_SERVICE_NAME_LENGTH) {
          errors.push({
            field,
            message: `Service name length ${serviceName.length} exceeds max ${MAX_SERVICE_NAME_LENGTH}`,
          });
        }
        if (!hasWildcardServices && !p.services.includes(serviceName)) {
          errors.push({
            field,
            message: "Service capabilities must reference a service listed in providers[].services",
          });
        }
        if (!caps || typeof caps !== "object" || Array.isArray(caps)) {
          errors.push({ field, message: "Service capability entry must be an object" });
          continue;
        }
        for (const message of validateServiceCapabilityFields(caps)) {
          errors.push({ field, message });
        }
      }
    }

    // concurrency
    if (p.maxConcurrency < 1) {
      errors.push({
        field: `providers[${i}].maxConcurrency`,
        message: "Max concurrency must be at least 1",
      });
    }

    // currentLoad
    if (p.currentLoad < 0) {
      errors.push({
        field: `providers[${i}].currentLoad`,
        message: "Current load must be non-negative",
      });
    }
    if (p.currentLoad > p.maxConcurrency) {
      errors.push({
        field: `providers[${i}].currentLoad`,
        message: "Current load must not exceed max concurrency",
      });
    }
  }

  // signature length (130 hex chars = 65 bytes, secp256k1 r+s+v)
  if (!/^[0-9a-f]{130}$/.test(metadata.signature)) {
    errors.push({
      field: "signature",
      message: "Signature must be exactly 130 lowercase hex characters (65 bytes)",
    });
  }

  // encoded size. Skip when an earlier format error would cause encode to
  // throw for reasons already reported (e.g. malformed sellerContract hex) —
  // otherwise the generic "failed to encode" masks the real cause.
  if (errors.length === 0) {
    try {
      const encoded = encodeMetadata(metadata);
      if (encoded.length > MAX_METADATA_SIZE) {
        errors.push({
          field: "encoded",
          message: `Encoded size ${encoded.length} exceeds max ${MAX_METADATA_SIZE}`,
        });
      }
    } catch (err) {
      errors.push({
        field: "encoded",
        message: `Failed to encode metadata for size check: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return errors;
}
