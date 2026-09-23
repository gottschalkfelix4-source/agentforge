import * as React from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  GitBranch,
  GitBranchPlus,
  GitCommitHorizontal,
  Github,
  Link2,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Undo2,
} from 'lucide-react';
import type { GitFileStatus, GitStatus } from '@vibe/shared';
import { useProject } from '@/lib/queries';
import { cn, errorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip } from '@/components/ui/tooltip';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PromptDialog } from '@/components/prompt-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useGitHubLive, useGitHubStatus } from '@/features/github/api';
import { gitApi, useGitBranches, useGitLive, useGitLog, useGitMutation, useGitStatus } from './api';
import { DiffView } from './DiffView';
import { LinkRepoDialog } from './LinkRepoDialog';
import { PullRequestsSection } from './PullRequests';
import { Section } from './Section';

type Selected = { path: string; staged: boolean } | null;

// Phase 3 – git changes, commit, branches, PRs
export function GitPanel({ projectId }: { projectId: string }) {
  useGitLive(projectId);
  useGitHubLive(projectId);
  const project = useProject(projectId);
  const status = useGitStatus(projectId);
  const [selected, setSelected] = React.useState<Selected>(null);
  const [discard, setDiscard] = React.useState<string[] | null>(null);
  const [linkOpen, setLinkOpen] = React.useState(false);

  const stage = useGitMutation(projectId, (paths: string[]) => gitApi.stage(projectId, paths));
  const unstage = useGitMutation(projectId, (paths: string[]) => gitApi.unstage(projectId, paths));
  const doDiscard = useGitMutation(projectId, (paths: string[]) => gitApi.discard(projectId, paths));

  if (status.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (status.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
        <AlertTriangle className="size-5 text-warning" />
        {errorMessage(status.error)}
        <Button variant="outline" size="sm" onClick={() => void status.refetch()}>
          <RefreshCw /> Erneut versuchen
        </Button>
      </div>
    );
  }

  const st = status.data;
  const repo = project.data?.repoOwner && project.data.repoName ? { owner: project.data.repoOwner, name: project.data.repoName } : null;

  if (!st.isRepo) {
    return (
      <>
        <NotARepo projectId={projectId} linked={repo} onLink={() => setLinkOpen(true)} />
        <LinkRepoDialog open={linkOpen} onOpenChange={setLinkOpen} projectId={projectId} suggestedName={project.data?.slug ?? 'projekt'} />
      </>
    );
  }

  if (selected) {
    const file = st.files.find((f) => f.path === selected.path);
    const inUnstaged = file && (file.index === '?' || file.worktree !== ' ');
    const inStaged = file && file.index !== ' ' && file.index !== '?';
    return (
      <>
        <DiffView
          projectId={projectId}
          path={selected.path}
          staged={selected.staged}
          onBack={() => setSelected(null)}
          onStage={!selected.staged && inUnstaged ? () => stage.mutate([selected.path], { onSuccess: () => setSelected(inStaged ? selected : { path: selected.path, staged: true }) }) : undefined}
          onUnstage={selected.staged && inStaged ? () => unstage.mutate([selected.path], { onSuccess: () => setSelected({ path: selected.path, staged: false }) }) : undefined}
          onDiscard={!selected.staged && inUnstaged ? () => setDiscard([selected.path]) : undefined}
        />
        <DiscardConfirm paths={discard} onClose={() => setDiscard(null)} onConfirm={async (p) => {
          await doDiscard.mutateAsync(p);
          setSelected(null);
        }} />
      </>
    );
  }

  const staged = st.files.filter((f) => f.index !== ' ' && f.index !== '?');
  const unstaged = st.files.filter((f) => f.index !== '?' && f.worktree !== ' ');
  const untracked = st.files.filter((f) => f.index === '?');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <BranchBar projectId={projectId} status={st} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <CommitBox projectId={projectId} stagedCount={staged.length} changedCount={st.files.length} />
        {st.files.length === 0 ? (
          <p className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
            <Check className="size-3.5 text-success" /> Keine Änderungen – Arbeitskopie ist sauber.
          </p>
        ) : (
          <>
            {staged.length > 0 && (
              <Section
                title="Gestaged"
                count={staged.length}
                actions={<IconAction label="Alle unstagen" icon={Minus} onClick={() => unstage.mutate([])} />}
              >
                {staged.map((f) => (
                  <FileRow key={`s:${f.path}`} file={f} code={f.index} onOpen={() => setSelected({ path: f.path, staged: true })}>
                    <IconAction label="Unstagen" icon={Minus} onClick={() => unstage.mutate([f.path])} />
                  </FileRow>
                ))}
              </Section>
            )}
            {unstaged.length > 0 && (
              <Section
                title="Änderungen"
                count={unstaged.length}
                actions={
                  <>
                    <IconAction label="Alle verwerfen" icon={Undo2} onClick={() => setDiscard(unstaged.map((f) => f.path))} />
                    <IconAction label="Alle stagen" icon={Plus} onClick={() => stage.mutate(unstaged.map((f) => f.path))} />
                  </>
                }
              >
                {unstaged.map((f) => (
                  <FileRow key={`u:${f.path}`} file={f} code={f.worktree} onOpen={() => setSelected({ path: f.path, staged: false })}>
                    <IconAction label="Verwerfen" icon={Undo2} onClick={() => setDiscard([f.path])} />
                    <IconAction label="Stagen" icon={Plus} onClick={() => stage.mutate([f.path])} />
                  </FileRow>
                ))}
              </Section>
            )}
            {untracked.length > 0 && (
              <Section
                title="Neu (untracked)"
                count={untracked.length}
                actions={
                  <>
                    <IconAction label="Alle löschen" icon={Undo2} onClick={() => setDiscard(untracked.map((f) => f.path))} />
                    <IconAction label="Alle stagen" icon={Plus} onClick={() => stage.mutate(untracked.map((f) => f.path))} />
                  </>
                }
              >
                {untracked.map((f) => (
                  <FileRow key={`n:${f.path}`} file={f} code="U" onOpen={() => setSelected({ path: f.path, staged: false })}>
                    <IconAction label="Löschen" icon={Undo2} onClick={() => setDiscard([f.path])} />
                    <IconAction label="Stagen" icon={Plus} onClick={() => stage.mutate([f.path])} />
                  </FileRow>
                ))}
              </Section>
            )}
          </>
        )}
        {repo ? (
          <PullRequestsSection
            projectId={projectId}
            repo={repo}
            branch={st.branch}
            defaultBranch={project.data?.defaultBranch ?? null}
            needsPush={!st.upstream || st.ahead > 0}
          />
        ) : (
          <div className="border-b border-border/60 px-3 py-2">
            <Button variant="ghost" size="sm" className="w-full justify-start text-muted-foreground" onClick={() => setLinkOpen(true)}>
              <Github /> Mit GitHub verknüpfen
            </Button>
          </div>
        )}
        <CommitLog projectId={projectId} repo={repo} />
      </div>
      <DiscardConfirm paths={discard} onClose={() => setDiscard(null)} onConfirm={(p) => doDiscard.mutateAsync(p)} />
      <LinkRepoDialog open={linkOpen} onOpenChange={setLinkOpen} projectId={projectId} suggestedName={project.data?.slug ?? 'projekt'} />
    </div>
  );
}

// ---- pieces ------------------------------------------------------------------------

const CODE_STYLE: Record<string, string> = {
  M: 'text-warning',
  A: 'text-success',
  U: 'text-success',
  D: 'text-destructive',
  R: 'text-brand',
  C: 'text-brand',
  T: 'text-warning',
};

function FileRow({ file, code, onOpen, children }: { file: GitFileStatus; code: string; onOpen: () => void; children: React.ReactNode }) {
  const slash = file.path.lastIndexOf('/');
  const name = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  const dir = slash >= 0 ? file.path.slice(0, slash) : '';
  return (
    <div className="group flex h-7 cursor-pointer items-center gap-1.5 pr-2 pl-6 hover:bg-accent/60" onClick={onOpen} title={file.from ? `${file.from} → ${file.path}` : file.path}>
      <span className={cn('truncate text-[13px]', code === 'D' && 'line-through opacity-70')}>{name}</span>
      {dir && <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{dir}</span>}
      {!dir && <span className="flex-1" />}
      <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
      <span className={cn('w-3 shrink-0 text-center font-mono text-[11px] font-semibold', CODE_STYLE[code] ?? 'text-muted-foreground')}>{code}</span>
    </div>
  );
}

function IconAction({ label, icon: Icon, onClick }: { label: string; icon: React.ComponentType<{ className?: string }>; onClick: () => void }) {
  return (
    <Tooltip content={label}>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
      >
        <Icon />
      </Button>
    </Tooltip>
  );
}

function DiscardConfirm({ paths, onClose, onConfirm }: { paths: string[] | null; onClose: () => void; onConfirm: (paths: string[]) => Promise<unknown> }) {
  return (
    <ConfirmDialog
      open={!!paths}
      onOpenChange={(o) => !o && onClose()}
      title={paths?.length === 1 ? 'Änderungen verwerfen?' : `${paths?.length ?? 0} Dateien verwerfen?`}
      description={
        <>
          Nicht gestagte Änderungen gehen verloren, neue (untracked) Dateien werden gelöscht. Das kann nicht rückgängig gemacht werden.
          {paths && paths.length <= 5 && (
            <span className="mt-2 block font-mono text-xs">{paths.join('\n')}</span>
          )}
        </>
      }
      confirmLabel="Verwerfen"
      onConfirm={() => onConfirm(paths ?? [])}
    />
  );
}

function BranchBar({ projectId, status }: { projectId: string; status: GitStatus }) {
  const branches = useGitBranches(projectId);
  const [createOpen, setCreateOpen] = React.useState(false);
  const checkout = useGitMutation(projectId, (v: { branch: string; create?: boolean }) => gitApi.checkout(projectId, v.branch, v.create));
  const fetch = useGitMutation(projectId, () => gitApi.fetch(projectId));
  const pull = useGitMutation(projectId, () => gitApi.pull(projectId));
  const push = useGitMutation(projectId, () => gitApi.push(projectId));
  const remotes = (branches.data?.remote ?? []).filter((r) => !branches.data?.local.includes(r.slice(r.indexOf('/') + 1)));

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="min-w-0 max-w-[60%] justify-start gap-1.5 px-2 font-mono text-xs">
            <GitBranch className="size-3.5 shrink-0" />
            <span className="truncate">{status.branch ?? '(detached)'}</span>
            <ChevronDown className="size-3 shrink-0 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
          <DropdownMenuItem onSelect={() => setCreateOpen(true)}>
            <GitBranchPlus /> Neuer Branch …
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Lokal</DropdownMenuLabel>
          {(branches.data?.local ?? []).map((b) => (
            <DropdownMenuItem key={b} disabled={b === status.branch} onSelect={() => checkout.mutate({ branch: b })} className="font-mono text-xs">
              {b === status.branch ? <Check /> : <span className="size-4" />} {b}
            </DropdownMenuItem>
          ))}
          {remotes.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Remote</DropdownMenuLabel>
              {remotes.map((b) => (
                <DropdownMenuItem key={b} onSelect={() => checkout.mutate({ branch: b })} className="font-mono text-xs">
                  <span className="size-4" /> {b}
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {status.upstream ? (
        <Tooltip content={`Upstream: ${status.upstream}`}>
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
            {status.behind > 0 && <span className="flex items-center"><ArrowDown className="size-3" />{status.behind}</span>}
            {status.ahead > 0 && <span className="flex items-center"><ArrowUp className="size-3" />{status.ahead}</span>}
            {status.ahead === 0 && status.behind === 0 && <Check className="size-3" />}
          </span>
        </Tooltip>
      ) : (
        <span className="text-[11px] text-muted-foreground">kein Upstream</span>
      )}
      <div className="ml-auto flex items-center gap-0.5">
        <Tooltip content="Fetch">
          <Button variant="ghost" size="icon-sm" disabled={fetch.isPending} onClick={() => fetch.mutate(undefined)}>
            <RefreshCw className={cn(fetch.isPending && 'animate-spin')} />
          </Button>
        </Tooltip>
        <Tooltip content="Pull">
          <Button variant="ghost" size="icon-sm" disabled={pull.isPending || !status.upstream} onClick={() => pull.mutate(undefined, { onSuccess: () => toast.success('Pull abgeschlossen') })}>
            {pull.isPending ? <Loader2 className="animate-spin" /> : <ArrowDown />}
          </Button>
        </Tooltip>
        <Tooltip content={status.upstream ? 'Push' : 'Branch veröffentlichen (Push)'}>
          <Button variant="ghost" size="icon-sm" disabled={push.isPending || !status.branch} onClick={() => push.mutate(undefined, { onSuccess: () => toast.success('Push abgeschlossen') })}>
            {push.isPending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
          </Button>
        </Tooltip>
      </div>
      <PromptDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Neuer Branch"
        description={`Wird von ${status.branch ?? 'HEAD'} abgezweigt und ausgecheckt.`}
        label="Name"
        placeholder="feature/mein-feature"
        confirmLabel="Erstellen"
        onSubmit={(name) => checkout.mutateAsync({ branch: name, create: true })}
      />
    </div>
  );
}

function CommitBox({ projectId, stagedCount, changedCount }: { projectId: string; stagedCount: number; changedCount: number }) {
  const [message, setMessage] = React.useState('');
  const commit = useGitMutation(projectId, async ({ andPush }: { andPush: boolean }) => {
    // Nothing staged → commit everything (like VS Code's smart commit).
    if (stagedCount === 0) await gitApi.stage(projectId, []);
    const r = await gitApi.commit(projectId, message.trim(), false);
    if (andPush) await gitApi.push(projectId);
    return r;
  });
  const disabled = !message.trim() || changedCount === 0 || commit.isPending;
  const run = (andPush: boolean) =>
    commit.mutate(
      { andPush },
      {
        onSuccess: (r) => {
          setMessage('');
          toast.success(`Commit ${r.sha.slice(0, 7)}${andPush ? ' gepusht' : ' erstellt'}`);
        },
      },
    );

  return (
    <div className="grid gap-2 border-b border-border/60 p-2">
      <Textarea
        rows={2}
        className="min-h-14 resize-y text-[13px]"
        placeholder={stagedCount ? 'Commit-Nachricht (Strg+Enter)' : 'Commit-Nachricht – committet alle Änderungen'}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !disabled) {
            e.preventDefault();
            run(false);
          }
        }}
      />
      <div className="flex">
        <Button variant="brand" size="sm" className="flex-1 rounded-r-none" disabled={disabled} onClick={() => run(false)}>
          {commit.isPending ? <Loader2 className="animate-spin" /> : <GitCommitHorizontal />}
          {stagedCount ? `Commit (${stagedCount})` : 'Commit (alle)'}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="brand" size="sm" className="rounded-l-none border-l border-brand-foreground/20 px-1.5" disabled={disabled} aria-label="Weitere Commit-Optionen">
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => run(true)}>
              <ArrowUp /> Commit & Push
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function relTime(iso: string): string {
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(d)) return '';
  if (d < 60) return 'gerade eben';
  if (d < 3600) return `vor ${Math.round(d / 60)} Min.`;
  if (d < 86400) return `vor ${Math.round(d / 3600)} Std.`;
  if (d < 86400 * 30) return `vor ${Math.round(d / 86400)} T.`;
  return new Date(iso).toLocaleDateString('de-DE');
}

function CommitLog({ projectId, repo }: { projectId: string; repo: { owner: string; name: string } | null }) {
  const log = useGitLog(projectId);
  return (
    <Section title="Commits" count={log.data?.length} defaultOpen>
      {log.isPending ? (
        <div className="flex justify-center py-3">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : log.isError ? (
        <p className="px-3 py-2 text-xs text-destructive">{errorMessage(log.error)}</p>
      ) : log.data.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">Noch keine Commits.</p>
      ) : (
        log.data.map((c) => {
          const body = (
            <>
              <div className="truncate text-[13px]">{c.subject}</div>
              <div className="flex gap-1.5 truncate text-[11px] text-muted-foreground">
                <span className="font-mono">{c.shortSha}</span>·<span className="truncate">{c.author}</span>·<span className="shrink-0">{relTime(c.date)}</span>
              </div>
            </>
          );
          return repo ? (
            <a
              key={c.sha}
              href={`https://github.com/${repo.owner}/${repo.name}/commit/${c.sha}`}
              target="_blank"
              rel="noreferrer"
              className="block px-3 py-1 hover:bg-accent/50"
              title={`${c.subject}\n${c.email}`}
            >
              {body}
            </a>
          ) : (
            <div key={c.sha} className="px-3 py-1" title={`${c.subject}\n${c.email}`}>
              {body}
            </div>
          );
        })
      )}
    </Section>
  );
}

function NotARepo({ projectId, linked, onLink }: { projectId: string; linked: { owner: string; name: string } | null; onLink: () => void }) {
  const gh = useGitHubStatus();
  const init = useGitMutation(projectId, () => gitApi.init(projectId));
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex max-w-xs flex-col items-center gap-3 text-center">
        <div className="flex size-12 items-center justify-center rounded-2xl border border-border bg-background text-muted-foreground">
          <GitBranch className="size-5" />
        </div>
        <div>
          <h3 className="text-sm font-semibold">Kein Git-Repository</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {linked
              ? `Verknüpft mit ${linked.owner}/${linked.name}. Initialisiere das Repository, „origin“ wird automatisch gesetzt.`
              : 'Initialisiere ein Repository, um Änderungen zu verfolgen, zu committen und zu pushen.'}
          </p>
        </div>
        <Button variant="brand" size="sm" disabled={init.isPending} onClick={() => init.mutate(undefined, { onSuccess: () => toast.success('Repository initialisiert') })}>
          {init.isPending ? <Loader2 className="animate-spin" /> : <GitBranchPlus />}
          Repository initialisieren
        </Button>
        {!linked && (
          <Button variant="outline" size="sm" onClick={onLink} disabled={!gh.data?.connected}>
            {gh.data?.connected ? <Link2 /> : <Github />}
            Mit GitHub verknüpfen
          </Button>
        )}
        {!linked && gh.data && !gh.data.connected && (
          <p className="text-[11px] text-muted-foreground">GitHub in den Einstellungen verbinden, um ein Repository zu verknüpfen.</p>
        )}
      </div>
    </div>
  );
}
