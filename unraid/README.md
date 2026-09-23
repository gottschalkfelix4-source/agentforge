# Unraid-Template

`agentforge.xml` ist ein Community-Applications-/dockerMan-Template, `icon.png` das Icon (256×256, gleiches Logo
wie das Favicon der Web-UI).

## 1. Veröffentlichen (einmalig, als Maintainer)

1. Repository nach GitHub pushen. Der Workflow `.github/workflows/images.yml` baut und pusht
   `ghcr.io/gottschalkfelix4-source/agentforge` und `ghcr.io/gottschalkfelix4-source/agentforge-workspace` (linux/amd64 + linux/arm64)
   bei jedem Push auf `main` (`latest`) und bei Tags `v*` (`1.2.3`, `1.2`, `1`).
2. Beide Pakete **öffentlich** machen: GitHub → Profil/Organisation → *Packages* → `agentforge` →
   *Package settings* → *Change visibility* → *Public*. Dasselbe für `agentforge-workspace`.
   (Sonst kann Unraid nur nach `docker login ghcr.io` ziehen.)
3. Forks: `gottschalkfelix4-source` in `agentforge.xml` durch den eigenen GitHub-Benutzer/die Organisation in
   **Kleinbuchstaben** ersetzen (GHCR-Namen sind klein geschrieben).

## 2. Auf Unraid installieren

Eine der beiden Varianten:

- **Template-Repository (empfohlen, Template bleibt aktuell):**
  Unraid → *Docker* → unten *Template repositories* → `https://github.com/gottschalkfelix4-source/agentforge` eintragen →
  *Save*. Dann *Add Container* → *Template* → unter den User-Templates **Agentforge** wählen.
- **Manuell:** XML auf den USB-Stick kopieren:
  ```bash
  wget -O /boot/config/plugins/dockerMan/templates-user/my-Agentforge.xml \
    https://raw.githubusercontent.com/gottschalkfelix4-source/agentforge/main/unraid/agentforge.xml
  ```
  Unraid → *Docker* → *Add Container* → *Template* → `Agentforge`.

## 3. Ausfüllen

| Feld | Wert |
|---|---|
| AppData | `/mnt/user/appdata/agentforge` (oder `/mnt/cache/appdata/agentforge`) |
| **HOST_DATA_PATH** | exakt derselbe Pfad wie AppData – Workspace-Container binden Unterordner davon ein |
| **Secret Key** | `openssl rand -hex 32` – im Passwort-Manager sichern, später nie ändern |
| Web UI Port | 8080 (oder ein freier Port) |
| Preview Ports | `7100-7119` – Host- und Container-Bereich müssen identisch sein |
| Workspace Idle Stop | z. B. `60`, um inaktive Workspaces nach einer Stunde zu stoppen (0 = aus) |

Erweitert: `PREVIEW_MODE`/`PREVIEW_DOMAIN` (Subdomain-Previews hinter Reverse Proxy), `GITHUB_CLIENT_ID`
(eigene OAuth-App), `AGENTFORGE_SECURE_COOKIES=1` (nur HTTPS), CPU/RAM je Workspace, `PUID`/`PGID`
(99/100 = `nobody:users`).

Container starten, Log öffnen (*Docker* → Agentforge-Icon → *Logs*) und den **Setup-Token** kopieren
(auch in `/mnt/user/appdata/agentforge/setup-token.txt`). Web-UI öffnen und den Admin anlegen.

Mehr: [../docs/installation.md](../docs/installation.md), [../docs/backup.md](../docs/backup.md),
[../docs/troubleshooting.md](../docs/troubleshooting.md).
