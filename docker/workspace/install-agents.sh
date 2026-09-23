#!/usr/bin/env bash
# Installs agent CLIs globally (into /usr/local). Each install is tolerant: a
# failing optional agent is logged but does not break the image build.
# Usage: install-agents.sh <spec>... ; alternatives for one slot can be
# given as "first|fallback" (the fallback is tried if the first fails).
# Agents not distributed via npm are given as "sh:<shell command>".
# A spec is an npm package spec, or "sh:<shell command>" for agents that are
# not distributed via npm (e.g. uv tools, release binaries).
set -u

failed=()
installed=()

for slot in "$@"; do
  ok=0
  # "sh:<command>" runs a shell command (may contain pipes, so no "|" fallbacks).
  if [[ "${slot}" == sh:* ]]; then
    echo ">>> ${slot#sh:}"
    if bash -o pipefail -c "${slot#sh:}"; then
      installed+=("${slot}")
    else
      echo "!!! failed: ${slot}" >&2
      failed+=("${slot}")
    fi
    continue
  fi
  IFS='|' read -r -a candidates <<<"$slot"
  for spec in "${candidates[@]}"; do
    echo ">>> npm install -g ${spec}"
    if npm install -g --no-audit --no-fund --loglevel=error "${spec}"; then
      installed+=("${spec}")
      ok=1
      break
    fi
    echo "!!! failed to install ${spec}" >&2
  done
  [ "$ok" = 1 ] || failed+=("${slot}")
done

mkdir -p /opt/vibe
{
  echo "# agent CLI install report ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
  for s in "${installed[@]}"; do echo "ok ${s}"; done
  for s in "${failed[@]}"; do echo "failed ${s}"; done
} >/opt/vibe/agents-install.txt
cat /opt/vibe/agents-install.txt

npm cache clean --force >/dev/null 2>&1 || true
exit 0
