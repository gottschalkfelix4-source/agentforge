# Backup & Wiederherstellung

## Was liegt wo?

Alles liegt im Datenverzeichnis (`/data` im Container, auf Unraid `/mnt/user/appdata/agentforge`):

| Pfad | Inhalt | im Export? |
|---|---|---|
| `db/vibe.sqlite` (+ `-wal`, `-shm`) | Datenbank: Admin, Projekte, Workspaces, Chat-Sitzungen, Aufgaben/Notizen, Provider, Agent-Profile, **verschlüsselte** Secrets, Einstellungen | ja (Snapshot) |
| `secret.key` | Nur vorhanden, wenn `AGENTFORGE_SECRET_KEY` **nicht** gesetzt ist | ja, wenn vorhanden |
| `projects/<id>/` | Projektdateien (Git-Repos) | optional (`?projects=1`) |
| `agent-home/` | Abo-Logins der Agent-CLIs (Claude, Codex, …), deren Einstellungen und Verläufe | nein |
| `tools/` | In Workspaces nachinstallierte globale Tools | nein |
| `cache/` | npm/pnpm/pip-Caches | nein (reproduzierbar) |
| `generated/` | Workspace-Tokens | nein (wird neu erzeugt) |

`AGENTFORGE_SECRET_KEY` selbst ist nie im Backup – ohne denselben Wert lassen sich gespeicherte API-Keys und
Tokens nach einer Wiederherstellung nicht entschlüsseln. Den Wert separat (Passwort-Manager) sichern.

## Export aus der UI

*Einstellungen → System → Backup herunterladen* (optional *inkl. Projektdateien*). Ergebnis:
`agentforge-backup-<zeit>[-full].tar.gz` mit

```
manifest.json      Version, Zeitpunkt, Inhalt, Warnungen
vibe.sqlite        konsistenter Snapshot (SQLite VACUUM INTO, im laufenden Betrieb)
secret.key         nur bei dateibasiertem Schlüssel – Backup dann wie ein Passwort behandeln!
projects/…         nur mit ?projects=1; ohne node_modules, .pnpm-store, .venv, __pycache__, .next, .turbo, .cache
```

Symlinks bleiben erhalten; Dateien, die während des Exports gelöscht werden, werden übersprungen.

### Per Skript / cron

```bash
BASE=https://vibe.example.com
curl -fsS -c /tmp/vibe.jar -H 'X-Vibe: 1' -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"…"}' "$BASE/api/auth/login" >/dev/null
curl -fsS -b /tmp/vibe.jar -o "agentforge-$(date +%F).tar.gz" "$BASE/api/system/backup?projects=1"
```

## Komplettes Backup (kalt)

Für ein Backup inklusive Agent-Logins den Container stoppen und das ganze Datenverzeichnis sichern:

```bash
docker stop agentforge
tar -czf agentforge-full-$(date +%F).tar.gz -C /mnt/user/appdata agentforge
docker start agentforge
```

Auf Unraid erledigt das auch das Plugin *Appdata Backup* (stoppt Container automatisch). Workspace-Container
selbst müssen nicht gesichert werden – sie werden aus dem Image neu erzeugt.

## Wiederherstellung (manuell)

Es gibt bewusst keinen Restore-Endpunkt; so geht es von Hand:

1. **Agentforge stoppen** (`docker stop agentforge`). Laufende Workspaces optional ebenfalls stoppen
   (`docker ps --filter label=vibe.managed=true`).
2. **Altes Datenverzeichnis beiseitelegen** (nicht löschen, bis alles läuft):
   ```bash
   mv /mnt/user/appdata/agentforge /mnt/user/appdata/agentforge.old
   mkdir -p /mnt/user/appdata/agentforge/db
   ```
3. **Backup entpacken und Dateien an ihren Platz legen:**
   ```bash
   mkdir /tmp/restore && tar -xzf agentforge-backup-….tar.gz -C /tmp/restore
   cat /tmp/restore/manifest.json
   cp /tmp/restore/vibe.sqlite /mnt/user/appdata/agentforge/db/vibe.sqlite
   # nur falls enthalten (dateibasierter Schlüssel):
   cp /tmp/restore/secret.key /mnt/user/appdata/agentforge/secret.key && chmod 600 /mnt/user/appdata/agentforge/secret.key
   # nur beim Voll-Export:
   cp -a /tmp/restore/projects /mnt/user/appdata/agentforge/
   ```
   Wichtig: **keine** alten `vibe.sqlite-wal`/`-shm`-Dateien neben den Snapshot legen.
4. Optional **Agent-Logins und Tools** aus dem alten Verzeichnis übernehmen:
   `cp -a /mnt/user/appdata/agentforge.old/agent-home /mnt/user/appdata/agentforge.old/tools /mnt/user/appdata/agentforge/`
   (sonst im Projekt neu anmelden).
5. **Gleichen `AGENTFORGE_SECRET_KEY`** wie beim Backup setzen (bzw. `secret.key` aus Schritt 3) und Agentforge starten.
6. Beim Start gleicht der Server die Workspaces ab: Container, die auf dem (neuen) Host nicht existieren, werden als
   „nicht erstellt“ markiert und beim nächsten Öffnen des Projekts neu angelegt. Ohne Projektdateien im Backup
   starten Projekte mit Git-URL mit einem frischen Clone; andere sind leer.
7. Läuft alles, `agentforge.old` löschen.

**Umzug auf einen neuen Host:** wie oben; zusätzlich `HOST_DATA_PATH` an den neuen Pfad anpassen. Alte
Workspace-Container auf dem alten Host kann man mit
`docker rm -f $(docker ps -aq --filter label=vibe.managed=true)` entfernen.

**Versionen:** Ein Backup lässt sich in derselben oder einer neueren Agentforge-Version einspielen – Datenbank-Migrationen
laufen beim Start automatisch. Ein Downgrade auf eine ältere Version wird nicht unterstützt.
