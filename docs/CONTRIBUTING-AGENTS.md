# Parallel work rules (for coding agents working on this repo)

Repo: pnpm monorepo. Windows host with Docker Desktop; use the Bash tool with POSIX paths
(`/c/Users/Gotts/Documents/claude code/web code`). Node 24 on host, Node 22 in images.

## Layout & ownership
Several agents work **concurrently** in this working tree. Only edit files you own (listed in your task).
Shared registration points were pre-created so you should not need to touch other files:

- Contracts: `packages/shared/src/*.ts` (agent-events, sessions, git, preview, pm, wsd-protocol, ws-protocol,
  models). Treat them as fixed. If you truly need an addition, make it **additive** (new optional field / new type),
  in a single small Edit, then rebuild: `pnpm --filter @vibe/shared build`. Mention it in your report.
- Server feature modules: `apps/server/src/routes/{sessions,github,previews,pm,tools,system}.ts` are already
  registered in `apps/server/src/index.ts`. Put services in `apps/server/src/<feature>/`.
  `AppContext` (`app-context.ts`) gives you db, secrets, orch, workspaces, cfg, auth.
  `ctx.workspaces.waitForClient(projectId, ms)` → WsdClient (`call(method, params)`),
  `ctx.workspaces.onWsdNotification(fn)` and `ctx.workspaces.onConnected(fn)` for hooks.
  Publish browser events with `bus.project(projectId, event)` / `bus.publish('session:<id>', event)` (`events.ts`).
  Errors: throw `new HttpError(status, code, germanMessage)`; zod parse errors become 400 automatically.
  DB: `ctx.db.get/all/run/insert/update/tx` (node:sqlite). All tables for phases 2–5 exist (migration v2 in
  `db/migrations.ts`). Need another table/column? Append a NEW migration entry (never edit old ones) — one small Edit.
- wsd feature modules: `packages/workspace-daemon/src/{agents/index.ts,git.ts,tools.ts,tunnel.ts}` are wired
  into `server.ts`. Implement them there (+ new files next to them).
- Web: stub components exist in `apps/web/src/features/{chat,preview,git,github,pm,tools}/`. Replace the stub,
  keep the exported component name and props. Use `request<T>()` from `@/lib/api` for HTTP (it adds the CSRF
  header), `controlSocket` from `@/lib/ws` (`onEvent`, `subscribe`) for live events, react-query for caching,
  `useNav`/`useUi` from `@/lib/store` for cross-feature navigation. Put feature hooks in your own
  `features/<x>/api.ts` — do not edit `lib/queries.ts` or `lib/api.ts`. UI kit: `@/components/ui/*`
  (button, input, textarea, dialog, dropdown-menu, tabs, badge, card, select, tooltip, scroll-area, …), icons
  from lucide-react, toasts via `sonner`. German UI texts. Dark-first zinc look like the Claude desktop / Codex app.

## Product invariant: task status is agent-only
The user must never change the status of board tasks — not by dragging cards between columns, not in the task
dialog, not by ticking subtasks (board, task dialog, todo bar). Only the agent does that via its board tools
(`apps/server/src/pm/agent-tools.ts`). The user API enforces it (`apps/server/src/routes/pm.ts`: new tasks only in
`USER_TASK_COLUMNS`, no `column` in PATCH, `/move` only within the same column, no `done` on subtasks).
Keep UI and API that way, and keep the rule in the AGENTS.md template (`packages/shared/src/agents-md.ts`,
`docs/AGENTS.template.md`).

## Testing without stepping on each other
- Never stop/kill processes or containers you did not start. The user's dev servers run on 8787/5180.
- Start your own server instance on your assigned port with its own data dir, e.g.
  `AGENTFORGE_DATA_DIR=<your scratch dir> PORT=<your port> AGENTFORGE_ALLOWED_ORIGINS=http://localhost:<port> pnpm --filter @vibe/server exec tsx src/index.ts`
  (run it in the background, kill it when done). Create the admin via API:
  `POST /api/auth/setup {setupToken (from <data>/setup-token.txt), username, password}` with header `X-Vibe: 1`,
  keep the cookie jar.
- If you change the workspace daemon, build your own image tag:
  `docker build -f docker/workspace/Dockerfile -t agentforge-workspace:<yourname> .` and start your server with
  `WORKSPACE_IMAGE=agentforge-workspace:<yourname>`. Delete test projects via the API (removes containers) at the end.
- Before finishing: `pnpm -r typecheck`, `pnpm -r test`, `pnpm --filter @vibe/web build` must pass for the
  packages you touched (if another agent's in-progress file breaks the build, report it, don't "fix" their file).
- Do not commit; do not push; do not run `git` commands that modify the repo state.
