#!/usr/bin/env bash
# Agentforge workspace entrypoint. Runs as root, fixes up the `coder` user and
# ownership of mount points, then drops privileges and starts wsd under tini.
set -euo pipefail

WSD_CMD=(node /opt/wsd/wsd.js)

# Already unprivileged (e.g. `docker run --user`): just start the daemon.
if [ "$(id -u)" != "0" ]; then
  cd "${WSD_ROOT:-/workspace}" 2>/dev/null || true
  exec tini -- "${WSD_CMD[@]}"
fi

log() { echo "[entrypoint] $*"; }

# --- remap coder uid/gid (edit passwd/group directly: usermod would chown
# --- the whole home recursively, including mounted agent dirs) -----------
if [ -n "${PGID:-}" ] && [ "${PGID}" != "$(id -g coder)" ]; then
  log "setting coder gid to ${PGID}"
  awk -F: -v OFS=: -v gid="${PGID}" '$1=="coder"{$3=gid} {print}' /etc/group >/etc/group.new && cat /etc/group.new >/etc/group && rm -f /etc/group.new
  awk -F: -v OFS=: -v gid="${PGID}" '$1=="coder"{$4=gid} {print}' /etc/passwd >/etc/passwd.new && cat /etc/passwd.new >/etc/passwd && rm -f /etc/passwd.new
fi
if [ -n "${PUID:-}" ] && [ "${PUID}" != "$(id -u coder)" ]; then
  log "setting coder uid to ${PUID}"
  awk -F: -v OFS=: -v uid="${PUID}" '$1=="coder"{$3=uid} {print}' /etc/passwd >/etc/passwd.new && cat /etc/passwd.new >/etc/passwd && rm -f /etc/passwd.new
fi

own() { chown coder:coder "$@" 2>/dev/null || true; }

# --- home: top level + image-provided dotfiles (never recursive into mounts)
own /home/coder
for f in /home/coder/.bashrc /home/coder/.profile /home/coder/.bash_logout; do
  [ -e "$f" ] && own "$f"
done

# Agent home dirs (from packages/shared/src/agents.ts `homeDirs`) plus parents.
AGENT_DIRS=(
  /home/coder/.claude
  /home/coder/.codex
  /home/coder/.local
  /home/coder/.local/share
  /home/coder/.local/share/opencode
  /home/coder/.local/share/kilo
  /home/coder/.config
  /home/coder/.config/opencode
  /home/coder/.config/kilo
  /home/coder/.cline
  /home/coder/.gemini
  /home/coder/.qwen
  /home/coder/.copilot
  /home/coder/.config/goose
  /home/coder/.local/share/goose
  /home/coder/.cache
)
for d in "${AGENT_DIRS[@]}"; do
  if [ ! -d "$d" ]; then
    mkdir -p "$d"
  fi
  own "$d"
done

# --- workspace + user tool volume (top level only) -----------------------
WSD_ROOT="${WSD_ROOT:-/workspace}"
mkdir -p "$WSD_ROOT"
own "$WSD_ROOT"

mkdir -p /opt/vibe-tools
own /opt/vibe-tools
for d in bin lib pnpm bun uv-tools; do
  [ -d "/opt/vibe-tools/$d" ] || { mkdir -p "/opt/vibe-tools/$d"; own "/opt/vibe-tools/$d"; }
done

# --- private runtime dir for wsd (git credential socket) -----------------
mkdir -p /run/wsd
chown coder:coder /run/wsd 2>/dev/null || true
chmod 700 /run/wsd

# --- auth token must be readable by coder --------------------------------
TOKEN_FILE="${WSD_TOKEN_FILE:-/run/vibe/wsd-token}"
if [ -f "$TOKEN_FILE" ] && ! gosu coder test -r "$TOKEN_FILE"; then
  mkdir -p /run/wsd
  install -m 0400 -o coder -g coder "$TOKEN_FILE" /run/wsd/token
  export WSD_TOKEN_FILE=/run/wsd/token
  log "copied unreadable token file to ${WSD_TOKEN_FILE}"
fi

cd "$WSD_ROOT"
exec gosu coder tini -- "${WSD_CMD[@]}"
