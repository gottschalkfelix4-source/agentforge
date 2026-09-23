<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img alt="Agentforge" src="docs/assets/logo-light.svg" width="354">
  </picture>
</p>

<p align="center"><b>Die selbst gehostete Schmiede für Coding-Agents</b> – Claude Code, Codex, OpenCode, Cline, Kilo, Gemini, Qwen, Copilot, Goose &amp; Aider in einer Web-UI.<br>Docker &amp; Unraid · Workspace-Container pro Projekt · Agent-Chat · GitHub · Live-Vorschau · Projektmanagement</p>

# Agentforge

Selbst gehostete Vibecoding-Plattform: Claude Code, Codex CLI, OpenCode, Cline, Kilo Code, Gemini CLI u. a.
in einer Web-UI – jedes Projekt in einem eigenen, isolierten Workspace-Container. Läuft per Docker und
(später) als Unraid-Template.

Stand: Phasen 1–7 umgesetzt (Workspaces, Agent-Chat, GitHub, Live-Vorschau, Projektmanagement, Agent-/Provider-Verwaltung, Release/Unraid). Details in `docs/`.

## Aufbau

```
apps/web                  React-SPA (Vite, Tailwind, xterm.js, Monaco)
apps/server               Fastify-Server: Auth, API, Docker-Orchestrierung, Terminal-Bridge
packages/shared           Gemeinsame Typen & Protokolle, Agent-Manifeste
packages/workspace-daemon wsd – läuft in jedem Workspace-Container (PTYs, Dateien, Ports)
docker/                   Dockerfiles (App + Workspace) und compose.yml
unraid/                   Unraid-CA-Template
```

## Entwicklung (lokal, Docker Desktop)

```bash
pnpm install
pnpm --filter @vibe/shared build
docker build -f docker/workspace/Dockerfile -t agentforge-workspace:dev .
pnpm --filter @vibe/server dev     # http://localhost:8787
pnpm --filter @vibe/web dev        # http://localhost:5180
```

Beim ersten Start steht der Setup-Token im Server-Log und in `apps/server/.data/setup-token.txt`.

## Betrieb

Fertige Multi-Arch-Images (amd64/arm64): `ghcr.io/gottschalkfelix4-source/agentforge` und `ghcr.io/gottschalkfelix4-source/agentforge-workspace`.

```bash
cd docker
cp ../.env.example .env            # AGENTFORGE_SECRET_KEY, HOST_DATA_PATH, AGENTFORGE_IMAGE, WORKSPACE_IMAGE setzen
docker compose pull && docker compose up -d      # http://<host>:8080
# oder aus dem Quellcode: docker compose --profile build-only build workspace-image && docker compose up -d --build
```

Wichtig: `HOST_DATA_PATH` muss der Pfad des `/data`-Volumes **auf dem Docker-Host** sein, da der Server
Projektordner und Agent-Logins als Bind-Mounts in die Workspace-Container einhängt.

- [Installation](docs/installation.md) – Compose, Unraid, Setup-Token, Reverse Proxy (NPM/SWAG/Traefik), Preview-Subdomains
- [Unraid-Template](unraid/README.md) – veröffentlichen und installieren
- [Backup & Wiederherstellung](docs/backup.md) – Export unter *Einstellungen → System*
- [Sicherheit](docs/security.md) · [Fehlersuche](docs/troubleshooting.md) · [API](docs/api.md)

Releases: Tag `vX.Y.Z` pushen → GitHub Actions baut und veröffentlicht beide Images (`.github/workflows/images.yml`).

## Agents anmelden

- **Abo-Login:** Im Projekt „Agent starten → <Agent> → Anmelden (Abo-Login)“. Logins liegen in
  `/data/agent-home/` und gelten für alle Workspaces.
- **API-Keys / eigene Endpunkte / Ollama:** Einstellungen → Provider anlegen, dann ein Agent-Profil mit
  „Provider/API-Key“ erstellen. Keys werden AES-256-GCM-verschlüsselt gespeichert und nur dem jeweiligen
  Agent-Prozess übergeben (nie als Container-Umgebung).

## Sicherheit

Die App braucht den Docker-Socket (entspricht Root auf dem Host). Workspaces werden ausschließlich aus einem
festen, gehärteten Template erzeugt (keine Privilegien, `cap-drop ALL` + Minimum, `no-new-privileges`,
Ressourcenlimits) und tragen das Label `vibe.managed=true`; andere Container werden nie angefasst.
Details und Empfehlungen (VPN/Reverse Proxy, Abo-Logins): [docs/security.md](docs/security.md).
