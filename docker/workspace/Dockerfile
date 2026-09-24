# syntax=docker/dockerfile:1.7
# Agentforge workspace image (agentforge-workspace).
# Build from the repo root:
#   docker build -f docker/workspace/Dockerfile -t agentforge-workspace:dev .
#
# Agent CLI versions default to "latest" at build time; pin them with
# --build-arg CLAUDE_CODE_VERSION=2.1.280 etc.

ARG NODE_IMAGE=node:22-bookworm

# ---------------------------------------------------------------------------
# Stage 1: build the workspace daemon (wsd) and a linux node-pty
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS wsd-build
ARG PNPM_VERSION=10.34.5
RUN npm install -g --no-audit --no-fund pnpm@${PNPM_VERSION}
WORKDIR /src

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/agent-adapters/package.json packages/agent-adapters/
COPY packages/workspace-daemon/package.json packages/workspace-daemon/
RUN pnpm install --frozen-lockfile --filter "@vibe/workspace-daemon..." \
 || pnpm install --no-frozen-lockfile --filter "@vibe/workspace-daemon..."

COPY packages/shared packages/shared
COPY packages/agent-adapters packages/agent-adapters
COPY packages/workspace-daemon packages/workspace-daemon
RUN pnpm --filter @vibe/shared build \
 && pnpm --filter @vibe/agent-adapters build \
 && pnpm --filter @vibe/workspace-daemon build

# Self-contained runtime dir: bundled wsd.js + node-pty compiled on this base.
RUN set -eux; \
    PTY_VERSION="$(node -p "require('/src/packages/workspace-daemon/node_modules/node-pty/package.json').version")"; \
    mkdir -p /opt/wsd; \
    cp packages/workspace-daemon/dist/wsd.js packages/workspace-daemon/dist/wsd.js.map packages/workspace-daemon/dist/agentforge-mcp.js /opt/wsd/; \
    cd /opt/wsd; \
    printf '{"name":"wsd-runtime","private":true,"type":"module"}\n' > package.json; \
    npm install --omit=dev --no-audit --no-fund --no-save "node-pty@${PTY_VERSION}"; \
    node -e "require('node-pty')"
# git credential helper (asks wsd over its local socket; tokens stay in wsd memory)
RUN cp packages/workspace-daemon/scripts/git-credential-vibe /opt/wsd/git-credential-vibe
# Access token of a ChatGPT subscription provider for Codex (`auth.command`), asked from the app via wsd
RUN cp packages/workspace-daemon/scripts/agentforge-chatgpt-token /opt/wsd/agentforge-chatgpt-token

# ---------------------------------------------------------------------------
# Stage 2: the workspace image
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE}

ARG PNPM_VERSION=10.34.5
ARG BUN_VERSION=latest
ARG PLAYWRIGHT_MCP_VERSION=latest
ARG CLAUDE_CODE_VERSION=latest
ARG CLAUDE_AGENT_ACP_VERSION=latest
ARG CODEX_VERSION=latest
ARG OPENCODE_VERSION=latest
ARG CLINE_VERSION=latest
ARG KILOCODE_VERSION=latest
ARG GEMINI_CLI_VERSION=latest
ARG QWEN_CODE_VERSION=latest
ARG COPILOT_CLI_VERSION=latest
ARG AIDER_VERSION=
ARG GOOSE_VERSION=latest

LABEL org.opencontainers.image.title="agentforge-workspace" \
      org.opencontainers.image.description="Agentforge workspace: dev toolchain, agent CLIs and the workspace daemon (wsd)" \
      org.opencontainers.image.source="https://github.com/gottschalkfelix4-source/agentforge" \
      org.opencontainers.image.licenses="MIT"

ENV DEBIAN_FRONTEND=noninteractive
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Base tooling
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini gosu git git-lfs curl wget ca-certificates openssh-client gnupg \
      build-essential python3 python3-pip python3-venv \
      ripgrep fd-find jq less vim-tiny nano unzip zip procps locales bash-completion \
 && sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen \
 && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
 && git lfs install --system \
 && rm -rf /var/lib/apt/lists/*

# GitHub CLI (official apt repo)
RUN mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Docker Engine for projects with "Docker im Workspace" (daemon only starts when AGENTFORGE_DOCKER=1;
# the workspace then runs privileged with its own /var/lib/docker volume).
RUN curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update && apt-get install -y --no-install-recommends \
      docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin iptables \
 && rm -rf /var/lib/apt/lists/*

# uv / uvx (Python)
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# User `coder` (uid/gid 1000) replaces the base image's `node` user.
RUN userdel -r node 2>/dev/null || true; groupdel node 2>/dev/null || true; \
    groupadd -g 1000 coder \
 && useradd -m -u 1000 -g 1000 -s /bin/bash coder \
 && (getent group docker >/dev/null || groupadd docker) && usermod -aG docker coder \
 && git config --system init.defaultBranch main \
 && git config --system --add safe.directory '*' \
 && git config --system pull.rebase false
COPY docker/workspace/bashrc /home/coder/.bashrc
COPY docker/workspace/profile.sh /etc/profile.d/vibe.sh
RUN sed -i 's/\r$//' /home/coder/.bashrc /etc/profile.d/vibe.sh \
 && chown coder:coder /home/coder/.bashrc && chmod 644 /etc/profile.d/vibe.sh

# JS package managers
RUN npm install -g --no-audit --no-fund pnpm@${PNPM_VERSION} bun@${BUN_VERSION} \
 && bun --version && pnpm --version \
 && npm cache clean --force

# Playwright MCP + Chromium (with system deps)
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npm install -g --no-audit --no-fund @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} \
 && PW_DIR="$(dirname "$(node -e "console.log(require.resolve('playwright/package.json',{paths:['$(npm root -g)/@playwright/mcp']}))")")" \
 && node "${PW_DIR}/cli.js" install --with-deps chromium \
 && chmod -R a+rX /opt/ms-playwright \
 && rm -rf /var/lib/apt/lists/* \
 && npm cache clean --force

# Agent CLIs (tolerant: failures are logged to /opt/vibe/agents-install.txt)
COPY docker/workspace/install-agents.sh /usr/local/bin/install-agents.sh
RUN sed -i 's/\r$//' /usr/local/bin/install-agents.sh && chmod 755 /usr/local/bin/install-agents.sh \
 && install-agents.sh \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@agentclientprotocol/claude-agent-acp@${CLAUDE_AGENT_ACP_VERSION}|@zed-industries/claude-agent-acp@latest" \
      "@openai/codex@${CODEX_VERSION}" \
      "opencode-ai@${OPENCODE_VERSION}" \
      "cline@${CLINE_VERSION}" \
      "@kilocode/cli@${KILOCODE_VERSION}" \
      "@google/gemini-cli@${GEMINI_CLI_VERSION}" \
      "@qwen-code/qwen-code@${QWEN_CODE_VERSION}" \
      "@github/copilot@${COPILOT_CLI_VERSION}" \
      "sh:UV_TOOL_DIR=/usr/local/share/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin uv tool install --python /usr/bin/python3 aider-chat${AIDER_VERSION:+==${AIDER_VERSION}} && chmod -R a+rX /usr/local/share/uv-tools && rm -rf /root/.cache/uv" \
      "sh:G=${GOOSE_VERSION}; U=https://github.com/block/goose/releases/latest/download; [ \"\$G\" = latest ] || U=https://github.com/block/goose/releases/download/v\${G#v}; T=\$(mktemp -d); curl -fsSL \"\$U/goose-\$(uname -m)-unknown-linux-gnu.tar.bz2\" | tar -xj -C \"\$T\" && install -m 755 \"\$(find \"\$T\" -type f -name goose | head -n1)\" /usr/local/bin/goose; rc=\$?; rm -rf \"\$T\"; exit \$rc"

# Workspace daemon
COPY --from=wsd-build /opt/wsd /opt/wsd
RUN sed -i 's/\r$//' /opt/wsd/git-credential-vibe /opt/wsd/agentforge-chatgpt-token \
 && chmod 755 /opt/wsd/git-credential-vibe /opt/wsd/agentforge-chatgpt-token \
 && git config --system credential.helper /opt/wsd/git-credential-vibe \
 && printf '#!/bin/sh\nexec node /opt/wsd/agentforge-mcp.js "$@"\n' > /usr/local/bin/agentforge-mcp \
 && chmod 755 /usr/local/bin/agentforge-mcp
COPY docker/workspace/entrypoint.sh /usr/local/bin/vibe-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/vibe-entrypoint.sh && chmod 755 /usr/local/bin/vibe-entrypoint.sh \
 && mkdir -p /workspace /opt/vibe-tools/bin /opt/vibe-tools/lib /run/vibe \
 && chown coder:coder /workspace /opt/vibe-tools /opt/vibe-tools/bin /opt/vibe-tools/lib

# User-updatable tools live in /opt/vibe-tools (mount a volume there):
# `npm i -g`, `pnpm add -g`, `bun add -g` and `uv tool install` from inside the
# workspace land there and shadow the image's versions via PATH.
ARG VIBE_VERSION=dev
ENV VIBE_VERSION=${VIBE_VERSION} \
    HOST=0.0.0.0 \
    WSD_ROOT=/workspace \
    WSD_PORT=7777 \
    SHELL=/bin/bash \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    NPM_CONFIG_PREFIX=/opt/vibe-tools \
    PNPM_HOME=/opt/vibe-tools/pnpm \
    BUN_INSTALL=/opt/vibe-tools/bun \
    UV_TOOL_DIR=/opt/vibe-tools/uv-tools \
    UV_TOOL_BIN_DIR=/opt/vibe-tools/bin \
    DISABLE_AUTOUPDATER=1 \
    PATH=/opt/vibe-tools/bin:/opt/vibe-tools/pnpm:/opt/vibe-tools/bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /workspace
EXPOSE 7777
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${WSD_PORT:-7777}/health" || exit 1

ENTRYPOINT ["/usr/local/bin/vibe-entrypoint.sh"]
