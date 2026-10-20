/**
 * Agent task runs: a task is handed to a structured agent session that works in its own git
 * worktree (`.worktrees/task-<id>` on branch `vibe/task-<id>-<slug>`). "Finish" commits, pushes
 * and opens a PR (when a GitHub repo is linked); a merged PR moves the task to done.
 *
 * Auto flow: a turn only finishes the run when the agent declared the task done before it ended (`task_done`
 * board tool, or moving its task to review/done — see `AgentTools.markRunDone`). Every turn ends with `end_turn`,
 * including one where the agent stops to ask the user a question, so the stop reason alone must not commit
 * half-done work and open a PR. An explicit signal was chosen over guessing "did the turn end with a question?"
 * from the transcript: that heuristic is language- and agent-specific and fails silently in both directions.
 * Without the signal the run simply stays open; the user can still finish it by hand.
 */
import type {
  AgentEvent,
  AgentSession,
  CreatePullRequest,
  CreateSessionRequest,
  GhPull,
  RunTaskRequest,
  TaskRun,
  WsdMethod,
  WsdMethods,
} from '@vibe/shared';
import { ulid } from 'ulid';
import { nowIso } from '../db/index.js';
import { HttpError } from '../workspaces/manager.js';
import { type PmRepo, publishPm, type RunRow, type TaskRow, toRun } from './repo.js';

export interface WsdLike {
  call<M extends WsdMethod>(method: M, params: WsdMethods[M][0]): Promise<WsdMethods[M][1]>;
}

export interface RunDeps {
  repo: PmRepo;
  /** Connected daemon client (waits briefly; throws a 409 HttpError when the workspace is not running). */
  wsd(projectId: string): Promise<WsdLike>;
  /** Connected client or null (no waiting). */
  connectedWsd(projectId: string): WsdLike | null;
  sessions: {
    create(projectId: string, req: CreateSessionRequest): Promise<AgentSession>;
    prompt(sessionId: string, text: string): Promise<unknown>;
    stop(sessionId: string): Promise<unknown>;
    /** Marks the session as belonging to a task run (agent_sessions.task_run_id). */
    link(sessionId: string, runId: string): void;
  };
  github: {
    repoOf(projectId: string): { owner: string; name: string } | null;
    connected(): boolean;
    createPull(projectId: string, input: CreatePullRequest): Promise<GhPull>;
    pullState(projectId: string, n: number): Promise<'open' | 'closed' | 'merged'>;
  };
  log?: { info: (m: string) => void; warn: (m: string) => void };
}

/** Stop reasons after which an auto-PR run is finished (ACP `end_turn`, Codex `completed`). */
export const AUTO_FINISH_REASONS = new Set(['end_turn', 'completed', 'stop', 'done']);

const ACTIVE: RunRow['status'][] = ['running', 'awaiting_review', 'failed'];
/** Runs whose session may still produce turns that Agentforge syncs (follow-ups after review or an open PR). */
const OPEN: RunRow['status'][] = [...ACTIVE, 'pr_open'];

export function slugify(s: string, max = 30): string {
  return (
    s
      .toLowerCase()
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/g, '') || 'aufgabe'
  );
}

export interface PromptContext {
  taskId: string;
  title: string;
  body: string;
  labels: string[];
  milestone: { title: string; dueOn: string | null } | null;
  issue: { number: number; url: string | null } | null;
  worktreePath: string;
  branch: string;
  /** Checklist of the task — the agent works through it and ticks items off (todo bar of the chat). */
  subtasks: { id: string; title: string; done: boolean }[];
}

export function buildTaskPrompt(c: PromptContext): string {
  const meta: string[] = [];
  if (c.labels.length) meta.push(`- Labels: ${c.labels.join(', ')}`);
  if (c.milestone) meta.push(`- Meilenstein: ${c.milestone.title}${c.milestone.dueOn ? ` (fällig am ${c.milestone.dueOn})` : ''}`);
  if (c.issue) meta.push(`- GitHub-Issue: #${c.issue.number}${c.issue.url ? ` (${c.issue.url})` : ''}`);
  return [
    'Bitte setze die folgende Aufgabe aus dem Projekt-Board um.',
    '',
    `# ${c.title}`,
    '',
    c.body.trim() || '_(keine weitere Beschreibung)_',
    ...(meta.length ? ['', '## Kontext', ...meta] : []),
    ...(c.subtasks.length
      ? [
          '',
          '## Unteraufgaben (Checkliste)',
          ...c.subtasks.map((s) => `- [${s.done ? 'x' : ' '}] ${s.title} (id: \`${s.id}\`)`),
          '',
          'Diese Unteraufgaben sind deine Todo-Liste für diese Aufgabe – der Nutzer sieht sie in der Todo-Leiste über dem Chat. ' +
            'Arbeite sie der Reihe nach ab und hake jede **sofort** mit `subtask_update` (`id`, `done: true`) ab, sobald sie erledigt ist. ' +
            'Fehlen Schritte, ergänze sie mit `subtasks_add` (Aufgaben-ID `' + c.taskId + '`). Führe dieselben Schritte nicht zusätzlich in einer eigenen Todo-Liste.',
        ]
      : [
          '',
          `Zerlege die Aufgabe zu Beginn mit \`subtasks_add\` (Aufgaben-ID \`${c.taskId}\`) in Unteraufgaben und hake sie mit \`subtask_update\` ab, sobald ein Schritt erledigt ist – so sieht der Nutzer deinen Fortschritt in der Todo-Leiste.`,
        ]),
    '',
    '## Arbeitsweise',
    `- Du arbeitest in einem eigenen Git-Worktree: \`/workspace/${c.worktreePath}\` (Branch \`${c.branch}\`). Das ist dein aktuelles Arbeitsverzeichnis.`,
    '- Arbeite ausschließlich in diesem Verzeichnis. Ändere keine Dateien außerhalb davon und wechsle nicht den Branch.',
    '- Setze die Aufgabe vollständig um. Führe vorhandene Tests, Linter oder Builds aus, wenn das sinnvoll ist.',
    '- Wenn du fertig bist, committe alle Änderungen mit einer aussagekräftigen Commit-Nachricht (`git add -A && git commit`). Pushen ist nicht nötig – das übernimmt Agentforge.',
    '- Über die Agentforge-Tools (MCP-Server `agentforge`) hast du Zugriff auf das Projekt-Board: lege für Folgearbeiten eigene Aufgaben an (`task_create`), halte Entscheidungen in Notizen fest (`note_create`/`note_update`) und schau bei Bedarf in Roadmap und andere Aufgaben.',
    '- Ist die Aufgabe vollständig erledigt, rufe **`task_done`** auf (auch nach späteren Nachbesserungen, z. B. aus dem Review). Erst dann übernimmt Agentforge am Ende deines Zugs Commit, Push und Pull Request und setzt die Aufgabe auf „Review“. ' +
      'Stellst du dem Nutzer eine Rückfrage oder ist die Arbeit noch nicht fertig, rufe `task_done` **nicht** auf – dann bleibt alles unangetastet, bis du weiterarbeitest.',
    '- Fasse zum Schluss kurz zusammen, was du geändert hast und was ggf. noch offen ist.',
  ].join('\n');
}

export function prBody(task: Pick<TaskRow, 'body' | 'gh_issue_number' | 'title'>, run: Pick<RunRow, 'agent_id' | 'branch'>): string {
  const parts = [task.body.trim(), '---', `Automatisch erstellt von Agentforge (Agent \`${run.agent_id}\`, Branch \`${run.branch}\`).`];
  if (task.gh_issue_number) parts.push(`Closes #${task.gh_issue_number}`);
  return parts.filter(Boolean).join('\n\n');
}

export class TaskRunService {
  private readonly finishing = new Set<string>();
  /** Tasks whose run is being started (guards the check-then-insert in `start` against double clicks). */
  private readonly starting = new Set<string>();
  private readonly checkTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly d: RunDeps) {}

  private get repo() {
    return this.d.repo;
  }

  private warn(m: string) {
    this.d.log?.warn(m);
  }

  private publish(projectId: string) {
    publishPm(projectId, 'run');
    publishPm(projectId, 'task');
  }

  private moveTask(task: TaskRow, column: TaskRow['col']) {
    if (task.col !== column) this.repo.updateTask(task.id, { column });
  }

  /** Review, unless the agent (or a merge) already moved the task to done. */
  private toReview(taskId: string) {
    const t = this.repo.taskRow(taskId);
    if (t.col !== 'done') this.moveTask(t, 'review');
  }

  private hasOtherOpenRun(taskId: string, runId: string): boolean {
    return !!this.repo.db.get(
      `SELECT id FROM task_runs WHERE task_id = ? AND id != ? AND status IN (${OPEN.map(() => '?').join(', ')}) LIMIT 1`,
      taskId,
      runId,
      ...OPEN,
    );
  }

  // ---- start --------------------------------------------------------------------------------

  async start(taskId: string, req: RunTaskRequest): Promise<TaskRun> {
    // The busy check below and the insert are separated by several daemon calls (worktree creation), so a double
    // click could otherwise create two runs and two worktrees. One server process owns the DB, so a set suffices.
    if (this.starting.has(taskId)) throw new HttpError(409, 'run_starting', 'Der Agent für diese Aufgabe wird gerade gestartet');
    this.starting.add(taskId);
    try {
      return await this.startRun(taskId, req);
    } finally {
      this.starting.delete(taskId);
    }
  }

  private async startRun(taskId: string, req: RunTaskRequest): Promise<TaskRun> {
    const task = this.repo.taskRow(taskId);
    const projectId = task.project_id;
    const busy = this.repo.db.get<{ id: string }>("SELECT id FROM task_runs WHERE task_id = ? AND status = 'running'", taskId);
    if (busy) throw new HttpError(409, 'run_active', 'Für diese Aufgabe arbeitet bereits ein Agent – bitte zuerst abschließen oder abbrechen');

    const client = await this.d.wsd(projectId);
    const status = await client.call('git.status', { cwd: '.' });
    if (!status.isRepo) {
      throw new HttpError(
        400,
        'no_git_repo',
        'Der Workspace ist noch kein Git-Repository. Bitte initialisiere zuerst Git (Git-Panel → „Repository initialisieren“) und lege einen ersten Commit an – der Agent arbeitet in einem eigenen Git-Worktree.',
      );
    }
    const head = await client.call('git.log', { cwd: '.', limit: 1 });
    if (!head.length) {
      throw new HttpError(400, 'no_commit', 'Das Git-Repository hat noch keinen Commit. Bitte lege zuerst einen ersten Commit an (Git-Panel), damit ein Worktree erstellt werden kann.');
    }
    const baseBranch = status.branch;
    const base = baseBranch ?? head[0]!.sha;

    // Unique worktree path + branch (a task can be run several times).
    const worktrees = await client.call('git.worktree.list', {});
    const paths = new Set(worktrees.map((w) => w.path.replace(/^\.\//, '')));
    const branches = new Set(worktrees.map((w) => w.branch?.replace(/^refs\/heads\//, '')).filter(Boolean));
    const short = taskId.slice(-6).toLowerCase();
    const slug = slugify(task.title);
    let path = '';
    let branch = '';
    for (let n = 1; n < 100; n++) {
      const sfx = n === 1 ? '' : `-${n}`;
      path = `.worktrees/task-${short}${sfx}`;
      branch = `vibe/task-${short}-${slug}${sfx}`;
      if (!paths.has(path) && !branches.has(branch)) break;
    }
    const wt = await client.call('git.worktree.add', { path, branch, base });
    const wtPath = wt.path.replace(/^\.\//, '') || path;

    const runId = ulid();
    const now = nowIso();
    this.repo.db.insert('task_runs', {
      id: runId,
      task_id: taskId,
      session_id: null,
      worktree_path: wtPath,
      branch: wt.branch?.replace(/^refs\/heads\//, '') || branch,
      agent_id: req.agentId,
      auto_pr: req.autoPr ? 1 : 0,
      pr_number: null,
      pr_url: null,
      status: 'running',
      created_at: now,
      updated_at: now,
      base_branch: baseBranch,
      base_sha: wt.head || head[0]!.sha,
      profile_id: req.profileId ?? null,
    });

    let session: AgentSession;
    try {
      session = await this.d.sessions.create(projectId, {
        agentId: req.agentId,
        profileId: req.profileId ?? null,
        title: `Aufgabe: ${task.title}`.slice(0, 200),
        cwd: wtPath,
        ...(req.approvalPolicy ? { approvalPolicy: req.approvalPolicy } : {}),
      });
    } catch (err) {
      this.repo.db.run('DELETE FROM task_runs WHERE id = ?', runId);
      await client.call('git.worktree.remove', { path: wtPath, force: true }).catch(() => undefined);
      throw err;
    }
    this.repo.updateRun(runId, { session_id: session.id });
    this.d.sessions.link(session.id, runId);

    if (session.status === 'error') {
      this.repo.updateRun(runId, { status: 'failed' });
    } else {
      const labels = this.repo.taskLabelRows(taskId).map((l) => l.name);
      const ms = task.milestone_id ? this.repo.milestoneRow(task.milestone_id) : null;
      const run = this.repo.runRow(runId);
      const prompt = buildTaskPrompt({
        taskId,
        title: task.title,
        body: task.body,
        labels,
        milestone: ms ? { title: ms.title, dueOn: ms.due_on } : null,
        issue: task.gh_issue_number ? { number: task.gh_issue_number, url: task.gh_url } : null,
        worktreePath: run.worktree_path,
        branch: run.branch,
        subtasks: this.repo.subtasks(taskId),
      });
      try {
        await this.d.sessions.prompt(session.id, prompt);
      } catch (err) {
        this.warn(`Aufgabe ${taskId}: Prompt fehlgeschlagen: ${(err as Error).message}`);
        this.repo.updateRun(runId, { status: 'failed' });
      }
    }
    // A run that failed to start (session error, prompt rejected) leaves the task where it was.
    if (this.repo.runRow(runId).status === 'running') this.moveTask(this.repo.taskRow(taskId), 'in_progress');
    this.publish(projectId);
    return toRun(this.repo.runRow(runId));
  }

  // ---- finish ---------------------------------------------------------------------------------

  async finish(runId: string, opts: { auto?: boolean } = {}): Promise<TaskRun> {
    const run = this.repo.runRow(runId);
    if (!ACTIVE.includes(run.status) && run.status !== 'pr_open') {
      throw new HttpError(409, 'run_closed', 'Dieser Agent-Lauf ist bereits abgeschlossen');
    }
    if (this.finishing.has(runId)) throw new HttpError(409, 'run_busy', 'Der Lauf wird gerade abgeschlossen');
    this.finishing.add(runId);
    const task = this.repo.taskRow(run.task_id);
    const projectId = task.project_id;
    try {
      // Finishing consumes the agent's done signal; a later follow-up turn has to declare done again.
      if (run.agent_done) this.repo.updateRun(runId, { agent_done: 0 });
      const client = await this.d.wsd(projectId);
      const cwd = run.worktree_path;
      const st = await client.call('git.status', { cwd });
      if (st.files.length) {
        await client.call('git.stage', { cwd, paths: [] });
        const msg = task.gh_issue_number ? `${task.title}\n\nRefs #${task.gh_issue_number}` : task.title;
        await client.call('git.commit', { cwd, message: msg });
      }
      const head = (await client.call('git.log', { cwd, limit: 1 }))[0]?.sha ?? null;
      const changed = !!head && head !== run.base_sha;
      if (!changed) {
        if (!opts.auto) throw new HttpError(400, 'no_changes', 'Keine Änderungen im Worktree – es gibt nichts zu committen.');
        // The agent declared the task done without changing files (e.g. nothing to do): the user reviews that.
        this.repo.updateRun(runId, { status: 'awaiting_review' });
        this.toReview(task.id);
        this.publish(projectId);
        return toRun(this.repo.runRow(runId));
      }

      const linked = !!this.d.github.repoOf(projectId) && this.d.github.connected();
      if (linked) {
        await client.call('git.push', { cwd, branch: run.branch, setUpstream: true });
        if (run.status !== 'pr_open' || !run.pr_number) {
          const pr = await this.d.github.createPull(projectId, {
            title: task.title,
            body: prBody(task, run),
            head: run.branch,
            base: run.base_branch ?? undefined,
          });
          this.repo.updateRun(runId, { status: 'pr_open', pr_number: pr.number, pr_url: pr.htmlUrl });
        } else {
          this.repo.updateRun(runId, {});
        }
      } else {
        this.repo.updateRun(runId, { status: 'awaiting_review' });
      }
      this.toReview(task.id);
      this.publish(projectId);
      return toRun(this.repo.runRow(runId));
    } finally {
      this.finishing.delete(runId);
    }
  }

  // ---- cancel ------------------------------------------------------------------------------------

  async cancel(runId: string, opts: { removeWorktree?: boolean } = {}): Promise<TaskRun> {
    const run = this.repo.runRow(runId);
    const task = this.repo.taskRow(run.task_id);
    const projectId = task.project_id;
    if (run.session_id) {
      await this.d.sessions.stop(run.session_id).catch((err: Error) => this.warn(`Sitzung ${run.session_id} stoppen: ${err.message}`));
    }
    if (opts.removeWorktree) {
      const client = await this.d.wsd(projectId);
      await client.call('git.worktree.remove', { path: run.worktree_path, force: true }).catch((err: Error) => {
        if (!/is not a working tree|kein|not found|No such/i.test(err.message)) throw err;
      });
    }
    if (run.status !== 'merged') this.repo.updateRun(runId, { status: 'cancelled', agent_done: 0 });
    const t = this.repo.taskRow(task.id);
    if (run.status !== 'merged' && (t.col === 'in_progress' || t.col === 'review') && !this.hasOtherOpenRun(task.id, runId)) this.moveTask(t, 'todo');
    this.publish(projectId);
    return toRun(this.repo.runRow(runId));
  }

  // ---- agent events (auto flow) ------------------------------------------------------------

  /**
   * Called for every `agent.event` notification. Also handles follow-up turns of runs that already await review or
   * have an open PR (review fixes, or a first turn without changes): once the agent declares done again, they are
   * committed, pushed and PR'd like the first turn.
   */
  onAgentEvent(sessionId: string, event: AgentEvent): Promise<void> | void {
    if (event.type !== 'turn.done') return;
    const run = this.repo.runBySession(sessionId);
    if (!run || !OPEN.includes(run.status)) return;
    const projectId = this.repo.taskRow(run.task_id).project_id;
    if (event.stopReason === 'error') {
      // Only a run that is still being worked on fails; a failed follow-up turn must not hide an open PR (merge
      // detection only looks at pr_open) or work that already awaits review.
      if (run.status === 'running') {
        this.repo.updateRun(run.id, { status: 'failed' });
        this.publish(projectId);
      }
      return;
    }
    if (!AUTO_FINISH_REASONS.has(event.stopReason)) return;
    if (!run.agent_done) {
      // The turn ended without the agent declaring the task done — typically a question to the user. Nothing is
      // committed; a run that had failed is being worked on again.
      if (run.status === 'failed') {
        this.repo.updateRun(run.id, { status: 'running' });
        this.publish(projectId);
      }
      return;
    }
    if (!run.auto_pr) {
      this.repo.updateRun(run.id, run.status === 'pr_open' ? { agent_done: 0 } : { agent_done: 0, status: 'awaiting_review' });
      this.toReview(run.task_id);
      this.publish(projectId);
      return;
    }
    return this.finish(run.id, { auto: true })
      .then(() => undefined)
      .catch((err: Error) => {
        this.warn(`Auto-PR für Lauf ${run.id}: ${err.message}`);
        // Keep pr_open so the merge of the existing PR is still detected.
        if (run.status !== 'pr_open') this.repo.updateRun(run.id, { status: 'failed' });
        this.publish(projectId);
      });
  }

  // ---- merged PRs -------------------------------------------------------------------------------

  /** Checks open PRs of runs (all projects or one) and completes merged ones. */
  async checkPullRequests(projectId?: string): Promise<number> {
    const rows = this.repo.db.all<RunRow & { project_id: string }>(
      `SELECT r.*, t.project_id FROM task_runs r JOIN tasks t ON t.id = r.task_id
        WHERE r.status = 'pr_open' AND r.pr_number IS NOT NULL ${projectId ? 'AND t.project_id = ?' : ''}`,
      ...(projectId ? [projectId] : []),
    );
    let n = 0;
    for (const r of rows) {
      if (!this.d.github.repoOf(r.project_id) || !this.d.github.connected()) continue;
      let state: 'open' | 'closed' | 'merged';
      try {
        state = await this.d.github.pullState(r.project_id, r.pr_number!);
      } catch (err) {
        this.warn(`PR #${r.pr_number}: ${(err as Error).message}`);
        continue;
      }
      if (state === 'open') continue;
      n++;
      if (state === 'merged') {
        this.repo.updateRun(r.id, { status: 'merged' });
        this.moveTask(this.repo.taskRow(r.task_id), 'done');
        const client = this.d.connectedWsd(r.project_id);
        if (client) {
          await client.call('git.worktree.remove', { path: r.worktree_path, force: true }).catch((err: Error) => this.warn(`Worktree ${r.worktree_path}: ${err.message}`));
        }
        if (r.session_id) await this.d.sessions.stop(r.session_id).catch(() => undefined);
      } else {
        // Closed without merge: the run is over. The task goes back to To Do (like a cancelled run) unless another
        // run works on it. The worktree is removed without force, so uncommitted changes keep it; the branch with
        // the PR's commits stays either way.
        this.repo.updateRun(r.id, { status: 'cancelled', agent_done: 0 });
        const t = this.repo.taskRow(r.task_id);
        if ((t.col === 'review' || t.col === 'in_progress') && !this.hasOtherOpenRun(r.task_id, r.id)) this.moveTask(t, 'todo');
        const client = this.d.connectedWsd(r.project_id);
        if (client) {
          await client.call('git.worktree.remove', { path: r.worktree_path }).catch((err: Error) => this.warn(`Worktree ${r.worktree_path}: ${err.message}`));
        }
        if (r.session_id) await this.d.sessions.stop(r.session_id).catch(() => undefined);
      }
      this.publish(r.project_id);
    }
    return n;
  }

  /** Debounced PR check for one project (e.g. after `github.changed`). */
  scheduleCheck(projectId: string, delayMs = 3_000) {
    if (this.checkTimers.has(projectId)) return;
    const hasOpen = this.repo.db.get(
      "SELECT r.id FROM task_runs r JOIN tasks t ON t.id = r.task_id WHERE r.status = 'pr_open' AND t.project_id = ? LIMIT 1",
      projectId,
    );
    if (!hasOpen) return;
    const t = setTimeout(() => {
      this.checkTimers.delete(projectId);
      void this.checkPullRequests(projectId).catch(() => undefined);
    }, delayMs);
    t.unref();
    this.checkTimers.set(projectId, t);
  }
}
