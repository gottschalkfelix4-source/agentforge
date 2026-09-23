# Installation & Betrieb

Agentforge besteht aus zwei Images:

| Image | Zweck |
|---|---|
| `ghcr.io/gottschalkfelix4-source/agentforge` | Web-UI + API-Server. Läuft dauerhaft, braucht den Docker-Socket. |
| `ghcr.io/gottschalkfelix4-source/agentforge-workspace` | Vorlage für die Projekt-Workspaces (Toolchain, Agent-CLIs, Workspace-Daemon). Wird vom Server bei Bedarf gezogen – nicht selbst starten. |

Beide gibt es für `linux/amd64` und `linux/arm64`. Tags: `latest` (Stand `main`), `1.2.3` / `1.2` / `1` (Releases),
`sha-<commit>`.

## Voraussetzungen

- Docker ≥ 24 (Linux, Unraid, Docker Desktop). Ca. 6 GB Platz für das Workspace-Image, dazu Projekte/Caches.
- RAM: Server ~150 MB; jeder laufende Workspace bis zum konfigurierten Limit (Standard 8 GB, 4 CPUs).

## Pflicht-Einstellungen

| Variable | Bedeutung |
|---|---|
| `AGENTFORGE_SECRET_KEY` | Langer Zufallswert (`openssl rand -hex 32`). Verschlüsselt gespeicherte API-Keys/Tokens (AES-256-GCM). **Sicher aufbewahren und nie ändern** – ohne ihn sind gespeicherte Secrets verloren. Fehlt er, erzeugt Agentforge `/data/secret.key` (schwächer: Schlüssel liegt neben den Daten). |
| `HOST_DATA_PATH` | Pfad des `/data`-Volumes **auf dem Docker-Host**. Siehe unten. |
| `WORKSPACE_IMAGE` | Workspace-Image, z. B. `ghcr.io/gottschalkfelix4-source/agentforge-workspace:latest`. |

### Der HOST_DATA_PATH-Stolperstein

Der Server legt Workspace-Container über den Docker-Socket an und bindet Unterordner von `/data`
(`projects/<id>`, `agent-home/…`, `tools`, `cache/…`) per Bind-Mount ein. Diese Mount-Quellen wertet der
**Docker-Daemon auf dem Host** aus – nicht der Agentforge-Container. Deshalb muss `HOST_DATA_PATH` exakt der
Host-Pfad sein, der als `/data` gemountet ist:

| Setup | Volume | HOST_DATA_PATH |
|---|---|---|
| Unraid | `/mnt/user/appdata/agentforge:/data` | `/mnt/user/appdata/agentforge` |
| Compose (Linux) | `./.data:/data` in `/opt/agentforge/docker` | `/opt/agentforge/docker/.data` |
| Docker Desktop (Windows) | `./.data:/data` | `C:/Users/me/agentforge/docker/.data` |

Falsch gesetzt → Workspaces starten mit leerem `/workspace`, Dateien „verschwinden“ oder der Start scheitert
mit `invalid mount config` / `bind source path does not exist`. Named Volumes funktionieren **nicht** – es muss
ein Bind-Mount sein. Einstellungen → System zeigt den aktuellen Wert an.

## Variante A: Docker Compose

```bash
git clone https://github.com/gottschalkfelix4-source/agentforge.git && cd agentforge/docker
cp ../.env.example .env
# .env bearbeiten:
#   AGENTFORGE_SECRET_KEY=$(openssl rand -hex 32)
#   HOST_DATA_PATH=/opt/agentforge/docker/.data        # absoluter Host-Pfad von ./.data
#   AGENTFORGE_IMAGE=ghcr.io/gottschalkfelix4-source/agentforge:latest
#   WORKSPACE_IMAGE=ghcr.io/gottschalkfelix4-source/agentforge-workspace:latest
docker compose pull
docker compose up -d
docker compose logs agentforge | grep -A1 Setup-Token
```

Aus dem Quellcode bauen statt ziehen: `AGENTFORGE_IMAGE`/`WORKSPACE_IMAGE` weglassen und
`docker compose --profile build-only build workspace-image && docker compose up -d --build`.

Update: `docker compose pull && docker compose up -d`, danach in der UI *Einstellungen → System →
Workspace-Image aktualisieren* und pro Projekt *Neu erstellen* (Dateien und Logins bleiben erhalten).

## Variante B: Unraid

Siehe [`unraid/README.md`](../unraid/README.md): Template-Repository hinzufügen oder XML nach
`/boot/config/plugins/dockerMan/templates-user/` kopieren, dann *Add Container → Agentforge*.
AppData und `HOST_DATA_PATH` identisch setzen, Secret Key eintragen.

## Erster Start: Setup-Token

Solange kein Admin existiert, erzeugt der Server einen einmaligen Setup-Token, schreibt ihn ins Log
(`Agentforge Setup-Token: …`) und nach `/data/setup-token.txt`. Web-UI öffnen, Token + Benutzername + Passwort
(≥ 8 Zeichen) eingeben. Danach wird die Datei gelöscht. Es gibt genau einen Admin-Account.

## Optionale Variablen

| Variable | Standard | Bedeutung |
|---|---|---|
| `WORKSPACE_IDLE_MINUTES` | `0` | Workspaces nach N Minuten ohne laufende Agent-Sitzung und ohne Terminal-Prozess stoppen (0 = aus). In der UI überschreibbar. |
| `WORKSPACE_CPUS` / `WORKSPACE_MEMORY_MB` | `4` / `8192` | Limits je Workspace. |
| `PREVIEW_MODE` | `port` | `port`: Previews auf `PREVIEW_PORT_START…+COUNT-1` (Standard 7100–7119). `subdomain`: über `https://p<N>.<PREVIEW_DOMAIN>` am Hauptport. |
| `PREVIEW_DOMAIN` | – | Nur für `subdomain`, z. B. `preview.example.com`. |
| `PREVIEW_PORT_START` / `PREVIEW_PORT_COUNT` | `7100` / `20` | Port-Bereich (muss mit dem veröffentlichten Bereich übereinstimmen). |
| `GITHUB_CLIENT_ID` | – | Client-ID einer eigenen GitHub-OAuth-App (Device Flow aktiviert). Alternativ in der UI. |
| `AGENTFORGE_SECURE_COOKIES` | `0` | `1`, wenn Agentforge nur per HTTPS erreichbar ist (Cookie mit `Secure`). |
| `AGENTFORGE_ALLOWED_ORIGINS` | – | Zusätzliche erlaubte Origins für WebSockets (kommagetrennt). |
| `PUID` / `PGID` | – | Besitzer der Projektdateien in den Workspaces (Unraid: 99/100). |
| `TZ` | – | Zeitzone, wird an Workspaces weitergereicht. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |

## Reverse Proxy (HTTPS)

Agentforge nutzt WebSockets (`/ws`, `/ws/term/…`). Der Proxy muss `Upgrade`/`Connection` durchreichen und lange
Verbindungen erlauben. Hinter HTTPS `AGENTFORGE_SECURE_COOKIES=1` setzen. Uploads bis 25 MB.

### Nginx Proxy Manager (NPM)

Proxy Host → Forward `http://<unraid-ip>:8080`, **Websockets Support** aktivieren, SSL-Zertifikat anfordern,
*Force SSL*. Unter *Advanced*:

```nginx
client_max_body_size 25m;
proxy_read_timeout 1d;
proxy_send_timeout 1d;
```

### SWAG (linuxserver)

`/config/nginx/proxy-confs/agentforge.subdomain.conf`:

```nginx
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name vibe.*;
    include /config/nginx/ssl.conf;
    client_max_body_size 25m;

    location / {
        include /config/nginx/proxy.conf;      # setzt Upgrade/Connection + X-Forwarded-*
        include /config/nginx/resolver.conf;
        set $upstream_app agentforge;            # Containername (gleiches Docker-Netz) oder IP
        set $upstream_port 8080;
        set $upstream_proto http;
        proxy_pass $upstream_proto://$upstream_app:$upstream_port;
        proxy_read_timeout 1d;
    }
}
```

### Traefik (Labels)

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.agentforge.rule=Host(`vibe.example.com`)
  - traefik.http.routers.agentforge.entrypoints=websecure
  - traefik.http.routers.agentforge.tls.certresolver=le
  - traefik.http.services.agentforge.loadbalancer.server.port=8080
```

Traefik reicht WebSockets automatisch durch.

### Plain nginx

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;   # map $http_upgrade → "upgrade"/"close"
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 1d;
    client_max_body_size 25m;
}
```

### Previews über Subdomains (Wildcard)

Im Port-Modus sind Previews unter `http(s)://<host>:7100…7119` erreichbar – hinter einem Reverse Proxy
muss man diese Ports zusätzlich freigeben. Eleganter ist der Subdomain-Modus:

1. DNS: Wildcard-Eintrag `*.preview.example.com` → IP des Reverse Proxys (bei Cloudflare nur mit einem
   Plan, der Wildcard-Proxying erlaubt, sonst „DNS only“).
2. Zertifikat: Wildcard-Zertifikat für `*.preview.example.com` (erfordert DNS-Challenge, z. B. NPM →
   *SSL Certificates → Add → Use a DNS Challenge*; SWAG: `SUBDOMAINS=wildcard`, `VALIDATION=dns`).
3. Proxy: Host `*.preview.example.com` → `http://<agentforge>:8080`, WebSockets an, `Host`-Header
   unverändert durchreichen (NPM tut das automatisch; bei Traefik
   ``HostRegexp(`^p[0-9]+\.preview\.example\.com$`)``).
4. Agentforge: `PREVIEW_MODE=subdomain`, `PREVIEW_DOMAIN=preview.example.com`.

Für bessere Isolation (siehe [security.md](security.md)) eine **eigene Domain** für Previews verwenden,
nicht eine Subdomain der Agentforge-Domain.

## Weiter

- [backup.md](backup.md) – Backup & Wiederherstellung
- [security.md](security.md) – Sicherheitsmodell
- [troubleshooting.md](troubleshooting.md) – Fehlersuche
