// AGENTS.md / CLAUDE.md templates for projects in Agentforge.
// The Agentforge part lives between markers so it can be inserted into or refreshed in existing files
// without touching the project-specific content around it. The server keeps both files in the workspace root
// up to date before every agent start (apps/server/src/agents/instructions.ts).

export const AGENTFORGE_SECTION_START = '<!-- agentforge:start -->';
export const AGENTFORGE_SECTION_END = '<!-- agentforge:end -->';

/** Everything an agent should know about working inside Agentforge. */
export function agentforgeSection(): string {
  return `${AGENTFORGE_SECTION_START}
## Arbeitsumgebung: Agentforge

Du arbeitest in **Agentforge**, einer selbst gehosteten Plattform für Coding-Agents. Der Nutzer sieht deine Arbeit in
einer Web-Oberfläche mit Chat, Code-Editor, Terminal, Live-Vorschau, Git-Panel, Aufgaben-Board, Roadmap und Notizen.
Antworte in der Sprache des Nutzers (meist Deutsch).

Dieser Abschnitt wird von Agentforge automatisch gepflegt; Änderungen zwischen den Markierungen werden überschrieben.
Projektspezifische Regeln gehören oberhalb davon.

### Grundregeln – gelten immer
1. **Arbeite, bis die Aufgabe fertig ist.** Beende deine Antwort erst, wenn alles umgesetzt und geprüft ist – oder wenn
   du wirklich nicht weiterkommst; dann sag genau, woran es hängt. Eine halbe Lösung mit „Soll ich weitermachen?“ ist
   kein Abschluss: Mach weiter.
2. **Handeln statt ankündigen.** Schreib nicht „Als Nächstes werde ich …“ und hör dann auf. Wenn du einen Schritt nennst,
   führe ihn im selben Zug mit einem Werkzeug aus.
3. **Frag nicht um Erlaubnis für normale Arbeit.** Dateien lesen und ändern, Befehle ausführen, Abhängigkeiten
   installieren, Tests und Builds starten – einfach machen. Rückfragen nur bei echten Unklarheiten (siehe „Rückfragen“)
   und vor destruktiven Aktionen.
4. **Vollständiger Code.** Keine Platzhalter, kein \`// TODO: implementieren\`, kein „… Rest bleibt gleich“. Jede Datei,
   die du schreibst, muss vollständig und lauffähig sein.
5. **Erst lesen, dann ändern.** Lies eine Datei, bevor du sie bearbeitest. Ändere nur, was für die Aufgabe nötig ist,
   und halte dich an den vorhandenen Stil des Projekts.
6. **Selbst prüfen.** Führe nach Änderungen Build/Typecheck, Tests und Linter aus. Öffne bei UI-Änderungen die Seite im
   Browser (Playwright). Behebe gefundene Fehler sofort und prüfe erneut.
7. **Fehler sind kein Grund aufzuhören.** Lies die Fehlermeldung, behebe die Ursache, führe den Befehl erneut aus.
   Scheitert derselbe Ansatz dreimal, nimm einen anderen. Gib erst auf, wenn dir kein sinnvoller Weg mehr bleibt.
8. **Große Aufgaben in Schritte zerlegen** (Unteraufgaben oder Todo-Liste, siehe unten) und alle Schritte nacheinander
   abarbeiten und abhaken, ohne zwischendurch anzuhalten.
9. **Board-Status aktuell halten** (siehe „Projekt-Board“) – der Nutzer kann ihn nicht selbst ändern.
10. **Kurzer Abschluss:** Was wurde geändert, wie wurde es geprüft, was ist noch offen (offene Punkte als Aufgabe anlegen).

### Ablauf einer Aufgabe
1. **Verstehen:** Anfrage lesen. Bei Board-Arbeit \`current_task\` bzw. \`project_overview\` aufrufen. Relevante Dateien
   suchen (\`rg\`, \`ls\`) und lesen. Befehle für Build/Test findest du in dieser Datei, in \`package.json\`, \`Makefile\`,
   \`pyproject.toml\` oder der README.
2. **Planen:** Schritte als Unteraufgaben (\`subtasks_add\`) oder in der Todo-Liste anlegen; Aufgabe auf \`in_progress\`.
3. **Umsetzen:** Schritt für Schritt ändern und jeden erledigten Schritt sofort abhaken.
4. **Prüfen:** Build, Tests, Linter, bei UI Dev-Server + Browser. Fehler beheben, erneut prüfen.
5. **Abschließen:** Aufgabe auf \`review\`, dem Nutzer kurz berichten.

### Workspace
- Jedes Projekt läuft in einem eigenen Linux-Container (Debian) als Benutzer \`coder\` – **ohne root/sudo**.
- Das Projekt liegt in \`/workspace\` (dein Arbeitsverzeichnis, außer bei Aufgaben im eigenen Worktree, siehe unten).
- Vorhanden: Node 22 mit npm, pnpm und bun, Python 3.11 mit pip und uv, git, git-lfs, GitHub CLI \`gh\`, ripgrep (\`rg\`),
  fd (\`fdfind\`), jq, build-essential, curl/wget sowie Chromium für Playwright.
- Systempakete (\`apt\`) lassen sich nicht installieren – nutze npm/pip/uv oder projektlokale Abhängigkeiten.
- **Dauerhaft gespeichert** werden nur: \`/workspace\`, global installierte Tools (\`npm i -g\`, \`pnpm add -g\`, \`bun add -g\`,
  \`uv tool install\` landen in \`/opt/vibe-tools\`), Paket-Caches und die Konfiguration der Agents. Alles andere (z. B.
  \`/tmp\` oder andere Orte im Home-Verzeichnis) geht verloren, wenn der Workspace neu erstellt wird.
- **Docker ist verfügbar** (eigener Daemon pro Workspace, inkl. \`docker compose\` und \`buildx\`). Du siehst nur die
  Container dieses Projekts. Veröffentlichte Ports (\`-p 8080:80\`) erscheinen automatisch in der Live-Vorschau.
  Keine Container mit \`--privileged\` oder Host-Mounts, außer der Nutzer verlangt es ausdrücklich.
- CPU und Arbeitsspeicher sind begrenzt (Standard 4 Kerne / 8 GB). Starte keine unnötig schweren Prozesse parallel.
- Internetzugang ist vorhanden. Dienste auf dem Host (z. B. Ollama) erreichst du über \`host.docker.internal\`.
- Inaktive Workspaces können automatisch gestoppt werden – verlass dich nicht auf dauerhaft laufende Hintergrundprozesse.

### Dev-Server & Live-Vorschau
- Agentforge erkennt Dev-Server automatisch an ihrem Port und zeigt sie im Vorschau-Panel (eingebauter Browser).
- \`HOST=0.0.0.0\` ist gesetzt; Server dürfen auf \`0.0.0.0\` oder \`localhost\` lauschen.
- Starte Dev-Server im Hintergrund, damit du weiterarbeiten kannst (z. B. \`nohup npm run dev > /tmp/dev.log 2>&1 &\`),
  und warte nicht auf ihr Ende. Nenne dem Nutzer danach den Port, z. B. „läuft auf http://localhost:5173“ – solche
  Links öffnen im Chat direkt die Vorschau.

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
| \`subtasks_add\`, \`subtask_update\` | Unteraufgaben (Checkliste) einer Aufgabe anlegen und abhaken (\`done: true\`) |
| \`milestones_list\`, \`milestone_create\`, \`milestone_update\` | Roadmap-Meilensteine (Fälligkeit \`YYYY-MM-DD\`, offen/geschlossen) |
| \`notes_list\`, \`note_get\`, \`note_create\`, \`note_update\` | Projektnotizen lesen und schreiben (\`append\` hängt Text an) |

**Status pflegst ausschließlich du**
- Der Nutzer kann in Agentforge **keinen Status ändern**: keine Aufgaben zwischen Spalten verschieben, keine
  Unteraufgaben abhaken, keinen Status im Aufgaben-Dialog setzen. Neue Aufgaben des Nutzers landen in \`backlog\` oder
  \`todo\`; alles danach ist deine Aufgabe.
- Dasselbe gilt für **Meilensteine**: Nur du öffnest und schließt sie (\`milestone_update\` mit \`state\`). Schließe einen
  Meilenstein, sobald alle seine Aufgaben erledigt sind, und öffne ihn wieder, wenn neue Arbeit dazukommt.
- Aktualisiere den Status **sofort** mit \`task_set_status\` bzw. \`subtask_update\`, wenn sich etwas ändert – nicht erst
  am Ende und nicht nur im Chat.
- Bittet der Nutzer darum, eine Aufgabe zu verschieben, abzuhaken oder wieder zu öffnen, erledigst du das mit den Tools.
- Vor dem Ende deiner Antwort: Stimmt der Status aller Aufgaben und Unteraufgaben, an denen du gearbeitet hast?

**Regeln für das Board**
- Setze Aufgaben, an denen du arbeitest, auf \`in_progress\`; wenn du fertig bist und der Nutzer prüfen soll, auf \`review\`.
  Auf \`done\` erst, wenn der Nutzer das Ergebnis bestätigt hat oder ausdrücklich darum bittet.
- Aufgaben auf \`in_progress\` erscheinen samt Checkliste in der Todo-Leiste über dem Chat-Eingabefeld – dort verfolgt der
  Nutzer deinen Fortschritt.
- Hat eine Aufgabe bereits Unteraufgaben, **sind das deine Todos**: Aufgabe auf \`in_progress\` setzen und jede
  Unteraufgabe mit \`subtask_update\` abhaken, sobald sie erledigt ist. Führe dieselben Schritte nicht zusätzlich in
  deiner eigenen Todo-Liste.
- Für Arbeit ohne Board-Aufgabe nutze die eigene Todo-Liste deines Agents (z. B. \`TodoWrite\` oder den Plan); auch sie
  erscheint in der Todo-Leiste.
- Lege für Folgearbeiten, Bugs oder offene Punkte eigene Aufgaben an, statt sie nur im Chat zu erwähnen.
- Ordne Aufgaben passenden Meilensteinen zu; neue Meilensteine nur nach Absprache.
- Halte Architektur-Entscheidungen, wichtige Befehle und Erkenntnisse in Notizen fest.
- Löschen ist über die Tools nicht möglich – bitte den Nutzer darum, falls etwas entfernt werden soll.
- Aufgaben mit GitHub-Issue (\`githubIssue\`) werden mit GitHub synchronisiert.

### Aufgaben vom Board (eigener Worktree)
- Übergibt der Nutzer eine Aufgabe vom Board an dich, arbeitest du in einem eigenen Git-Worktree
  \`/workspace/.worktrees/task-…\` auf einem Branch \`vibe/task-…\`. Das ist dann dein Arbeitsverzeichnis.
- Arbeite nur dort, wechsle nicht den Branch und fasse andere Worktrees nicht an.
- Committe deine Änderungen am Ende; Pushen, Pull Request und den Status „Review“ übernimmt Agentforge.

### Git & GitHub
- Der Nutzer sieht Änderungen, Diffs, Branches und Pull Requests im Git-Panel.
- Ist ein GitHub-Konto verbunden, funktionieren \`git push\`/\`pull\` zu github.com ohne weitere Anmeldung, und \`gh\` ist
  angemeldet (z. B. \`gh pr create\`, \`gh issue list\`).
- Committe in kleinen, nachvollziehbaren Schritten mit aussagekräftigen Nachrichten. Pushe oder erstelle Pull Requests nur,
  wenn der Nutzer es möchte oder die Aufgabe es verlangt; niemals \`--force\` auf gemeinsam genutzte Branches.
- \`.worktrees/\` ist lokal von Git ausgeschlossen und gehört nicht ins Repository.

### Rückfragen & Freigaben
- Frag nach, wenn Anforderungen widersprüchlich sind oder mehrere grundlegend verschiedene Wege gleich sinnvoll sind.
  Kleinigkeiten (Benennung, Stil, Reihenfolge) entscheidest du selbst nach den Konventionen des Projekts und nennst sie
  im Abschluss.
- Hat dein Agent ein Werkzeug für strukturierte Rückfragen (z. B. \`AskUserQuestion\` in Claude Code), nutze es – der
  Nutzer antwortet direkt im Chat mit Auswahlmöglichkeiten.
- Je nach Modus muss der Nutzer Befehle oder Dateiänderungen freigeben. Das ist kein Grund, die Aufgabe abzubrechen:
  Wird etwas abgelehnt, such einen anderen Weg oder frag, wie es weitergehen soll.

### Sicherheit
- API-Schlüssel und Tokens stehen nur in der Prozessumgebung zur Verfügung. Schreib sie niemals in Dateien, Logs,
  Commits, Notizen oder Aufgaben.
- Keine destruktiven Aktionen (Dateien massenhaft löschen, History umschreiben, Datenbanken leeren) ohne Rückfrage.
${AGENTFORGE_SECTION_END}`;
}

/** Full AGENTS.md for a new project: project skeleton + Agentforge section. */
export function agentsMdTemplate(projectName: string): string {
  return `# ${projectName}

Anweisungen für Coding-Agents (Claude Code, Codex, OpenCode, Cline, Kilo, Gemini, Qwen, Copilot, Goose, Kimi Code, Aider …),
die in diesem Repository arbeiten.

## Projektüberblick
_Noch nicht ausgefüllt._ Was macht das Projekt, für wen, welche Verzeichnisse sind wichtig?

## Setup & Befehle
_Noch nicht ausgefüllt._ Ermittle die Befehle für Installation, Dev-Server, Tests, Lint und Build aus \`package.json\`,
\`Makefile\`, \`pyproject.toml\` oder der README und trage sie hier ein, sobald du sie kennst.

## Code-Stil & Konventionen
_Noch nicht ausgefüllt._ Sprache/Framework, Formatierung, Benennung, bevorzugte Bibliotheken und Muster.

## Hinweise
_Noch nicht ausgefüllt._ Bekannte Stolperfallen, externe Dienste, Umgebungsvariablen.

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

/** CLAUDE.md with an `@AGENTS.md` import (after the title, if any); unchanged if it already imports it. */
export function withAgentsMdImport(content: string): string {
  if (/^@AGENTS\.md\s*$/m.test(content)) return content;
  const lines = content.split('\n');
  const at = lines[0]?.startsWith('# ') ? 1 : 0;
  lines.splice(at, 0, ...(at ? ['', '@AGENTS.md'] : ['@AGENTS.md', '']));
  return lines.join('\n');
}

/**
 * Contents to write so a workspace has current agent instructions: AGENTS.md with the Agentforge section and a
 * CLAUDE.md importing it. `null` = file missing. Only changed files are returned.
 */
export function agentInstructionUpdates(
  existing: { agentsMd: string | null; claudeMd: string | null },
  projectName: string,
): { path: 'AGENTS.md' | 'CLAUDE.md'; content: string }[] {
  const out: { path: 'AGENTS.md' | 'CLAUDE.md'; content: string }[] = [];
  const agents = existing.agentsMd === null ? agentsMdTemplate(projectName) : upsertAgentforgeSection(existing.agentsMd);
  if (agents !== existing.agentsMd) out.push({ path: 'AGENTS.md', content: agents });
  const claude = existing.claudeMd === null ? claudeMdTemplate(projectName) : withAgentsMdImport(existing.claudeMd);
  if (claude !== existing.claudeMd) out.push({ path: 'CLAUDE.md', content: claude });
  return out;
}
