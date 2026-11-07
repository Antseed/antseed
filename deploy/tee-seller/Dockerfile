# syntax=docker/dockerfile:1.7
#
# Official Antseed TEE seller image, for dstack (Phala) confidential VMs.
#
# The seller runs on a distroless runtime: no shell, no package manager, so nothing in the
# container can open a session into it, install or update code, or fetch plugins at runtime.
# The CLI, every provider plugin and the verifier prover come from the committed package-lock.json
# (written by update-lock.mjs for a CLI release) via `npm ci`, so the commit determines all the code that sees prompts and
# the image digest (pinned in the app compose, measured into RTMR3) names it.
#
# Built and published by .github/workflows/tee-seller-image.yml; see deploy/tee-seller/README.md.

ARG BUILD_IMAGE=node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a

FROM ${BUILD_IMAGE} AS build
# Build tools in case a native module (better-sqlite3, node-datachannel) has no prebuild.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ cmake \
    && rm -rf /var/lib/apt/lists/*
# The CLI loads plugins from ~/.antseed/plugins of the runtime user (HOME=/home/nonroot), so the
# whole locked tree, CLI included, is installed there.
WORKDIR /out/home/nonroot/.antseed/plugins
COPY package.json package-lock.json check-lock.mjs ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
# Refuse a lock whose code buyers would reject or that weakens their checks (see check-lock.mjs).
RUN node check-lock.mjs && rm check-lock.mjs \
    && mkdir -p /out/var/lib/antseed \
    && chown -R 65532:65532 /out/home/nonroot /out/var/lib/antseed

FROM ${RUNTIME_IMAGE}
ARG ANTSEED_VERSION
LABEL org.opencontainers.image.title="antseed-tee-seller" \
      org.opencontainers.image.description="Antseed seller for dstack confidential VMs" \
      org.opencontainers.image.source="https://github.com/AntSeed/antseed" \
      org.opencontainers.image.version="${ANTSEED_VERSION}"
# Google Confidential Space launch policy: the operator may set only these env variables (the
# token shows them to buyers, who check them against the same rules) and can't replace the
# command. The operator may send the container's output to Cloud Logging: the seller runs in
# content-free mode (launch.mjs), so its logs hold no prompts or answers, nor upstream error text about a request.
LABEL "tee.launch_policy.allow_env_override"="ANTSEED_TEE_PEER_ID,ANTSEED_BASE_RPC_URL,ANTSEED_SELLER_CONFIG_JSON,ANTSEED_GCP_SECRETS,ANTSEED_GCP_STATE,OPENAI_BODY_INJECT_JSON,ANTSEED_VERIFIER_PROVIDER_ADAPTER,ANTSEED_VERIFIER_PROVIDER_EVIDENCE_URL,ANTSEED_VERIFIER_PROVIDER_TEE_FIELD,ANTSEED_VERIFIER_PROVIDER_GPU_FIELD,ANTSEED_VERIFIER_PROVIDER_CLAIMS_FIELD,ANTSEED_VERIFIER_PROVIDER_BINDING_SCHEME,ANTSEED_VERIFIER_PROVIDER_BINDING_PUBKEY_FIELD" \
      "tee.launch_policy.allow_cmd_override"="false" \
      "tee.launch_policy.log_redirect"="always"
COPY --from=build /out/ /
COPY launch.mjs state.mjs /home/nonroot/
ENV HOME=/home/nonroot \
    NODE_ENV=production \
    ANTSEED_NO_UPDATE_CHECK=1 \
    ANTSEED_VERIFIER_SDKS=antseed-verifier
USER 65532:65532
VOLUME ["/var/lib/antseed"]
# launch.mjs picks the TEE (dstack or Google Confidential Space) and its seller config; the
# dashboard, which can change settings at runtime, stays off.
ENTRYPOINT ["/nodejs/bin/node", "/home/nonroot/launch.mjs"]
CMD ["seller", "start", "--no-dashboard"]
