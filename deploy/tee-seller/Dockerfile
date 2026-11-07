# syntax=docker/dockerfile:1.7
#
# Official Antseed TEE seller image, for dstack (Phala) confidential VMs.
#
# The seller runs on a distroless runtime: no shell, no package manager, so nothing in the
# container can open a session into it, install or update code, or fetch plugins at runtime.
# The CLI, every provider plugin and the verifier prover are fixed at build time, so the image
# digest (pinned in the app compose, measured into RTMR3) names all the code that sees prompts.
#
# Built and published by .github/workflows/tee-seller-image.yml from an npm-published CLI
# version; see deploy/tee-seller/README.md.

ARG BUILD_IMAGE=node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a

FROM ${BUILD_IMAGE} AS build
ARG ANTSEED_VERSION
RUN test -n "${ANTSEED_VERSION}"
# Build tools in case a native module (better-sqlite3, node-datachannel) has no prebuild.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ cmake \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g --prefix /opt/antseed "@antseed/cli@${ANTSEED_VERSION}" \
    && npm cache clean --force
# Plugins live where the CLI loads them for the runtime user (HOME=/home/nonroot). The verifier
# goes in at the exact version this CLI pins; the CLI refuses any other.
RUN set -eu; \
    CLI=/opt/antseed/lib/node_modules/@antseed/cli; \
    VERIFIER=$(node -e "import('$CLI/dist/plugins/registry.js').then(m => console.log(m.TRUSTED_VERIFIER_PLUGINS.find(p => p.name === 'antseed-verifier').version))"); \
    mkdir -p /out/home/nonroot/.antseed/plugins /out/var/lib/antseed; \
    cd /out/home/nonroot/.antseed/plugins; \
    npm init -y >/dev/null; \
    npm install --ignore-scripts \
      @antseed/provider-anthropic @antseed/provider-openai @antseed/provider-openai-responses \
      @antseed/provider-local-llm @antseed/provider-typesafe @antseed/provider-venice-video \
      @antseed/provider-fal-video @antseed/provider-alibaba-video @antseed/provider-core \
      "@antseed/antseed-verifier@${VERIFIER}"; \
    npm cache clean --force; \
    npm ls --all --omit=dev > /out/home/nonroot/.antseed/plugins/INSTALLED.txt || true; \
    chown -R 65532:65532 /out/home/nonroot /out/var/lib/antseed

FROM ${RUNTIME_IMAGE}
ARG ANTSEED_VERSION
LABEL org.opencontainers.image.title="antseed-tee-seller" \
      org.opencontainers.image.description="Antseed seller for dstack confidential VMs" \
      org.opencontainers.image.source="https://github.com/AntSeed/antseed" \
      org.opencontainers.image.version="${ANTSEED_VERSION}"
COPY --from=build /opt/antseed/lib/node_modules /opt/antseed/node_modules
COPY --from=build /out/ /
ENV HOME=/home/nonroot \
    NODE_ENV=production \
    ANTSEED_NO_UPDATE_CHECK=1 \
    ANTSEED_VERIFIER_SDKS=antseed-verifier \
    ANTSEED_VERIFIER_NODE_TEE=dstack
USER 65532:65532
VOLUME ["/var/lib/antseed"]
# The seller config comes from the app compose (/etc/antseed/config.json); the dashboard, which
# can change settings at runtime, stays off.
ENTRYPOINT ["/nodejs/bin/node", "/opt/antseed/node_modules/@antseed/cli/dist/cli/index.js", "--config", "/etc/antseed/config.json", "--data-dir", "/var/lib/antseed"]
CMD ["seller", "start", "--no-dashboard"]
