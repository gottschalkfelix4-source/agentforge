import * as React from 'react';
import { toast } from 'sonner';
import {
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestDraft,
  Loader2,
  Plus,
} from 'lucide-react';
import type { CiState, GhPull } from '@vibe/shared';
import { cn, errorMessage } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useCreatePull, useMergePull, usePulls } from '@/features/github/api';
import { gitApi, useGitMutation } from './api';
import { Section } from './Section';

export function CiBadge({ state }: { state: CiState }) {
  if (state === 'none') return null;
  const map = {
    success: { icon: CircleCheck, cls: 'text-success', label: 'Checks erfolgreich' },
    failure: { icon: CircleX, cls: 'text-destructive', label: 'Checks fehlgeschlagen' },
    pending: { icon: CircleDashed, cls: 'text-warning animate-spin [animation-duration:3s]', label: 'Checks laufen' },
    neutral: { icon: CircleDot, cls: 'text-muted-foreground', label: 'Checks neutral' },
  } as const;
  const m = map[state];
  return (
    <Tooltip content={m.label}>
      <m.icon className={cn('size-3.5 shrink-0', m.cls)} />
    </Tooltip>
  );
}

export function PullRequestsSection({
  projectId,
  repo,
  branch,
  defaultBranch,
  needsPush,
}: {
  projectId: string;
  repo: { owner: string; name: string };
  branch: string | null;
  defaultBranch: string | null;
  needsPush: boolean;
}) {
  const pulls = usePulls(projectId, true, 'open');
  const [createOpen, setCreateOpen] = React.useState(false);
  const merge = useMergePull(projectId);
  const current = pulls.data?.find((p) => p.head === branch);

  return (
    <Section
      title="Pull Requests"
      count={pulls.data?.length}
      actions={
        <Tooltip content="Pull Request erstellen">
          <Button variant="ghost" size="icon-xs" onClick={() => setCreateOpen(true)} disabled={!branch}>
            <Plus />
          </Button>
        </Tooltip>
      }
    >
      {pulls.isPending ? (
        <div className="flex justify-center py-3">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : pulls.isError ? (
        <p className="px-3 py-2 text-xs text-destructive">{errorMessage(pulls.error)}</p>
      ) : (
        <div className="grid">
          {branch && branch !== defaultBranch && !current && (
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="mx-2 my-1 flex items-center gap-2 rounded-md border border-dashed border-border px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <GitPullRequest className="size-3.5" /> PR für <span className="font-mono text-foreground">{branch}</span> erstellen
            </button>
          )}
          {pulls.data.length === 0 && (branch === defaultBranch || !branch) && (
            <p className="px-3 py-2 text-xs text-muted-foreground">Keine offenen Pull Requests.</p>
          )}
          {pulls.data.map((pr) => (
            <PullRow key={pr.number} pr={pr} highlight={pr.head === branch} onMerge={(method) => merge.mutate({ n: pr.number, method }, {
              onSuccess: (r) => (r.merged ? toast.success(`#${pr.number} gemergt`) : toast.error(r.message)),
            })} merging={merge.isPending && merge.variables?.n === pr.number} />
          ))}
          <a
            href={`https://github.com/${repo.owner}/${repo.name}/pulls`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 px-3 py-1.5 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="size-3" /> Alle auf GitHub
          </a>
        </div>
      )}
      {branch && (
        <CreatePullDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          projectId={projectId}
          head={branch}
          base={defaultBranch ?? 'main'}
          needsPush={needsPush}
        />
      )}
    </Section>
  );
}

function PullRow({ pr, highlight, onMerge, merging }: { pr: GhPull; highlight: boolean; onMerge: (m: 'merge' | 'squash' | 'rebase') => void; merging: boolean }) {
  return (
    <div className={cn('group flex items-center gap-2 px-3 py-1.5 hover:bg-accent/50', highlight && 'bg-brand/5')}>
      {pr.draft ? <GitPullRequestDraft className="size-3.5 shrink-0 text-muted-foreground" /> : <GitPullRequest className="size-3.5 shrink-0 text-success" />}
      <a href={pr.htmlUrl} target="_blank" rel="noreferrer" className="min-w-0 flex-1 hover:underline">
        <div className="truncate text-[13px]">{pr.title}</div>
        <div className="truncate text-[11px] text-muted-foreground">
          #{pr.number} · <span className="font-mono">{pr.head}</span> → <span className="font-mono">{pr.base}</span> · {pr.author}
        </div>
      </a>
      <CiBadge state={pr.ciState} />
      {pr.draft && <Badge variant="outline">Entwurf</Badge>}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" className="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100" disabled={merging || pr.draft} aria-label="Mergen">
            {merging ? <Loader2 className="animate-spin" /> : <GitMerge />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => onMerge('merge')}>
            <GitMerge /> Merge-Commit
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onMerge('squash')}>
            <GitMerge /> Squash & Merge
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onMerge('rebase')}>
            <GitMerge /> Rebase & Merge
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function CreatePullDialog({
  open,
  onOpenChange,
  projectId,
  head,
  base: defaultBase,
  needsPush,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  head: string;
  base: string;
  needsPush: boolean;
}) {
  const [title, setTitle] = React.useState('');
  const [body, setBody] = React.useState('');
  const [base, setBase] = React.useState(defaultBase);
  const [draft, setDraft] = React.useState(false);
  const [pushFirst, setPushFirst] = React.useState(needsPush);
  const create = useCreatePull(projectId);
  const push = useGitMutation(projectId, () => gitApi.push(projectId));

  React.useEffect(() => {
    if (!open) return;
    setTitle(head.replace(/^(feat|fix|chore|task)[/-]/, '').replace(/[-_/]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase()));
    setBody('');
    setBase(defaultBase);
    setDraft(false);
    setPushFirst(needsPush);
  }, [open, head, defaultBase, needsPush]);

  const busy = create.isPending || push.isPending;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (pushFirst) await push.mutateAsync(undefined);
      const pr = await create.mutateAsync({ title: title.trim(), body, head, base: base.trim() || undefined, draft });
      toast.success(`Pull Request #${pr.number} erstellt`, {
        action: { label: 'Öffnen', onClick: () => window.open(pr.htmlUrl, '_blank', 'noopener,noreferrer') },
      });
      onOpenChange(false);
    } catch {
      /* toast via mutation defaults */
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Pull Request erstellen</DialogTitle>
            <DialogDescription>
              <span className="font-mono">{head}</span> → <span className="font-mono">{base || '…'}</span>
            </DialogDescription>
          </DialogHeader>
          <Field label="Titel" htmlFor="pr-title">
            <Input id="pr-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </Field>
          <Field label="Beschreibung" htmlFor="pr-body">
            <Textarea id="pr-body" rows={6} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Was ändert sich und warum?" />
          </Field>
          <Field label="Ziel-Branch (base)" htmlFor="pr-base">
            <Input id="pr-base" className="font-mono text-[13px]" value={base} onChange={(e) => setBase(e.target.value)} />
          </Field>
          <div className="grid gap-2 text-sm">
            <label className="flex items-center gap-2">
              <Checkbox checked={pushFirst} onChange={(e) => setPushFirst(e.target.checked)} /> Branch vorher pushen
            </label>
            <label className="flex items-center gap-2">
              <Checkbox checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Als Entwurf erstellen
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Abbrechen
            </Button>
            <Button type="submit" variant="brand" disabled={busy || !title.trim()}>
              {busy ? <Loader2 className="animate-spin" /> : <GitPullRequest />}
              {push.isPending ? 'Pushe …' : 'PR erstellen'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

