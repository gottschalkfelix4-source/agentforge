# Sicherheitsmodell

Agentforge ist für **eine Person auf dem eigenen Server** gedacht. Es führt beliebigen Code aus (das ist der Zweck
von Coding-Agents) – die Maßnahmen unten begrenzen den Schaden, ersetzen aber keine Netzwerk-Absicherung.

**Empfehlung:** nicht direkt ins Internet stellen. Zugriff über VPN (WireGuard/Tailscale) oder einen Reverse
Proxy mit HTTPS und ggf. zusätzlicher Authentifizierung (Authelia, Authentik, Cloudflare Access).

## Docker-Socket

Der App-Container braucht `/var/run/docker.sock`, um Workspace-Container anzulegen. **Zugriff auf den Socket
entspricht Root-Rechten auf dem Host.** Wer die Agentforge-Oberfläche übernimmt, kann über die Server-Logik zwar nur
Workspaces aus der festen Vorlage erzeugen – eine Sicherheitslücke im Server aber hätte Host-Root-Zugriff.

Begrenzungen im Code:
- Der Server erzeugt Container ausschließlich aus einer festen, gehärteten Vorlage (`docker/orchestrator.ts`),
  nie aus Benutzereingaben (keine frei wählbaren Mounts, Images, Privilegien).
- Er fasst nur Container mit dem Label `vibe.managed=true` an; alle anderen werden bei Stop/Remove abgewiesen.
- Ein Socket-Proxy (z. B. `tecnativa/docker-socket-proxy`) bringt wenig: Agentforge braucht Container-Create
  mit Bind-Mounts, was praktisch wieder Root-Zugriff ist.

## Workspace-Härtung

Jeder Workspace-Container läuft mit:
- `Privileged: false`, `CapDrop: ALL` + nur `CHOWN, SETUID, SETGID, DAC_OVERRIDE, Fgottschalkfelix4-source, KILL, NET_BIND_SERVICE`
- `no-new-privileges`, `PidsLimit 4096`, CPU- und RAM-Limit (`WORKSPACE_CPUS`, `WORKSPACE_MEMORY_MB`)
- Prozesse als unprivilegierter Benutzer `coder` (UID/GID per `PUID`/`PGID`)
- Mounts: nur das eigene Projekt (`/workspace`), gemeinsame Agent-Logins, Tool-Verzeichnis und Caches,
  Workspace-Token read-only. **Kein** Docker-Socket, kein Zugriff auf andere Projekte oder die Datenbank.
- Eigenes Bridge-Netz `agentforge-net`; der Workspace-Daemon ist nur mit einem zufälligen Token pro Workspace
  erreichbar. Workspaces haben normalen Internetzugang (für npm, git, APIs) und erreichen den Host über
  `host.docker.internal`.

Gemeinsam genutzt werden `agent-home/` (Logins) und `tools/`: ein bösartiges Projekt könnte dort Tokens lesen
oder Tools manipulieren, die andere Projekte verwenden. Keine fremden, nicht vertrauenswürdigen Repositories mit
Agents in „Auto-Approve“-Modi laufen lassen.

## Anmeldung & Web-Sicherheit

- Ein Admin-Account; Passwort mit Argon2id gehasht. Erst-Einrichtung nur mit einmaligem Setup-Token aus
  Log/Datenverzeichnis.
- Session-Cookie `vibe_session`: zufälliges Token (nur als SHA-256 gespeichert), `HttpOnly`,
  `SameSite=Strict`, 30 Tage; `Secure` mit `AGENTFORGE_SECURE_COOKIES=1`.
- Alle verändernden Requests brauchen den Header `X-Vibe: 1` (CSRF-Schutz; fremde Seiten können ihn ohne
  CORS-Freigabe nicht setzen). WebSockets prüfen Session **und** Origin.
- Login ist auf 10 Versuche/Minute begrenzt.

## Secrets

- API-Keys, Provider-Tokens und der GitHub-Token werden mit AES-256-GCM verschlüsselt in der Datenbank gespeichert.
  Der Schlüssel ist SHA-256(`AGENTFORGE_SECRET_KEY`); ohne Variable eine Zufallsdatei `/data/secret.key`
  (dann liegen Schlüssel und Daten zusammen – schwächer, und Backups enthalten den Schlüssel).
- Secrets werden nur dem jeweiligen Agent-Prozess als Umgebungsvariablen übergeben, nie als
  Container-Umgebung und nie an den Browser zurückgegeben.
- Abo-Logins der Agent-CLIs (OAuth-Tokens) liegen – wie bei lokaler Nutzung – im Klartext in `agent-home/`.
  Das Datenverzeichnis entsprechend schützen (Berechtigungen, verschlüsselte Backups).

## Preview-Isolation

Previews zeigen Code, den Agents geschrieben haben, im eigenen Browser an.
- Zugriff nur über ein einmaliges Token (`?__vibe_pv=…`) → danach Slot-Cookie; ohne gültiges Token keine Antwort.
- **Port-Modus:** Preview und App haben denselben Hostnamen, aber unterschiedliche Ports – also verschiedene
  Origins (kein Zugriff auf App-DOM/LocalStorage), aber **dieselbe Site**: Cookies unterscheiden nicht nach Port.
  Das Session-Cookie ist `HttpOnly` (nicht lesbar) und API-Schreibzugriffe brauchen den `X-Vibe`-Header, den eine
  fremde Origin ohne CORS nicht senden darf.
- **Subdomain-Modus mit eigener Domain** (z. B. App auf `vibe.example.com`, Previews auf `*.example-preview.net`)
  ist die stärkste Isolation: andere Site, keine gemeinsamen Cookies.

## Claude-Abo & andere Abo-Logins

Mit „Anmelden (Abo-Login)“ nutzt ein Agent-CLI dein persönliches Abo (z. B. Claude Pro/Max, ChatGPT Plus) so, als
würdest du das CLI lokal verwenden. Abo-Zugänge sind **persönlich**: Agentforge nicht für andere Personen freigeben
oder als Dienst anbieten, und die aktuellen Nutzungsbedingungen des jeweiligen Anbieters beachten. Für geteilte,
automatisierte oder produktive Nutzung API-Keys (Einstellungen → Provider) verwenden.

## Sicherheitslücken melden

Bitte nicht öffentlich als Issue, sondern über *Security → Report a vulnerability* im GitHub-Repository.
