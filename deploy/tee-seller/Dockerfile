# syntax=docker/dockerfile:1.7
#
# Official Antseed TEE seller image, for dstack (Phala) confidential VMs.
#
# The seller runs on a distroless runtime: no shell, no package manager, so nothing in the
# container can open a session into it, install or update code, or fetch plugins at runtime.
# The CLI, every provider plugin and the verifier prover come from the committed package-lock.json
# (see update-lock.mjs) via `npm ci`, so the commit determines all the code that sees prompts and
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
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
# The verifier must be the version this CLI pins (the CLI refuses any other), and must bind its quote
# to the buyer's connection and send the dstack event log; buyers reject a prover that does neither.
RUN node --input-type=module -e " \
      import { existsSync, readFileSync } from 'node:fs'; \
      const verifier = 'node_modules/@antseed/antseed-verifier/dist/'; \
      if (!(await import('./' + verifier + 'shared.js')).CHANNEL_BINDING_HEADER || !existsSync(verifier + 'dstack-event-log.js')) { \
        console.error('The locked verifier cannot bind attestations to the buyer connection; run update-lock.mjs with a CLI release that pins one that can.'); process.exit(1) } \
      const { TRUSTED_VERIFIER_PLUGINS } = await import('./node_modules/@antseed/cli/dist/plugins/registry.js'); \
      const pinned = TRUSTED_VERIFIER_PLUGINS.find((p) => p.name === 'antseed-verifier').version; \
      const installed = JSON.parse(readFileSync('node_modules/@antseed/antseed-verifier/package.json', 'utf8')).version; \
      if (pinned !== installed) { console.error('verifier ' + installed + ' installed, CLI pins ' + pinned); process.exit(1) }" \
    && mkdir -p /out/var/lib/antseed \
    && chown -R 65532:65532 /out/home/nonroot /out/var/lib/antseed

FROM ${RUNTIME_IMAGE}
ARG ANTSEED_VERSION
LABEL org.opencontainers.image.title="antseed-tee-seller" \
      org.opencontainers.image.description="Antseed seller for dstack confidential VMs" \
      org.opencontainers.image.source="https://github.com/AntSeed/antseed" \
      org.opencontainers.image.version="${ANTSEED_VERSION}"
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
ENTRYPOINT ["/nodejs/bin/node", "/home/nonroot/.antseed/plugins/node_modules/@antseed/cli/dist/cli/index.js", "--config", "/etc/antseed/config.json", "--data-dir", "/var/lib/antseed"]
CMD ["seller", "start", "--no-dashboard"]
