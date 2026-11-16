import type { DomainVerificationClaim, DomainVerificationMethod, GithubVerificationClaim } from "../../peer-metadata.js";
import type { PeerField } from "../field.js";
import { compareCodeUnits } from "../wire.js";

const DOMAIN_VERIFICATION_METHOD_IDS: Record<DomainVerificationMethod, number> = {
  "dns-txt": 0,
  "https-well-known": 1,
};
const DOMAIN_VERIFICATION_METHODS_BY_ID: DomainVerificationMethod[] = ["dns-txt", "https-well-known"];

/**
 * [domainCount:1]([domainLen:1][domain:N][methodCount:1][methodIds...])...
 * [githubCount:1]([usernameLen:1][username:N][repoLen:1][repo:N])... (repoLen 0 = profile repo)
 */
export const verificationsField: PeerField = {
  keys: ["verifications"],
  encode(writer, metadata) {
    const claims = (metadata.verifications?.domains ?? [])
      .map((claim) => ({
        domain: claim.domain.trim().toLowerCase(),
        methods: claim.methods
          ? Array.from(new Set(claim.methods.map((method) => method.trim() as DomainVerificationMethod)))
          : undefined,
      }))
      .filter((claim) => claim.domain.length > 0)
      // Code-unit sort: buyers verify signatures by re-encoding decoded
      // metadata, so claim order must not depend on the verifier's locale.
      .sort((a, b) => compareCodeUnits(a.domain, b.domain));
    if (claims.length > 255) {
      throw new Error(`Too many domain verification claims (${claims.length})`);
    }
    writer.u8(claims.length);
    for (const claim of claims) {
      if (new TextEncoder().encode(claim.domain).length > 255) {
        throw new Error(`Domain verification claim too long (${new TextEncoder().encode(claim.domain).length} bytes)`);
      }
      writer.utf8(claim.domain);
      const methods = claim.methods
        ? claim.methods.slice().sort((a, b) => DOMAIN_VERIFICATION_METHOD_IDS[a] - DOMAIN_VERIFICATION_METHOD_IDS[b])
        : [];
      writer.u8(methods.length);
      for (const method of methods) {
        const methodId = DOMAIN_VERIFICATION_METHOD_IDS[method];
        if (methodId === undefined) {
          throw new Error(`Unsupported domain verification method "${method}"`);
        }
        writer.u8(methodId);
      }
    }

    const githubClaims = (metadata.verifications?.github ?? [])
      .map((claim) => ({
        username: claim.username.trim().toLowerCase(),
        repository: claim.repository ? claim.repository.trim().toLowerCase() : "",
      }))
      .filter((claim) => claim.username.length > 0)
      .sort((a, b) => compareCodeUnits(a.username, b.username) || compareCodeUnits(a.repository, b.repository));
    if (githubClaims.length > 255) {
      throw new Error(`Too many GitHub verification claims (${githubClaims.length})`);
    }
    writer.u8(githubClaims.length);
    for (const claim of githubClaims) {
      const encoder = new TextEncoder();
      if (encoder.encode(claim.username).length > 255 || encoder.encode(claim.repository).length > 255) {
        throw new Error("GitHub verification claim too long");
      }
      writer.utf8(claim.username);
      writer.utf8(claim.repository);
    }
  },
  decode(reader, metadata) {
    const domains: DomainVerificationClaim[] = [];
    const domainCount = reader.u8();
    for (let i = 0; i < domainCount; i += 1) {
      const domain = reader.utf8();
      const methodCount = reader.u8();
      const methods: DomainVerificationMethod[] = [];
      for (let j = 0; j < methodCount; j += 1) {
        const method = DOMAIN_VERIFICATION_METHODS_BY_ID[reader.u8()];
        if (method === undefined) throw new Error("Unsupported domain verification method id");
        methods.push(method);
      }
      domains.push({ domain, ...(methods.length > 0 ? { methods } : {}) });
    }

    const github: GithubVerificationClaim[] = [];
    const githubCount = reader.u8();
    for (let i = 0; i < githubCount; i += 1) {
      const username = reader.utf8();
      const repository = reader.utf8();
      github.push({ username, ...(repository.length > 0 ? { repository } : {}) });
    }

    if (domains.length > 0 || github.length > 0) {
      metadata.verifications = {
        ...(domains.length > 0 ? { domains } : {}),
        ...(github.length > 0 ? { github } : {}),
      };
    }
  },
};
