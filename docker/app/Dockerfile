# syntax=docker/dockerfile:1.7
# Agentforge app image (agentforge): web UI + API server.
# Build from the repo root:
#   docker build -f docker/app/Dockerfile -t agentforge:dev .

ARG NODE_IMAGE=node:22-bookworm
ARG RUNTIME_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------------------
# Stage 1: compile shared, web and server – on the build machine's own
# architecture: the output is plain JavaScript, identical for every target, and
# compiling it under QEMU (arm64) took several minutes.
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS compile
ARG PNPM_VERSION=10.34.5
RUN npm install -g --no-audit --no-fund pnpm@${PNPM_VERSION}
WORKDIR /src

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --filter "@vibe/server..." --filter "@vibe/web..."  || pnpm install --no-frozen-lockfile --filter "@vibe/server..." --filter "@vibe/web..."

COPY packages/shared packages/shared
COPY apps/web apps/web
COPY apps/server apps/server
RUN pnpm --filter @vibe/shared build  && pnpm --filter @vibe/web build  && pnpm --filter @vibe/server build

# ---------------------------------------------------------------------------
# Stage 2: pruned production deploy of the server – on the target
# architecture, because native deps (@node-rs/argon2) ship per-arch binaries
# and must match the Debian release of the runtime image. dist folders are
# copied explicitly because packing may honour .gitignore (which ignores dist/).
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION=10.34.5
RUN npm install -g --no-audit --no-fund pnpm@${PNPM_VERSION}
WORKDIR /src

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --prod --filter "@vibe/server..."  || pnpm install --no-frozen-lockfile --prod --filter "@vibe/server..."

COPY --from=compile /src/packages/shared/dist packages/shared/dist
COPY --from=compile /src/apps/server/dist apps/server/dist
RUN pnpm --filter @vibe/server deploy --prod --legacy /out  && rm -rf /out/dist && cp -r apps/server/dist /out/dist  && SHARED_DIR="$(cd /out && node -p "require('path').dirname(require.resolve('@vibe/shared/package.json'))" 2>/dev/null || true)"  && if [ -n "$SHARED_DIR" ]; then rm -rf "$SHARED_DIR/dist" && cp -r packages/shared/dist "$SHARED_DIR/dist"; fi  && test -f /out/dist/index.js

# ---------------------------------------------------------------------------
# Stage 3: runtime
# ---------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE}

LABEL org.opencontainers.image.title="agentforge" \
      org.opencontainers.image.description="Agentforge: self-hosted vibecoding platform (web UI + server)" \
      org.opencontainers.image.source="https://github.com/gottschalkfelix4-source/agentforge" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /out /app
COPY --from=compile /src/apps/web/dist /app/public

# Runs as root so it can talk to the mounted Docker socket (its group id
# differs between hosts).
ARG VIBE_VERSION=0.1.0-dev
ENV VIBE_VERSION=${VIBE_VERSION} \
    NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    VIBE_WEB_DIST=/app/public \
    VIBE_DATA_DIR=/data \
    PORT=8080

VOLUME /data
EXPOSE 8080 7100-7119
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-8080}/api/health" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
