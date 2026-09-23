# Fehlersuche

Erste Anlaufstellen: Server-Log (`docker logs agentforge`, Unraid: *Logs*), *Einstellungen → System*
und das Log eines Workspaces (`docker logs agentforge-ws-<projekt-id>`).

## Setup & Anmeldung

**Setup-Token nicht gefunden** – steht im Log (`Agentforge Setup-Token: …`) und in `<data>/setup-token.txt`. Nach
einem Neustart ohne Admin wird ein neuer erzeugt.

**Passwort vergessen** – Admin löschen, neu starten, mit neuem Setup-Token neu anlegen (Projekte bleiben erhalten):

```bash
docker exec agentforge node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/db/vibe.sqlite');d.exec('DELETE FROM auth_sessions; DELETE FROM admin')"
docker restart agentforge && docker logs agentforge 2>&1 | grep Setup-Token
```

**Login klappt, danach sofort wieder abgemeldet** – `AGENTFORGE_SECURE_COOKIES=1` ist gesetzt, aber der Zugriff erfolgt
per `http://`. Entweder HTTPS nutzen oder die Variable entfernen.

**„Fehlender X-Vibe-Header“ (403)** – ein Proxy/WAF entfernt eigene Header. Header `X-Vibe` durchlassen.

## Workspaces

**„bind source path does not exist“ / Workspace hat leeres `/workspace` / Dateien fehlen** – `HOST_DATA_PATH` stimmt
nicht mit dem Host-Pfad des `/data`-Volumes überein (siehe [installation.md](installation.md#der-host_data_path-stolperstein)).
Nach der Korrektur im Projekt *Neu erstellen*.

**„Workspace-Image … fehlt und konnte nicht geladen werden“** – `WORKSPACE_IMAGE` zeigt auf ein lokales Tag
(`agentforge-workspace:dev`), das nicht gebaut wurde, oder auf ein privates GHCR-Paket. Paket öffentlich machen oder
`docker login ghcr.io` auf dem Host; lokal bauen mit `docker build -f docker/workspace/Dockerfile -t <tag> .`.

**Workspace bleibt bei „Container startet …“** – `docker logs agentforge-ws-<id>`. Häufig: zu wenig RAM für das Limit,
Rechteprobleme bei `PUID`/`PGID` (Unraid: 99/100), oder die App erreicht das Netz `agentforge-net` nicht (App-Container
neu starten, dann tritt er dem Netz wieder bei).

**Nach Image-Update laufen alte Tools** – Workspaces nutzen das neue Image erst nach *Neu erstellen*. Selbst mit
`npm i -g` installierte Tools in `<data>/tools` haben Vorrang vor den Image-Versionen.

**Workspace stoppt von selbst** – Auto-Stopp (*Einstellungen → System → Automatisch stoppen* bzw.
`WORKSPACE_IDLE_MINUTES`). Er greift nur, wenn weder eine Agent-Sitzung läuft noch ein Terminal-Prozess aktiv ist;
das Log nennt den Grund („… ist seit N min inaktiv“).

**Speicher läuft voll** – *Einstellungen → System → Speicherbelegung*. Große Posten: `cache/` (kann gelöscht werden,
wenn keine Workspaces laufen), `projects/*/node_modules`, alte Images: `docker image prune`.

## Verbindung / Reverse Proxy

**Terminal/Chat verbindet nicht, UI lädt aber** – WebSockets werden vom Proxy nicht durchgereicht (NPM:
*Websockets Support*; nginx: `Upgrade`/`Connection`-Header). Der Proxy muss außerdem den `Host`-Header
unverändert lassen – WebSockets werden nur von der eigenen Origin akzeptiert. Andere Origins (z. B. ein
Dev-Server) über `AGENTFORGE_ALLOWED_ORIGINS` freigeben.

**Verbindung bricht nach 60 s ab** – Proxy-Timeout erhöhen (`proxy_read_timeout 1d`).

**Preview zeigt „auth required“ / 401** – Preview-Link über die UI neu öffnen (Token ist einmalig). Im Port-Modus
müssen die Ports 7100–7119 (bzw. `PREVIEW_PORT_START`/`COUNT`) auf Host **und** Container identisch veröffentlicht
sein. Im Subdomain-Modus: Wildcard-DNS, Wildcard-Zertifikat und `PREVIEW_DOMAIN` prüfen.

## Agents

**Abo-Login schlägt fehl / Browser-Callback auf localhost** – manche CLIs erwarten einen Callback auf `localhost`.
Den im Terminal angezeigten Code-/Device-Flow verwenden; Logins liegen in `<data>/agent-home/` und gelten für alle
Workspaces.

**API-Key wird nicht mehr akzeptiert nach Umzug** – `AGENTFORGE_SECRET_KEY` (bzw. `secret.key`) weicht vom alten Wert
ab; gespeicherte Secrets lassen sich nicht entschlüsseln. Alten Wert setzen oder Provider neu anlegen.

## Backup

**Backup-Download bricht ab** – Proxy-Timeouts/Puffer: große Voll-Exporte (`inkl. Projektdateien`) werden gestreamt;
`proxy_buffering off;` bzw. höheres `proxy_read_timeout` setzen oder direkt über `http://<host>:8080` laden.
