// AGENTS.md / CLAUDE.md templates for projects in Agentforge.
// The Agentforge part lives between markers so it can be inserted into or refreshed in existing files
// without touching the project-specific content around it.

export const AGENTFORGE_SECTION_START = '<!-- agentforge:start -->';
export const AGENTFORGE_SECTION_END = '<!-- agentforge:end -->';

/** Everything an agent should know about working inside Agentforge. */
export function agentforgeSection(): string {
  return `${AGENTFORGE_SECTION_START}
## Arbeitsumgebung: Agentforge

Du arbeitest in **Agentforge**, einer selbst gehosteten Plattform für Coding-Agents. Der Nutzer sieht deine Arbeit in
einer Web-Oberfläche mit Chat, Code-Editor, Terminal, Live-Vorschau, Git-Panel, Aufgaben-Board, Roadmap und Notizen.
Antworte in der Sprache des Nutzers (meist Deutsch).

### Workspace
- Jedes Projekt läuft in einem eigenen Linux-Container (Debian) als Benutzer \`coder\` – **ohne root/sudo und ohne Docker**.
- Das Projekt liegt in \`/workspace\` (das ist dein Arbeitsverzeichnis, außer bei Aufgaben im eigenen Worktree, siehe unten).
- Vorhanden: Node 22 mit npm, pnpm und bun, Python 3.11 mit pip und uv, git, git-lfs, GitHub CLI \`gh\`, ripgrep (\`rg\`),
  fd (\`fdfind\`), jq, build-essential, curl/wget sowie Chromium für Playwright.
- **Dauerhaft gespeichert** werden nur: \`/workspace\`, global installierte Tools (\`npm i -g\`, \`pnpm add -g\`, \`bun add -g\`,
  \`uv tool install\` landen in \`/opt/vibe-tools\`), Paket-Caches und die Konfiguration der Agents. Alles andere im Container
  (z. B. Dateien in \`/tmp\` oder anderswo im Home-Verzeichnis) geht verloren, wenn der Workspace neu erstellt wird.
- Systempakete (\`apt\`) lassen sich nicht installieren – nutze stattdessen npm/pip/uv oder projektlokale Abhängigkeiten.
- CPU und Arbeitsspeicher sind begrenzt (Standard 4 Kerne / 8 GB). Starte keine unnötig schweren Prozesse parallel.
- Internetzugang ist vorhanden. Dienste auf dem Host (z. B. Ollama) erreichst du über \`host.docker.internal\`.
- Inaktive Workspaces können automatisch gestoppt werden – verlasse dich nicht auf dauerhaft laufende Hintergrundprozesse.

### Dev-Server & Live-Vorschau
- Agentforge erkennt Dev-Server automatisch anhand ihres Ports und zeigt sie im Vorschau-Panel (eingebauter Browser).
- Die Umgebungsvariable \`HOST=0.0.0.0\` ist gesetzt; Server dürfen auf \`0.0.0.0\` oder \`localhost\` lauschen.
- Starte Dev-Server so, dass sie weiterlaufen (z. B. \`npm run dev\` im Hintergrund oder in einem eigenen Prozess), und nenne
  dem Nutzer danach den Port, z. B. „läuft auf http://localhost:5173“ – solche Links öffnen im Chat direkt die Vorschau.
- Konsolenausgaben und Fehler der Seite im Vorschau-Panel sieht der Nutzer; bitte ihn bei Bedarf, sie dir mitzuteilen.

### Browser (Playwright-MCP)
- Über den MCP-Server \`playwright\` steuerst du einen Headless-Chromium: Seiten öffnen, klicken, Formulare ausfüllen,
  Screenshots machen und die Konsole lesen.
- Prüfe damit deine UI-Änderungen selbst, z. B. \`http://localhost:<port>\` nach dem Start des Dev-Servers.

### Projekt-Board (MCP-Server \`agentforge\`)
Über die Agentforge-Tools arbeitest du mit dem Board, das der Nutzer in den Reitern **Aufgaben**, **Roadmap** und
**Notizen** sieht. Änderungen erscheinen dort sofort.

| Tool | Zweck |
|---|---|
| \`project_overview\` | Überblick: Aufgaben je Status, offene Meilensteine, laufende Aufgaben, angeheftete Notizen |
| \`current_task\` | Die Board-Aufgabe dieser Sitzung (falls sie vom Board gestartet wurde) |
| \`tasks_list\`, \`task_get\` | Aufgaben suchen und lesen (Filter: Status, Meilenstein, Suchtext) |
| \`task_create\`, \`task_update\` | Aufgaben anlegen und bearbeiten (Titel, Beschreibung, Status, Meilenstein, Labels) |
| \`task_set_status\` | Status ändern: \`backlog\`, \`todo\`, \`in_progress\`, \`review\`, \`done\` |
| \`milestones_list\`, \`milestone_create\`, \`milestone_update\` | Roadmap-Meilensteine (Fälligkeit \`YYYY-MM-DD\`, offen/geschlossen) |
| \`notes_list\`, \`note_get\`, \`note_create\`, \`note_update\` | Projektnotizen lesen und schreiben (\`append\` hängt Text an) |

**Regeln für das Board**
- Schau zu Beginn größerer Arbeiten mit \`project_overview\` nach, was geplant ist und was schon läuft.
- Setze Aufgaben, an denen du arbeitest, auf \`in_progress\`; wenn du fertig bist und der Nutzer prüfen soll, auf \`review\`.
  Auf \`done\` erst, wenn der Nutzer das Ergebnis bestätigt hat oder ausdrücklich darum bittet.
- Lege für erkannte Folgearbeiten, Bugs oder offene Punkte eigene Aufgaben an statt sie nur im Chat zu erwähnen.
- Ordne Aufgaben passenden Meilensteinen zu, wenn es welche gibt; neue Meilensteine nur nach Absprache.
- Halte Architektur- und Design-Entscheidungen, wichtige Befehle und Erkenntnisse in Notizen fest.
- Löschen ist über die Tools nicht möglich – bitte den Nutzer darum, falls etwas entfernt werden soll.
- Aufgaben mit GitHub-Issue (\`githubIssue\`) werden mit GitHub synchronisiert; Titel und Status erscheinen dort ebenfalls.

### Aufgaben vom Board (eigener Worktree)
- Übergibt der Nutzer eine Aufgabe vom Board an dich, arbeitest du in einem eigenen Git-Worktree
  \`/workspace/.worktrees/task-…\` auf einem Branch \`vibe/task-…\`. Das ist dann dein Arbeitsverzeichnis.
- Arbeite nur dort, wechsle nicht den Branch und fasse andere Worktrees nicht an.
- Committe deine Änderungen am Ende; Pushen, Pull Request und den Status „Review“ übernimmt Agentforge.

### Git & GitHub
- Das Repository liegt in \`/workspace\`. Der Nutzer sieht Änderungen, Diffs, Branches und Pull Requests im Git-Panel.
- Ist ein GitHub-Konto verbunden, funktionieren \`git push\`/\`pull\` zu github.com ohne weitere Anmeldung, und \`gh\` ist
  angemeldet (z. B. \`gh pr create\`, \`gh issue list\`). Commit-Name und -E-Mail stammen vom GitHub-Konto.
- Committe in kleinen, nachvollziehbaren Schritten mit aussagekräftigen Nachrichten. Pushe oder erstelle Pull Requests nur,
  wenn der Nutzer es möchte oder die Aufgabe es verlangt; niemals \`--force\` auf gemeinsam genutzte Branches.
- \`.worktrees/\` ist lokal von Git ausgeschlossen und gehört nicht ins Repository.

### Rückfragen & Freigaben
- Sind Anforderungen unklar oder gibt es mehrere sinnvolle Wege, frag nach, statt zu raten. Wenn dein Agent ein Werkzeug
  für strukturierte Rückfragen hat (z. B. \`AskUserQuestion\` in Claude Code), nutze es – der Nutzer beantwortet die Frage
  direkt im Chat mit Auswahlmöglichkeiten.
- Je nach Modus muss der Nutzer Befehle oder Dateiänderungen freigeben. Erkläre kurz, warum ein Befehl nötig ist.

### Sicherheit
- API-Schlüssel und Tokens stehen nur in der Prozessumgebung zur Verfügung. Schreibe sie niemals in Dateien, Logs,
  Commits, Notizen oder Aufgaben.
- Keine destruktiven Aktionen (Dateien massenhaft löschen, History umschreiben, Datenbanken leeren) ohne Rückfrage.
${AGENTFORGE_SECTION_END}`;
}

/** Full AGENTS.md for a new project: project skeleton + Agentforge section. */
export function agentsMdTemplate(projectName: string): string {
  return `# ${projectName}

Anweisungen für Coding-Agents (Claude Code, Codex, OpenCode, Cline, Kilo, Gemini, Qwen, Copilot, Goose, Aider …),
die in diesem Repository arbeiten.

## Projektüberblick
- Was macht das Projekt? Für wen?
- Wichtige Verzeichnisse: \`src/\` …

## Setup & Befehle
- Abhängigkeiten installieren: \`npm install\`
- Entwicklungsserver: \`npm run dev\`
- Tests: \`npm test\`
- Lint/Format: \`npm run lint\`

## Code-Stil & Konventionen
- Sprache/Framework, Formatierung, Benennung
- Bevorzugte Bibliotheken und Muster

## Arbeitsweise
- Kleine, fokussierte Änderungen; Tests ergänzen, wenn sinnvoll
- Vor dem Abschluss: Tests, Linter und Build ausführen
- Keine Secrets committen

## Hinweise
- Bekannte Stolperfallen, externe Dienste, Umgebungsvariablen

${agentforgeSection()}
`;
}

/** CLAUDE.md that imports AGENTS.md, so both stay in sync. */
export function claudeMdTemplate(projectName: string): string {
  return `# ${projectName}

@AGENTS.md

Die Projektanweisungen stehen in \`AGENTS.md\` (wird oben eingebunden) – bitte dort pflegen, damit alle Agents
dieselben Regeln haben. Hier nur Claude-spezifische Ergänzungen:

- Nutze \`AskUserQuestion\` für Rückfragen mit Auswahlmöglichkeiten; der Nutzer beantwortet sie direkt im Agentforge-Chat.
- Nutze die Agentforge-Tools (\`mcp__agentforge__*\`) für Aufgaben, Status, Roadmap und Notizen.
`;
}

/** Inserts the Agentforge section, or replaces an existing one between the markers. */
export function upsertAgentforgeSection(content: string): string {
  const section = agentforgeSection();
  const start = content.indexOf(AGENTFORGE_SECTION_START);
  const end = content.indexOf(AGENTFORGE_SECTION_END);
  if (start !== -1 && end > start) {
    return content.slice(0, start) + section + content.slice(end + AGENTFORGE_SECTION_END.length);
  }
  return `${content.trimEnd()}\n\n${section}\n`;
}
