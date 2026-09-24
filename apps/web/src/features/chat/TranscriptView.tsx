import * as React from 'react';
import { toast } from 'sonner';
import type { FileDiff, ImageInput, QuestionResponse, ToolKind } from '@vibe/shared';
import {
  AlertTriangle,
  ArrowDown,
  Bot,
  Brain,
  Check,
  ChevronRight,
  Circle,
  FilePen,
  FileSearch,
  FileText,
  GitCompareArrows,
  Info,
  KanbanSquare,
  Globe,
  Loader2,
  Plug,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  SquareTerminal,
  Wrench,
  X,
} from 'lucide-react';
import { cn, errorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { DiffList, DiffStat } from './DiffView';
import { diffStats } from './diff';
import { Markdown } from './Markdown';
import { formatDuration, ThoughtView, useElapsed } from './ThoughtBlock';
import type { ApprovalItem, MessageItem, NoticeItem, QuestionItem, ToolItem, TranscriptItem, TranscriptState, Turn, Usage } from './transcript';
import { QuestionCard } from './QuestionCard';
import { formatTokens } from './util';

interface Ctx {
  projectId: string;
  approve: (requestId: string, optionId: string) => Promise<unknown>;
  answer: (body: QuestionResponse) => Promise<unknown>;
}
const TranscriptCtx = React.createContext<Ctx>({ projectId: '', approve: async () => {}, answer: async () => {} });
/** Items written by sub-agents, keyed by the sub-agent's tool id (rendered inside its card). */
const ChildrenCtx = React.createContext<Map<string, TranscriptItem[]>>(new Map());

// ---- user bubble ------------------------------------------------------------------

function ImageThumbs({ images, align = 'end' }: { images: ImageInput[]; align?: 'start' | 'end' }) {
  const [big, setBig] = React.useState<string | null>(null);
  return (
    <>
      <div className={cn('flex flex-wrap gap-1.5', align === 'end' ? 'justify-end' : 'justify-start')}>
        {images.map((img, i) => {
          const src = `data:${img.mime};base64,${img.data}`;
          return (
            <button key={i} type="button" className="cursor-zoom-in" onClick={() => setBig(src)}>
              <img src={src} alt="" className="size-16 rounded-lg border border-border object-cover" />
            </button>
          );
        })}
      </div>
      <Dialog open={!!big} onOpenChange={(o) => !o && setBig(null)}>
        <DialogContent className="max-w-[min(1200px,95vw)] p-2">
          <DialogTitle className="sr-only">Bild</DialogTitle>
          {big && <img src={big} alt="" className="max-h-[85vh] w-full rounded-lg object-contain" />}
        </DialogContent>
      </Dialog>
    </>
  );
}

export function UserBubble({ text, images, pending }: { text: string; images?: ImageInput[]; pending?: boolean }) {
  return (
    <div className={cn('flex flex-col items-end gap-1.5 pl-12', pending && 'opacity-60')}>
      {images && images.length > 0 && <ImageThumbs images={images} />}
      {text && (
        <div className="max-w-full rounded-2xl rounded-br-md bg-muted px-3.5 py-2 text-[14px] leading-relaxed break-words whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}

// ---- messages -------------------------------------------------------------------------

function AssistantMessage({ item }: { item: MessageItem }) {
  const { projectId } = React.useContext(TranscriptCtx);
  if (!item.text && item.done) return null;
  return (
    <div className="min-w-0">
      <Markdown text={item.text} projectId={projectId} streaming={!item.done} />
      {!item.done && <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-foreground/60" />}
    </div>
  );
}

function ThoughtBlock({ item }: { item: MessageItem }) {
  const { projectId } = React.useContext(TranscriptCtx);
  return (
    <ThoughtView
      projectId={projectId}
      text={item.text}
      done={item.done}
      durationMs={item.durationMs}
      startedAt={item.startedAt}
      endedAt={item.endedAt}
    />
  );
}

/** Agents that model thinking as a "think" tool call get the same thought block instead of a tool card. */
function ThinkTool({ item }: { item: ToolItem }) {
  const { projectId } = React.useContext(TranscriptCtx);
  const done = item.status === 'completed' || item.status === 'failed';
  const text = item.output.trim() ? item.output : item.title;
  return <ThoughtView projectId={projectId} text={text} done={done} title={item.output.trim() ? item.title : undefined} />;
}

// ---- tools ------------------------------------------------------------------------------

/** Friendly labels for the Agentforge board tools (agents prefix them differently: mcp__agentforge__x, agentforge_x, …). */
const BOARD_TOOL_LABELS: Record<string, string> = {
  project_overview: 'Board-Überblick gelesen',
  current_task: 'Aktuelle Aufgabe gelesen',
  tasks_list: 'Aufgaben gelesen',
  task_get: 'Aufgabe gelesen',
  task_create: 'Aufgabe angelegt',
  task_update: 'Aufgabe bearbeitet',
  task_set_status: 'Aufgaben-Status geändert',
  subtasks_add: 'Unteraufgaben angelegt',
  subtask_update: 'Unteraufgabe aktualisiert',
  milestones_list: 'Roadmap gelesen',
  milestone_create: 'Meilenstein angelegt',
  milestone_update: 'Meilenstein bearbeitet',
  notes_list: 'Notizen gelesen',
  note_get: 'Notiz gelesen',
  note_create: 'Notiz angelegt',
  note_update: 'Notiz bearbeitet',
};

function boardToolLabel(title: string): string | null {
  const m = /agentforge(?:__|[_.:/s-])+([a-z_]+)/i.exec(title);
  return m ? (BOARD_TOOL_LABELS[m[1]!.toLowerCase()] ?? null) : null;
}

const TOOL_ICONS: Record<ToolKind, React.ComponentType<{ className?: string }>> = {
  exec: SquareTerminal,
  edit: FilePen,
  read: FileText,
  search: FileSearch,
  fetch: Globe,
  mcp: Plug,
  think: Brain,
  agent: Bot,
  other: Wrench,
};

function ToolStatusIcon({ status }: { status: ToolItem['status'] }) {
  if (status === 'completed') return <Check className="size-3.5 text-success" />;
  if (status === 'failed') return <X className="size-3.5 text-destructive" />;
  if (status === 'pending') return <Circle className="size-3 text-muted-foreground" />;
  return <Loader2 className="size-3.5 animate-spin text-brand" />;
}

function lastLines(s: string, n: number): string {
  const lines = s.replace(/\n$/, '').split('\n');
  return lines.length <= n ? lines.join('\n') : lines.slice(-n).join('\n');
}

function commandOf(item: ToolItem): string | null {
  const input = item.input as Record<string, unknown> | undefined;
  if (input && typeof input === 'object') {
    const c = input.command ?? input.cmd;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(String).join(' ');
  }
  return null;
}

function ExecOutput({ item }: { item: ToolItem }) {
  const running = item.status === 'running' || item.status === 'pending';
  const [open, setOpen] = React.useState<boolean | null>(null);
  const expanded = open ?? false;
  const out = item.output;
  if (!out) return null;
  const preview = running && !expanded ? lastLines(out, 8) : out;
  return (
    <div className="border-t border-border/70">
      {(expanded || running) && (
        <pre className="max-h-80 overflow-auto bg-terminal px-3 py-2 font-mono text-[11.5px] leading-[1.5] whitespace-pre-wrap text-foreground/85">
          {item.outputTruncated && expanded && <span className="text-muted-foreground">{'… (gekürzt)\n'}</span>}
          {preview}
        </pre>
      )}
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        className="flex w-full cursor-pointer items-center gap-1 px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-accent/60 hover:text-foreground"
      >
        <ChevronRight className={cn('size-3 transition-transform', expanded && 'rotate-90')} />
        {expanded ? 'Ausgabe einklappen' : `Ausgabe anzeigen (${out.split('\n').length} Zeilen)`}
      </button>
    </div>
  );
}

const ToolCard = React.memo(function ToolCard({ item }: { item: ToolItem }) {
  const board = boardToolLabel(item.title);
  const Icon = board ? KanbanSquare : (TOOL_ICONS[item.toolKind] ?? Wrench);
  const [open, setOpen] = React.useState(false);
  const cmd = item.toolKind === 'exec' ? commandOf(item) : null;
  const location = item.locations?.[0];
  const oneLiner = item.toolKind !== 'exec' && item.toolKind !== 'edit' && !(item.diffs && item.diffs.length);
  const stats = React.useMemo(() => {
    if (!item.diffs?.length) return null;
    return item.diffs.reduce(
      (acc, d) => {
        const s = diffStats(d);
        return { add: acc.add + s.add, del: acc.del + s.del };
      },
      { add: 0, del: 0 },
    );
  }, [item.diffs]);

  if (oneLiner) {
    return (
      <div className="text-[13px]">
        <button
          type="button"
          disabled={!item.output}
          onClick={() => setOpen((o) => !o)}
          className="group flex max-w-full cursor-pointer items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-default"
        >
          <Icon className="size-3.5 shrink-0" />
          <span className="truncate">{board ?? item.title}</span>
          {location && location !== item.title && (
            <span className="truncate font-mono text-[11.5px] text-muted-foreground/70">{location}</span>
          )}
          <ToolStatusIcon status={item.status} />
          {item.output && <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />}
        </button>
        {open && item.output && (
          <pre className="mt-1 max-h-64 overflow-auto rounded-lg border border-border bg-terminal px-3 py-2 font-mono text-[11.5px] leading-[1.5] whitespace-pre-wrap text-foreground/85">
            {item.output}
          </pre>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border bg-panel',
        item.status === 'failed' ? 'border-destructive/40' : 'border-border',
      )}
    >
      <div className="flex min-h-8 items-center gap-2 px-2.5 py-1 text-[13px]">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        {item.toolKind === 'exec' ? (
          <code className="min-w-0 flex-1 truncate font-mono text-[12px]" title={cmd ?? item.title}>
            <span className="text-muted-foreground select-none">$ </span>
            {cmd ?? item.title}
          </code>
        ) : (
          <span className="min-w-0 flex-1 truncate" title={item.title}>
            {item.title}
          </span>
        )}
        {stats && <DiffStat {...stats} />}
        <ToolStatusIcon status={item.status} />
      </div>
      {item.toolKind === 'exec' && <ExecOutput item={item} />}
      {item.diffs && item.diffs.length > 0 && (
        <div className="border-t border-border/70 p-1.5">
          <DiffList diffs={item.diffs} />
        </div>
      )}
      {item.toolKind === 'edit' && !item.diffs?.length && item.output && (
        <pre className="max-h-48 overflow-auto border-t border-border/70 bg-terminal px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap text-muted-foreground">
          {item.output}
        </pre>
      )}
    </div>
  );
});

// ---- sub-agents ------------------------------------------------------------------------

function agentInput(item: ToolItem): { prompt?: string; type?: string; model?: string } {
  const input = item.input as Record<string, unknown> | undefined;
  if (!input || typeof input !== 'object') return {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
  return { prompt: str(input.prompt), type: str(input.subagent_type ?? input.subagentType ?? input.agent), model: str(input.model) };
}

/** Latest activity of a sub-agent, for the collapsed card header. */
function activityLabel(it: TranscriptItem | undefined): string | null {
  if (!it) return null;
  if (it.kind === 'tool') return boardToolLabel(it.title) ?? (it.toolKind === 'exec' ? `$ ${commandOf(it) ?? it.title}` : it.title);
  if (it.kind === 'message') {
    const line = it.text.trim().split('\n').pop()?.trim();
    return line ? (it.role === 'thought' ? `Denkt nach: ${line}` : line) : null;
  }
  return null;
}

/**
 * Sub-agent (Claude Code Task/Agent tool, Codex spawned agent): its own steps, text and final report,
 * grouped in one card. Collapsed it shows type, task, step count, duration and the latest activity.
 */
const SubagentCard = React.memo(function SubagentCard({ item }: { item: ToolItem }) {
  const { projectId } = React.useContext(TranscriptCtx);
  const children = React.useContext(ChildrenCtx).get(item.id) ?? EMPTY_ITEMS;
  const running = item.status === 'running' || item.status === 'pending';
  const [open, setOpen] = React.useState(false);
  const [promptOpen, setPromptOpen] = React.useState(false);
  const elapsed = useElapsed(running, item.startedAt);
  const { prompt, type, model } = agentInput(item);
  const steps = children.filter((c) => c.kind === 'tool').length;
  const duration = running ? elapsed : item.startedAt !== undefined && item.endedAt !== undefined ? item.endedAt - item.startedAt : undefined;
  const latest = running ? activityLabel(children[children.length - 1]) : null;
  const result = !running ? item.output.trim() : '';

  const meta: string[] = [];
  if (steps) meta.push(`${steps} ${steps === 1 ? 'Schritt' : 'Schritte'}`);
  if (duration !== undefined && duration >= 1000) meta.push(formatDuration(duration));

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border bg-panel',
        item.status === 'failed' ? 'border-destructive/40' : running ? 'border-brand/40' : 'border-border',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-start gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-accent/40"
      >
        <Bot className={cn('mt-0.5 size-3.5 shrink-0', running ? 'text-brand' : 'text-muted-foreground')} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            {type && (
              <span className="shrink-0 rounded bg-muted px-1.5 py-px font-mono text-[10.5px] text-muted-foreground">{type}</span>
            )}
            <span className="truncate font-medium" title={item.title}>
              {item.title || 'Subagent'}
            </span>
          </div>
          {(meta.length > 0 || (latest && !open)) && (
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
              {meta.length > 0 && <span className="shrink-0 tabular-nums">{meta.join(' · ')}</span>}
              {latest && !open && (
                <span className="thinking-shimmer min-w-0 truncate font-mono" title={latest}>
                  {meta.length > 0 && '· '}
                  {latest}
                </span>
              )}
            </div>
          )}
        </div>
        <span className="mt-0.5 shrink-0">
          <ToolStatusIcon status={item.status} />
        </span>
        <ChevronRight className={cn('mt-1 size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
      </button>

      {open && (
        <div className="border-t border-border/70 px-3 py-2">
          {(prompt || model) && (
            <div className="mb-2">
              <button
                type="button"
                onClick={() => setPromptOpen((o) => !o)}
                className="flex cursor-pointer items-center gap-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
              >
                <ChevronRight className={cn('size-3 transition-transform', promptOpen && 'rotate-90')} />
                Auftrag{model ? ` · ${model}` : ''}
              </button>
              {promptOpen && prompt && (
                <div className="mt-1 ml-[5px] border-l-2 border-border pl-3 text-muted-foreground">
                  <Markdown text={prompt} projectId={projectId} className="text-[12.5px] leading-relaxed" />
                </div>
              )}
            </div>
          )}
          {children.length > 0 ? (
            <div className="ml-[5px] border-l-2 border-border pl-3">
              {children.map((c, i) => (
                <div key={c.key} className={rowSpacing(children[i - 1], c)}>
                  <Row item={c} />
                </div>
              ))}
            </div>
          ) : (
            running && <div className="text-[12px] text-muted-foreground">Startet…</div>
          )}
          {result && (
            <div className="mt-2.5">
              <div className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {item.status === 'failed' ? 'Fehler' : 'Ergebnis'}
              </div>
              <div className="max-h-96 overflow-y-auto rounded-md border border-border/70 bg-background/60 px-3 py-2">
                <Markdown text={result} projectId={projectId} className="text-[13px] leading-relaxed" />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

const EMPTY_ITEMS: TranscriptItem[] = [];

/** Splits turn items into top-level rows and sub-agent children (by the sub-agent's tool id). */
function groupSubagentItems(items: TranscriptItem[]): { top: TranscriptItem[]; children: Map<string, TranscriptItem[]> } {
  const agents = new Set<string>();
  for (const it of items) if (it.kind === 'tool' && it.toolKind === 'agent') agents.add(it.id);
  const children = new Map<string, TranscriptItem[]>();
  if (agents.size === 0) return { top: items, children };
  const top: TranscriptItem[] = [];
  for (const it of items) {
    const parent = (it.kind === 'tool' || it.kind === 'message') && it.parentId && agents.has(it.parentId) ? it.parentId : null;
    if (!parent) {
      top.push(it);
      continue;
    }
    const list = children.get(parent);
    if (list) list.push(it);
    else children.set(parent, [it]);
  }
  return { top, children };
}

// ---- approvals ---------------------------------------------------------------------

const ApprovalCard = React.memo(function ApprovalCard({ item }: { item: ApprovalItem }) {
  const { approve } = React.useContext(TranscriptCtx);
  const [busy, setBusy] = React.useState<string | null>(null);

  if (item.resolvedOptionId) {
    const opt = item.options.find((o) => o.id === item.resolvedOptionId);
    const rejected = opt?.kind.startsWith('reject');
    return (
      <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        {rejected ? <ShieldX className="size-3.5 text-destructive" /> : <ShieldCheck className="size-3.5 text-success" />}
        <span className="truncate">
          {item.title} — <span className="text-foreground/80">{opt?.label ?? item.resolvedOptionId}</span>
        </span>
      </div>
    );
  }

  const click = async (optionId: string) => {
    setBusy(optionId);
    try {
      await approve(item.id, optionId);
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(null);
    }
  };

  return (
    <div className="overflow-hidden rounded-xl border border-warning/50 bg-warning/[0.06] shadow-sm">
      <div className="flex items-start gap-2 px-3 pt-2.5 pb-2">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium tracking-wide text-warning uppercase">
            {item.approvalKind === 'exec' ? 'Befehl ausführen?' : item.approvalKind === 'edit' ? 'Änderung übernehmen?' : 'Freigabe erforderlich'}
          </div>
          <div className="mt-0.5 text-[13.5px] font-medium break-words">{item.title}</div>
        </div>
      </div>
      {item.detail && (
        <pre className="mx-3 mb-2 max-h-56 overflow-auto rounded-lg border border-border bg-terminal px-3 py-2 font-mono text-[12px] whitespace-pre-wrap">
          {item.detail}
        </pre>
      )}
      {item.diffs && item.diffs.length > 0 && (
        <div className="mx-3 mb-2">
          <DiffList diffs={item.diffs} defaultOpen />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-warning/25 bg-warning/[0.04] px-3 py-2">
        {item.options.map((o) => (
          <Button
            key={o.id}
            size="sm"
            variant={o.kind === 'allow_once' ? 'brand' : o.kind === 'allow_always' ? 'secondary' : 'outline'}
            className={cn(o.kind.startsWith('reject') && 'text-destructive hover:text-destructive')}
            disabled={busy !== null}
            onClick={() => void click(o.id)}
          >
            {busy === o.id && <Loader2 className="animate-spin" />}
            {o.label}
          </Button>
        ))}
      </div>
    </div>
  );
});

// ---- plan, usage, turn diff -------------------------------------------------------------

function TurnDiffSummary({ files }: { files: FileDiff[] }) {
  const [open, setOpen] = React.useState(false);
  const stats = React.useMemo(
    () =>
      files.reduce(
        (acc, d) => {
          const s = diffStats(d);
          return { add: acc.add + s.add, del: acc.del + s.del };
        },
        { add: 0, del: 0 },
      ),
    [files],
  );
  if (files.length === 0) return null;
  return (
    <div className="rounded-xl border border-border bg-panel">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-[12.5px]">
        <GitCompareArrows className="size-3.5 text-muted-foreground" />
        <span className="font-medium">
          Änderungen dieses Turns ({files.length} {files.length === 1 ? 'Datei' : 'Dateien'})
        </span>
        <DiffStat {...stats} />
        <ChevronRight className={cn('ml-auto size-3.5 text-muted-foreground transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="border-t border-border p-1.5">
          <DiffList diffs={files} defaultOpen={false} />
        </div>
      )}
    </div>
  );
}

export function UsageLine({ usage, className }: { usage: Usage; className?: string }) {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`${formatTokens(usage.inputTokens)} ein`);
  if (usage.outputTokens !== undefined) parts.push(`${formatTokens(usage.outputTokens)} aus`);
  if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(usage.costUsd < 1 ? 3 : 2)}`);
  if (usage.contextPercent !== undefined) parts.push(`Kontext ${Math.round(usage.contextPercent)} %`);
  if (!parts.length) return null;
  return <div className={cn('font-mono text-[10.5px] text-muted-foreground/70 tabular-nums', className)}>{parts.join(' · ')}</div>;
}

/** Runtime notice of the agent (e.g. Claude Code warnings) — visually separate from the answer. */
function NoticeRow({ item }: { item: NoticeItem }) {
  const { projectId } = React.useContext(TranscriptCtx);
  const warn = item.severity !== 'info';
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px]',
        warn ? 'border-warning/35 bg-warning/[0.06] text-foreground/85' : 'border-border bg-muted/40 text-muted-foreground',
      )}
    >
      {warn ? <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" /> : <Info className="mt-0.5 size-3.5 shrink-0" />}
      <div className="min-w-0">
        <span className="font-medium">{item.title}</span>
        {item.description && <Markdown text={item.description} projectId={projectId} className="mt-0.5 text-[12.5px] leading-snug" />}
      </div>
    </div>
  );
}

function QuestionCardRow({ item }: { item: QuestionItem }) {
  const { answer } = React.useContext(TranscriptCtx);
  return <QuestionCard item={item} onAnswer={answer} />;
}

// ---- rows / turns -----------------------------------------------------------------------

const Row = React.memo(function Row({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case 'user':
      return <UserBubble text={item.text} images={item.images} />;
    case 'message':
      return item.role === 'thought' ? <ThoughtBlock item={item} /> : <AssistantMessage item={item} />;
    case 'tool':
      if (item.toolKind === 'agent') return <SubagentCard item={item} />;
      return item.toolKind === 'think' ? <ThinkTool item={item} /> : <ToolCard item={item} />;
    case 'approval':
      return <ApprovalCard item={item} />;
    case 'question':
      return <QuestionCardRow item={item} />;
    case 'notice':
      return <NoticeRow item={item} />;
    case 'error':
      return (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span className="break-words whitespace-pre-wrap">{item.message}</span>
        </div>
      );
  }
});

function rowSpacing(prev: TranscriptItem | undefined, cur: TranscriptItem): string {
  if (!prev) return '';
  const compact = (i: TranscriptItem) => (i.kind === 'tool' && i.toolKind !== 'exec' && i.toolKind !== 'edit' && !i.diffs?.length) || (i.kind === 'message' && i.role === 'thought') || (i.kind === 'approval' && !!i.resolvedOptionId);
  return compact(prev) && compact(cur) ? 'mt-1.5' : 'mt-3.5';
}

const TurnView = React.memo(function TurnView({ turn, isLast }: { turn: Turn; isLast: boolean }) {
  const running = isLast && !turn.done;
  const { top, children } = React.useMemo(() => groupSubagentItems(turn.items), [turn.items]);
  return (
    <ChildrenCtx.Provider value={children}>
      <section className="relative">
        {top.map((it, i) => (
          <div
            key={it.key}
            className={rowSpacing(top[i - 1], it)}
            style={!isLast ? { contentVisibility: 'auto', containIntrinsicSize: 'auto 48px' } : undefined}
          >
            <Row item={it} />
          </div>
        ))}
        {turn.diff && turn.diff.length > 0 && (
          <div className="mt-3.5">
            <TurnDiffSummary files={turn.diff} />
          </div>
        )}
        {!running && turn.usage && <UsageLine usage={turn.usage} className="mt-2" />}
      </section>
    </ChildrenCtx.Provider>
  );
});

// ---- transcript with stick-to-bottom scrolling ----------------------------------------------

const PAGE_TURNS = 30;

export function TranscriptView({
  state,
  projectId,
  approve,
  answer,
  footer,
  sessionKey,
}: {
  state: TranscriptState;
  projectId: string;
  approve: Ctx['approve'];
  answer: Ctx['answer'];
  /** Rendered after the last turn (optimistic prompt, working indicator). */
  footer?: React.ReactNode;
  /** Changing it resets scroll to the bottom. */
  sessionKey: string;
}) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const stick = React.useRef(true);
  const [atBottom, setAtBottom] = React.useState(true);
  const [limit, setLimit] = React.useState(PAGE_TURNS);
  const ctx = React.useMemo(() => ({ projectId, approve, answer }), [projectId, approve, answer]);

  React.useLayoutEffect(() => {
    stick.current = true;
    setAtBottom(true);
    setLimit(PAGE_TURNS);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sessionKey]);

  // keep pinned to the bottom: synchronously after each transcript update …
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state.turns, footer]);

  // … and whenever content grows asynchronously (highlighting, images, expanding cards)
  React.useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  const lastTop = React.useRef(0);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    const movedUp = el.scrollTop < lastTop.current - 1;
    lastTop.current = el.scrollTop;
    // Programmatic pinning only ever scrolls down, and its scroll event may arrive after more content was
    // appended — so only an upward move (user) releases the pin.
    if (bottom) stick.current = true;
    else if (movedUp) stick.current = false;
    const shown = stick.current || bottom;
    if (shown !== atBottom) setAtBottom(shown);
  };

  const onWheel = (e: React.WheelEvent) => {
    // scrolling up immediately releases the pin (even while content grows)
    if (e.deltaY < 0) stick.current = false;
  };

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const turns = state.turns;
  const start = Math.max(0, turns.length - limit);
  const visible = start > 0 ? turns.slice(start) : turns;
  const pendingApproval = React.useMemo(() => {
    const last = turns[turns.length - 1];
    return !!last?.items.some((i) => (i.kind === 'approval' && !i.resolvedOptionId) || (i.kind === 'question' && !i.resolved));
  }, [turns]);

  return (
    <TranscriptCtx.Provider value={ctx}>
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} onWheel={onWheel} className="absolute inset-0 overflow-y-auto [overflow-anchor:none]">
          <div ref={contentRef} className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-5 pt-5 pb-6">
            {start > 0 && (
              <button
                type="button"
                className="mx-auto cursor-pointer rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => setLimit((l) => l + PAGE_TURNS)}
              >
                Ältere Nachrichten laden ({start})
              </button>
            )}
            {visible.map((t, i) => (
              <TurnView key={t.key} turn={t} isLast={start + i === turns.length - 1} />
            ))}
            {footer}
          </div>
        </div>
        {!atBottom && (
          <button
            type="button"
            onClick={scrollToBottom}
            className={cn(
              'absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs shadow-lg backdrop-blur transition-colors',
              pendingApproval
                ? 'border-warning/60 bg-warning/20 text-foreground hover:bg-warning/30'
                : 'border-border bg-popover/90 text-muted-foreground hover:text-foreground',
            )}
          >
            <ArrowDown className="size-3.5" />
            {pendingApproval ? 'Eingabe erforderlich' : 'Nach unten'}
          </button>
        )}
      </div>
    </TranscriptCtx.Provider>
  );
}
