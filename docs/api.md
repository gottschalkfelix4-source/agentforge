# REST / WebSocket API (app server)

All routes under `/api`, JSON bodies, session cookie `vibe_session` (HttpOnly, SameSite=Strict).
State-changing requests must send header `X-Vibe: 1` (CSRF guard). Errors: `{ error, message }` with 4xx/5xx.
Types live in `packages/shared/src/models.ts`.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | /api/me | – | MeResponse (no auth needed) |
| POST | /api/auth/setup | SetupRequest | MeResponse (sets cookie) |
| POST | /api/auth/login | LoginRequest | MeResponse (sets cookie) |
| POST | /api/auth/logout | – | `{ok:true}` |
| GET | /api/system | – | SystemInfo |
| GET | /api/agents | – | AgentManifest[] |
| GET | /api/projects | – | ProjectWithWorkspace[] |
| POST | /api/projects | CreateProjectRequest | ProjectWithWorkspace (workspace boots async) |
| GET | /api/projects/:id | – | ProjectWithWorkspace |
| PATCH | /api/projects/:id | UpdateProjectRequest | ProjectWithWorkspace |
| DELETE | /api/projects/:id?deleteFiles=1 | – | `{ok:true}` |
| POST | /api/projects/:id/workspace/:action | – (action: WorkspaceAction) | Workspace |
| GET | /api/projects/:id/terminals | – | TerminalInfo[] |
| POST | /api/projects/:id/terminals | CreateTerminalRequest | TerminalInfo |
| DELETE | /api/projects/:id/terminals/:termId | – | `{ok:true}` |
| GET | /api/projects/:id/fs?path=. | – | FsEntry[] (paths relative to /workspace) |
| GET | /api/projects/:id/fs/file?path= | – | FsReadResult |
| PUT | /api/projects/:id/fs/file | `{path, content}` | `{ok:true}` |
| POST | /api/projects/:id/fs/mkdir | `{path}` | `{ok:true}` |
| POST | /api/projects/:id/fs/rename | `{from,to}` | `{ok:true}` |
| DELETE | /api/projects/:id/fs?path= | – | `{ok:true}` |
| GET | /api/projects/:id/ports | – | ListeningPort[] |
| GET | /api/providers | – | Provider[] |
| POST | /api/providers | ProviderInput | Provider |
| PATCH | /api/providers/:id | Partial<ProviderInput> | Provider |
| DELETE | /api/providers/:id | – | `{ok:true}` |
| GET | /api/agent-profiles | – | AgentProfile[] |
| POST | /api/agent-profiles | AgentProfileInput | AgentProfile |
| PATCH | /api/agent-profiles/:id | Partial<AgentProfileInput> | AgentProfile |
| DELETE | /api/agent-profiles/:id | – | `{ok:true}` |

## WebSockets
- `/ws` — control socket, messages per `ws-protocol.ts` (`sub` to `projects` / `project:<id>`).
- `/ws/term/:projectId/:termId` — terminal. Binary frames = raw PTY bytes both ways;
  text frames = `TermControl` JSON (`{type:'resize',cols,rows}` from client; `exit`/`error` from server).
  On attach the server first sends the scrollback buffer as binary.

Dev: web on :5180 (Vite, proxies `/api` and `/ws` to :8787), server on :8787 (container: 8080).

## System / Betrieb (Phase 7, `routes/system.ts`)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | /api/system/info?refresh=1 | – | version, uptime, dataDir, hostDataPath, previewMode, workspaceImage `{name,present,id,digest,created,sizeBytes,version}`, outdatedWorkspaces, workspaces `{total,running,connected}`, disk `{totalBytes,entries[],partial}` (cached 60 s; `refresh=1` recomputes), idle, pull |
| GET | /api/system/settings | – | `{workspaceIdleMinutes, workspaceIdleMinutesStored, workspaceIdleMinutesEnv}` |
| PUT | /api/system/settings | `{workspaceIdleMinutes: number \| null}` (0 = off, null = env default) | same as GET |
| GET | /api/system/backup?projects=1 | – | `application/gzip` stream (tar.gz: manifest.json, vibe.sqlite, [secret.key], [projects/…]); see docs/backup.md |
| POST | /api/system/pull-image | – | PullState `{state: idle\|pulling\|done\|error, progress, error, updated, …}` – starts a background pull |
| GET | /api/system/pull-image | – | PullState (poll while `pulling`) |

## Git & GitHub (Phase 3, `routes/github.ts`, service `github/service.ts`)

Types in `packages/shared/src/git.ts`. All project git routes proxy to wsd (`git.*` RPCs, git CLI inside the
workspace) and accept an optional `cwd` (relative to `/workspace`, e.g. `.worktrees/task-1`). Mutating routes publish
`{type:'git.changed', projectId}`; `fs.changed` from wsd is turned into a debounced (1 s) `git.changed` as well.
GitHub changes (PRs, CI) are published as `{type:'github.changed', projectId}` by the poller (every 60 s for linked
repos with open PRs, 5 min otherwise; conditional requests via ETags stored in `sync_cursors`, pauses when
`x-ratelimit-remaining` < 100).

| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | /api/github/status | – | GitHubStatus |
| GET | /api/github/client | – | `{clientId, fromEnv}` (OAuth App client id for the device flow) |
| PUT | /api/github/client | `{clientId: string \| null}` | `{clientId, fromEnv}` |
| POST | /api/github/device/start | – | GitHubDeviceStart (scopes `repo workflow read:org`) |
| POST | /api/github/device/poll | `{handle}` | GitHubDevicePoll (server throttles to GitHub's interval / slow_down) |
| POST | /api/github/token | `{token}` (PAT, validated via `GET /user`) | GitHubStatus |
| DELETE | /api/github | – | `{ok:true}` (deletes token, clears credentials in all workspaces) |
| GET | /api/github/repos?q=&page= | – | GhRepo[] (user repos sorted by push date; `q` filters, `owner/name` finds exact) |
| POST | /api/github/repos | `{name, private?, description?, org?, autoInit?}` | GhRepo (creates a repo; `autoInit` adds a README commit so it can be cloned right away; 409 `github_repo_exists` if taken) |
| GET | /api/github/orgs | – | `{login, avatarUrl}[]` (organisations usable as repo owner) |
| POST | /api/projects/:id/github/link | `{owner, name, setRemote?}` | `{repo: GhRepo, remoteSet}` – sets repoOwner/repoName (+ `origin`) |
| GET | /api/projects/:id/github/pulls?state=open\|closed\|all | – | GhPull[] (ciState for open PRs) |
| POST | /api/projects/:id/github/pulls | CreatePullRequest (base defaults to the repo's default branch) | GhPull |
| GET | /api/projects/:id/github/pulls/:n | – | GhPull & `{checks: GhCheck[]}` |
| POST | /api/projects/:id/github/pulls/:n/merge | `{method: merge\|squash\|rebase}` | `{merged, sha, message}` |
| GET | /api/projects/:id/github/issues?state= | – | GhIssue[] (PRs excluded) |
| POST | /api/projects/:id/github/issues | `{title, body?, labels?}` | GhIssue |
| GET | /api/projects/:id/github/checks?ref= | – | GhCheck[] (check runs + commit statuses; ref defaults to the default branch) |
| GET | /api/projects/:id/git/status?cwd= | – | GitStatus (`isRepo:false` if not a repo) |
| GET | /api/projects/:id/git/diff?path=&staged=1&cwd= | – | `{diff}` (unified; untracked files diffed against /dev/null) |
| POST | /api/projects/:id/git/stage \| unstage \| discard | `{paths: string[], cwd?}` (`[]` = all) | `{ok:true}` (discard: unstaged changes + untracked files) |
| POST | /api/projects/:id/git/commit | `{message, all?, cwd?}` | `{sha}` |
| POST | /api/projects/:id/git/push | `{remote?, branch?, setUpstream?, force?, cwd?}` (upstream set automatically if missing) | `{output}` |
| POST | /api/projects/:id/git/pull | `{remote?, branch?, cwd?}` | `{output}` |
| POST | /api/projects/:id/git/fetch | `{remote?, cwd?}` (default `--all --prune`) | `{output}` |
| GET | /api/projects/:id/git/branches?cwd= | – | GitBranches |
| POST | /api/projects/:id/git/checkout | `{branch, create?, startPoint?, cwd?}` (remote `origin/x` → tracking branch `x`) | `{ok:true}` |
| GET | /api/projects/:id/git/log?limit=30&ref=&cwd= | – | GitCommit[] |
| POST | /api/projects/:id/git/init | `{defaultBranch?, cwd?}` (sets `origin` if the project is linked) | `{ok:true}` |
| GET / PUT | /api/projects/:id/git/remote | `?name=` / `{name?, url}` | `{url}` / `{ok:true}` |
| GET | /api/projects/:id/git/worktrees | – | GitWorktree[] |
| POST | /api/projects/:id/git/worktrees | `{path, branch, base?}` (e.g. `.worktrees/<name>`, new branch from base) | GitWorktree |
| DELETE | /api/projects/:id/git/worktrees?path=&force=1 | – | `{ok:true}` |

`POST /api/projects` accepts `repo: {owner, name}`: the project is linked, `gitUrl`/`defaultBranch` are taken from
GitHub, and the workspace is cloned via `git.clone` RPC right after the credentials were pushed (works for private
repos; `WSD_INIT_GIT_URL` is only used for plain `gitUrl` projects). Terminals get `GH_TOKEN` in their process env.

**Credentials in workspaces:** on every wsd connect (and whenever the token changes) the server calls
`git.credentials.set {host:'github.com', username:'x-access-token', token}` and `git.identity.set` (GitHub name,
`<id>+<login>@users.noreply.github.com`). wsd keeps the token in memory only; git reaches it through the system-wide
credential helper `/opt/wsd/git-credential-vibe`, which asks wsd over the unix socket `/run/wsd/cred.sock`
(dir 0700, owned by `coder`). Nothing is written to disk inside the workspace.

**Device flow setup:** create a GitHub OAuth App (Settings → Developer settings → OAuth Apps; any callback URL),
tick "Enable Device Flow", and put its client id into `GITHUB_CLIENT_ID` or Settings → GitHub. No client secret needed.

## Sessions (Phase 2 – structured agent chats)

Types: `AgentSession`, `CreateSessionRequest`, `PromptRequest`, `ApprovalResponse` (`sessions.ts`),
`AgentEvent`, `SessionEventRecord` (`agent-events.ts`). Agent processes are hosted by wsd inside the workspace
(adapters in `packages/agent-adapters`: ACP for claude/opencode/cline/kilo/gemini, Codex app-server for codex),
so they keep running while the app server restarts; events are backfilled on reconnect.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | /api/projects/:id/sessions | – | AgentSession[] (latest activity first) |
| POST | /api/projects/:id/sessions | CreateSessionRequest | AgentSession (status `idle`, or `error` + statusMessage if the agent failed to start) |
| GET | /api/sessions/:sid | – | AgentSession |
| PATCH | /api/sessions/:sid | `{title}` | AgentSession |
| DELETE | /api/sessions/:sid | – | `{ok:true}` (stops the agent, deletes session + events) |
| GET | /api/sessions/:sid/events?since=0 | – | SessionEventRecord[] (seq > since, ascending) |
| POST | /api/sessions/:sid/prompt | PromptRequest | `{ok:true}` (queued while a turn runs; resumes a stopped agent automatically) |
| POST | /api/sessions/:sid/cancel | – | `{ok:true}` (cancels the turn, drops queued prompts, resolves open approvals as `cancelled`) |
| POST | /api/sessions/:sid/approval | ApprovalResponse | `{ok:true}` |
| POST | /api/sessions/:sid/mode | `{mode}` | `{ok:true}` (ids from `session.info.modes`) |
| POST | /api/sessions/:sid/model | `{model}` | `{ok:true}` (ids from `session.info.models`) |
| POST | /api/sessions/:sid/stop | – | AgentSession (`stopped`) |
| POST | /api/sessions/:sid/resume | – | AgentSession (restarts the agent with `resumeExternalId`) |
| GET | /api/settings/chat | – | `{allowClaudeSubscriptionChat: boolean}` |
| PUT | /api/settings/chat | `{allowClaudeSubscriptionChat: boolean}` | same |

Errors: `claude_subscription_chat` (400) – Claude without an API-key profile (Anthropic forbids subscription use in
third-party apps) unless `allowClaudeSubscriptionChat` is set; `invalid_agent` / `invalid_profile` (400);
`session_not_running` (409) for cancel/approval/mode/model when the agent process is gone (call `/resume`);
`workspace_not_running` (409).

**Live events:** subscribe to `session:<sid>` → `{type:'session.event', sessionId, seq, ts, event}`;
`project:<id>` → `session.updated` (status/title/model/mode/externalId changed) and `session.deleted`.

**Event stream semantics (for the chat UI):**
- A turn looks like `user.message` → `turn.start` → `status:running` → … → `turn.done{stopReason}` → `status:idle`.
  `stopReason`: `end_turn`, `cancelled`, `max_tokens`, `refusal`, `error`, `exited` (agent process died).
- `message.delta` events stream text; `message.done` carries the **full** text (replace, don't append).
  After `message.done` the server deletes the deltas of that message from the DB, so history fetched via
  `/events` contains only `message.done` (seq numbers then have holes — that's expected).
- Thinking is `role:'thought'`. A role switch or a tool call closes the open message.
- `tool.update.output` is appended output; `tool.done.output` (if present) is the complete output and replaces it.
  `diffs` carry either `oldText/newText` (ACP) or `unified` (Codex).
- `approval.request` → status `awaiting_approval`; answer with an option id from `options`. `approval.resolved`
  has `optionId:'cancelled'` when a cancel/turn end resolved it.
- `session.info` is always a full snapshot (models, modes, commands, current values, externalId).
- `error` events are informational (e.g. resume fell back to a new agent session); `status:error` means the agent
  process is gone — the next prompt resumes it.
- Events may arrive out of seq order on the live channel right after a reconnect (live + backfill race);
  order by `seq`, dedupe by `seq`.
- Every agent gets the Playwright MCP server (`playwright-mcp --headless --isolated --browser chromium`).
- Codex modes (Agentforge-defined, the Linux sandbox can't run inside the container, so it always runs with
  full access inside the workspace): `ask` (approval policy `untrusted`, default), `auto` (`on-request`), `full` (`never`).

## Agents, Tools & Provider (Phase 6, `routes/tools.ts`, `routes/providers.ts`, `tools/`, `agents/providers/`)

| Method | Path | Body | Response |
|---|---|---|---|
| POST | /api/providers/:id/test | optional overrides `{kind?, baseUrl?, apiKey?}` (stored key is used when `apiKey` is empty) | ProviderTestResult `{ok, models?, error?}` |
| POST | /api/providers/test | `{kind, baseUrl?, apiKey?}` (unsaved provider) | ProviderTestResult |
| GET | /api/tools/latest | – | AgentToolStatus[] (latest versions only, `installed: null`) |
| GET | /api/projects/:id/tools | – | AgentToolStatus[] `{agentId,label,bin,installed,latest,updateAvailable,installable,chat}` |
| POST | /api/projects/:id/tools/install | `{agentId, cols?, rows?}` | TerminalInfo (+ `term.created` event) |

- Provider test = list models with a 10 s timeout: OpenAI/-compatible/OpenRouter `GET <base>/models`
  (OpenRouter additionally `GET <base>/key` because its model list is public), Ollama `GET <root>/api/tags`,
  Anthropic(-compatible) `GET <root>/v1/models` (`x-api-key`, compat also `Authorization: Bearer`),
  Gemini `GET <base>/v1beta/models` (`x-goog-api-key`). The key is redacted from error messages.
- Installed versions come from wsd `tools.versions` (`<bin> <versionArgs>`, 5 s timeout, parallel). Latest versions:
  npm registry (`npmPackage`), PyPI (`pypiPackage`), GitHub releases (`githubRepo`), cached 1 h (failures 1 min).
- Install/update runs in a workspace terminal: `npm i -g <npmPackage>@latest <extraNpmPackages>@latest`, or the
  manifest's `installCommand`. `NPM_CONFIG_PREFIX`/`UV_TOOL_DIR`/`UV_TOOL_BIN_DIR` point into the shared
  `/opt/vibe-tools` volume, so the update applies to every workspace (it shadows the image version via PATH).

### Provider-Renderer (`apps/server/src/agents/providers/renderers.ts`)
Profiles in provider mode are turned into per-agent env/args. Secrets are only placed in the process env of the
agent (never in args or files); `buildAgentLaunch` (TUI) and `buildStructuredLaunch` (chat) share the renderer.
A profile whose provider kind is not in the manifest's `providerKinds` is rejected (400).

| Agent | Mapping |
|---|---|
| Claude Code | anthropic: `ANTHROPIC_API_KEY`; anthropic_compat/openrouter: `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`; ollama: `ANTHROPIC_BASE_URL=<ollama root>` (needs Ollama ≥ 0.14 with its Anthropic-compatible API; the model is also set as `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` because Ollama has no Claude model names; tool use quality depends on the local model) |
| Codex | openai without base URL: `OPENAI_API_KEY`; otherwise `-c model_provider="vibe"` + `model_providers.vibe.{name,base_url,env_key="VIBE_PROVIDER_KEY",wire_api="responses"}` (Codex 0.15x rejects `wire_api="chat"`; the endpoint must serve `/v1/responses` – Ollama ≥ 0.13, OpenRouter, LiteLLM do). Ollama base `<root>/v1`. |
| OpenCode / Kilo | inline JSON config in `OPENCODE_CONFIG_CONTENT` / `KILO_CONFIG_CONTENT` (merged over the user config): native providers `anthropic`/`openai`/`google`, otherwise provider `vibe` with `@ai-sdk/openai-compatible` (openai_compat/openrouter/ollama `<root>/v1`) or `@ai-sdk/anthropic` (anthropic_compat), models = provider models + selected model. Key as `{env:VIBE_PROVIDER_KEY}`. Model becomes `<provider>/<model>` (`--model` for the TUI, ACP `set_model` for chats). |
| Gemini CLI | kind `gemini`: `GEMINI_API_KEY`, `GEMINI_DEFAULT_AUTH_TYPE=gemini-api-key`, optional `GOOGLE_GEMINI_BASE_URL`. |
| Qwen Code | OpenAI-like kinds: `OPENAI_API_KEY/OPENAI_BASE_URL/OPENAI_MODEL`; anthropic(-compat): `ANTHROPIC_API_KEY/BASE_URL/MODEL`; gemini: `GEMINI_API_KEY/GEMINI_MODEL`; plus `--auth-type <openai\|anthropic\|gemini>` (TUI and ACP) and `QWEN_DEFAULT_AUTH_TYPE`. |
| Copilot CLI | BYOK: `COPILOT_PROVIDER_{TYPE,BASE_URL,API_KEY}`, `COPILOT_MODEL` (required by Copilot for BYOK), `COPILOT_PROVIDER_WIRE_API=responses` for api.openai.com. |
| Cline | best effort: `CLINE_PROVIDER` (anthropic, openai-native, openai-compatible, openrouter, ollama, gemini) + `CLINE_MODEL` + the provider's standard key env; TUI also gets `--provider <id>`. Custom base URLs are only honoured where Cline reads `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL`; for Ollama/other URLs run `cline auth -p <id> -b <url>` once in the login terminal. |
| Aider (terminal only) | litellm env (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`/`OPENAI_API_BASE`, `OPENROUTER_API_KEY`, `OLLAMA_API_BASE`, `GEMINI_API_KEY`); model prefixed `openai/`, `openrouter/`, `ollama_chat/`, `gemini/`, `anthropic/` (compat). |
| Goose | `GOOSE_PROVIDER` (anthropic/openai/openrouter/ollama/google) + `GOOSE_MODEL` + `ANTHROPIC_HOST` / `OPENAI_HOST`+`OPENAI_BASE_PATH` / `OLLAMA_HOST` / key env. No model flag. |

## Projektmanagement (Phase 5, `routes/pm.ts`, services in `apps/server/src/pm/`)

Types in `packages/shared/src/pm.ts`. Every mutation publishes `{type:'pm.changed', projectId, entity}` on
`project:<id>` (`entity`: task | milestone | label | note | run).

| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | /api/projects/:id/tasks | – | Task[] (labels + latestRun; sorted by column, rank) |
| POST | /api/projects/:id/tasks | TaskInput (column default `backlog`) | Task (rank = end of column) |
| PATCH | /api/tasks/:tid | Partial<TaskInput> (column change → end of the new column) | Task |
| DELETE | /api/tasks/:tid | – | `{ok:true}` (the GitHub issue is left untouched) |
| POST | /api/tasks/:tid/move | MoveTaskRequest `{column, beforeId?, afterId?}` – `beforeId` = card directly above, `afterId` = directly below; `beforeId` wins if both are stale; none → end of column | Task |
| POST | /api/tasks/:tid/subtasks | `{title}` or `{titles: string[]}` (appended in order) | Task (incl. `subtasks: {id, title, done}[]`) |
| POST | /api/tasks/:tid/subtasks/order | `{ids}` – new order (missing ids keep their order at the end) | Task |
| PATCH / DELETE | /api/subtasks/:sid | `{title?, done?}` / – | Task (subtasks are local, not synced to GitHub) |
| GET | /api/sessions/:sid/tasks | – | `{taskIds, runTaskId}` – board tasks shown in the chat's todo bar (task run + linked; agents link tasks they set to in_progress/review or give subtasks) |
| PUT / DELETE | /api/sessions/:sid/tasks/:tid | – | `{ok:true}` (link / unlink; the task run's task cannot be unlinked) |
| GET / POST | /api/projects/:id/labels | – / `{name, color?}` (hex without `#`, auto color if omitted) | Label[] / Label (409 on duplicate name) |
| PATCH / DELETE | /api/labels/:lid | `{name?, color?}` / – | Label / `{ok:true}` |
| GET / POST | /api/projects/:id/milestones | – / MilestoneInput (`dueOn` = `YYYY-MM-DD`) | Milestone[] (sorted by due date, with `progress {total, done}`) / Milestone |
| PATCH / DELETE | /api/milestones/:mid | Partial<MilestoneInput> / – | Milestone / `{ok:true}` (tasks keep existing, milestone unset) |
| GET / POST | /api/projects/:id/notes | – / NoteInput | Note[] (pinned first, then last edited) / Note |
| PATCH / DELETE | /api/notes/:nid | NoteInput / – | Note / `{ok:true}` |
| POST | /api/tasks/:tid/run | RunTaskRequest `{agentId, profileId?, autoPr?}` | TaskRun (see below; 400 `no_git_repo` / `no_commit`, 409 `run_active`, 409 workspace not running) |
| GET | /api/tasks/:tid/runs | – | TaskRun[] (newest first) |
| POST | /api/task-runs/:rid/finish | – | TaskRun (commit + push + PR; 400 `no_changes`) |
| POST | /api/task-runs/:rid/cancel | `{removeWorktree?: boolean}` | TaskRun (`cancelled`; stops the session; task in_progress → todo) |
| POST | /api/projects/:id/github/sync | – | PmSyncResult `{at, ok, message, pulled, pushed, conflicts}` (400 `no_repo` / `github_not_connected`, 502 `sync_failed`) |
| GET | /api/projects/:id/github/sync-log?limit=100 | – | SyncLogEntry[] (newest first) |
| GET / PUT | /api/projects/:id/pm-settings | – / `{syncEnabled?, syncCreateIssues?}` | PmSettings `{syncEnabled, syncCreateIssues, linked, lastSync}` (settings key `pm:<projectId>`, both default `true`) |

**Ranks:** fractional-index strings (base 62, `pm/rank.ts`), compared as plain strings; a column is renumbered only
if it contains duplicate/invalid ranks.

**Task runs (`pm/runs.ts`):** `run` checks `git.status`/`git.log` in `/workspace` (must be a repo with ≥1 commit), creates
`git.worktree.add {path: .worktrees/task-<last 6 of id>[-n], branch: vibe/task-<id6>-<slug>[-n], base: current branch}`,
creates a structured agent session via `SessionService.create` with `cwd` = worktree (the session gets `taskRunId`), sends
the task prompt (title, body, labels, milestone, issue + "work only in this directory, commit when done"), inserts
`task_runs` (status `running`, base branch/sha stored — migration v3 adds `base_branch`, `base_sha`, `profile_id`) and moves
the task to `in_progress`. `finish` stages + commits everything left in the worktree (message = task title, `Refs #n`),
detects changes (dirty files or HEAD ≠ base sha), and — if a GitHub repo is linked and connected — pushes the branch and
opens a PR against the base branch (body ends with `Closes #<issue>`), status `pr_open`; otherwise status
`awaiting_review`. The task moves to `review`.
**Auto flow:** on `agent.event` `turn.done` of a run's session: `stopReason` `end_turn`/`completed` → `finish` when
`autoPr` (no changes → `awaiting_review`; errors → `failed`), without `autoPr` → `awaiting_review`; `stopReason:'error'`
→ `failed` (a later successful turn re-evaluates). **Merge detection:** every 2 min and (debounced) on `github.changed`,
runs in `pr_open` are checked via `GET /pulls/:n`; merged → run `merged`, task `done`, worktree removed, session stopped;
closed without merge → run `cancelled`.

**GitHub Issues sync (`pm/sync.ts`):** linked projects only, every 2 min when `syncEnabled` (skipped while the rate limit is
< 200) plus on demand. Order: milestones (ETag cursor `pm:milestones`), then issues (`state=all`, cursor `pm:issues` with
ETag + `since`). Mapping: title ↔ title, body ↔ body, closed ↔ column `done`, label `status:<column>` ↔ column (open
issues; no status label keeps the local column, a reopened issue leaves `done` → `todo`), other labels ↔ labels (created
locally with GitHub's color), milestone ↔ milestone (title, description, due date, state). After each pull/push both
`updated_at` and `gh_updated_at` are set to GitHub's `updated_at`, so *remote changed* = `issue.updated_at > gh_updated_at`
and *local changed* = `updated_at > gh_updated_at`; both changed → last writer wins by timestamp (logged as "Konflikt").
Local tasks/milestones without a GitHub counterpart are created on GitHub only when `syncCreateIssues` is on.
Every pull/push/conflict is written to `sync_log`.

## Agentforge-Tools für Agents (MCP)

Jede Chat-Session bekommt automatisch den MCP-Server `agentforge` (Programm `agentforge-mcp` im Workspace-Image,
Definitionen in `packages/shared/src/agent-tools.ts`). Damit können alle Agents das Projekt-Board nutzen:

| Tool | Zweck |
|---|---|
| `project_overview`, `current_task` | Überblick (Status-Zählung, offene Meilensteine, angeheftete Notizen) bzw. die Aufgabe dieser Session |
| `tasks_list`, `task_get`, `task_create`, `task_update`, `task_set_status` | Aufgaben lesen, anlegen, bearbeiten, Status (backlog/todo/in_progress/review/done) setzen |
| `milestones_list`, `milestone_create`, `milestone_update` | Roadmap |
| `notes_list`, `note_get`, `note_create`, `note_update` | Projektnotizen (inkl. `append`) |

Weg eines Aufrufs: `agentforge-mcp` (stdio) → `POST 127.0.0.1:7777/app-call` (wsd, Bearer-Token des Workspaces) →
Notification `app.request` an die App → `AgentTools` (`apps/server/src/pm/agent-tools.ts`) → Antwort per `app.respond`.
Aufrufe sind auf das Projekt des Workspaces beschränkt; Änderungen lösen `pm.changed` aus (Board aktualisiert sich live).
Löschen ist über die Tools bewusst nicht möglich.
