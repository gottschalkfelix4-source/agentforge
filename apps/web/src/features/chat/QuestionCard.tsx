import * as React from 'react';
import { toast } from 'sonner';
import { Check, Loader2, MessageCircleQuestion } from 'lucide-react';
import type { QuestionAnswers, QuestionField, QuestionResponse } from '@vibe/shared';
import { cn, errorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { QuestionItem } from './transcript';

type Values = Record<string, string | string[] | boolean>;

function initialValues(fields: QuestionField[]): Values {
  const v: Values = {};
  for (const f of fields) v[f.key] = f.kind === 'multi' ? [] : f.kind === 'boolean' ? false : '';
  return v;
}

const hasValue = (v: Values[string] | undefined) => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim() !== '' : v !== undefined);

/** Human-readable answer of one field (option labels instead of raw values). */
function describe(field: QuestionField, value: QuestionAnswers[string] | undefined): string | null {
  if (value === undefined) return null;
  const label = (v: string) => field.options?.find((o) => o.value === v)?.label ?? v;
  if (Array.isArray(value)) return value.map(label).join(', ');
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nein';
  return label(String(value));
}

/** An agent's question (e.g. Claude Code's AskUserQuestion), answerable inline in the chat. */
export const QuestionCard = React.memo(function QuestionCard({
  item,
  onAnswer,
}: {
  item: QuestionItem;
  onAnswer: (body: QuestionResponse) => Promise<unknown>;
}) {
  const [values, setValues] = React.useState<Values>(() => initialValues(item.fields));
  const [busy, setBusy] = React.useState<'accept' | 'decline' | null>(null);

  const main = item.fields.filter((f) => !f.customFor);
  const customOf = (key: string) => item.fields.find((f) => f.customFor === key);
  const set = (key: string, v: Values[string]) => setValues((prev) => ({ ...prev, [key]: v }));

  if (item.resolved) {
    const answered = item.resolved.action === 'accept';
    const lines = answered
      ? main
          .map((f) => {
            const parts = [describe(f, item.resolved!.answers?.[f.key]), ...(customOf(f.key) ? [describe(customOf(f.key)!, item.resolved!.answers?.[customOf(f.key)!.key])] : [])].filter(Boolean);
            return parts.length ? { title: f.title ?? f.description ?? '', text: parts.join(' – ') } : null;
          })
          .filter((l): l is { title: string; text: string } => !!l)
      : [];
    return (
      <div className="text-[12.5px] text-muted-foreground">
        <div className="flex items-start gap-1.5">
          <MessageCircleQuestion className="mt-0.5 size-3.5 shrink-0 text-brand" />
          <span className="min-w-0 break-words">
            {item.message}
            {!answered && <span className="ml-1.5 italic">— {item.resolved.action === 'decline' ? 'übersprungen' : 'abgebrochen'}</span>}
          </span>
        </div>
        {lines.length > 0 && (
          <ul className="mt-1 ml-5 space-y-0.5">
            {lines.map((l, i) => (
              <li key={i} className="flex gap-1.5">
                <Check className="mt-0.5 size-3 shrink-0 text-success" />
                <span className="min-w-0 break-words">
                  {l.title && main.length > 1 && <span className="text-muted-foreground/80">{l.title}: </span>}
                  <span className="text-foreground/85">{l.text}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // Every choice question needs a pick or an own answer; required plain fields need a value.
  const complete = main.every((f) => {
    const custom = customOf(f.key);
    if (f.kind === 'single' || f.kind === 'multi') return hasValue(values[f.key]) || (custom ? hasValue(values[custom.key]) : false);
    return !f.required || hasValue(values[f.key]);
  });

  const submit = async (action: 'accept' | 'decline') => {
    setBusy(action);
    try {
      const answers: QuestionAnswers = {};
      if (action === 'accept') {
        for (const [k, v] of Object.entries(values)) if (hasValue(v) || typeof v === 'boolean') answers[k] = v;
      }
      await onAnswer({ requestId: item.id, action, ...(action === 'accept' ? { answers } : {}) });
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(null);
    }
  };

  return (
    <div className="overflow-hidden rounded-xl border border-brand/50 bg-brand/[0.05] shadow-sm">
      <div className="flex items-start gap-2 px-3.5 pt-3 pb-1">
        <MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-brand" />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium tracking-wide text-brand uppercase">Frage des Agents</div>
          <div className="mt-0.5 text-[14px] font-medium break-words whitespace-pre-wrap">{item.message}</div>
        </div>
      </div>

      <div className="space-y-4 px-3.5 pt-2 pb-3">
        {main.map((f) => {
          const custom = customOf(f.key);
          return (
            <fieldset key={f.key} className="min-w-0 space-y-1.5">
              {(f.title || (main.length > 1 && f.description)) && (
                <legend className="mb-1 text-[12.5px] font-medium">
                  {f.title && <span className="mr-1.5 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{f.title}</span>}
                  {main.length > 1 && f.description}
                </legend>
              )}

              {(f.kind === 'single' || f.kind === 'multi') && (
                <div className="space-y-1" role={f.kind === 'single' ? 'radiogroup' : 'group'}>
                  {(f.options ?? []).map((o) => {
                    const cur = values[f.key];
                    const selected = Array.isArray(cur) ? cur.includes(o.value) : cur === o.value;
                    const toggle = () => {
                      if (f.kind === 'single') set(f.key, selected ? '' : o.value);
                      else set(f.key, selected ? (cur as string[]).filter((v) => v !== o.value) : [...(cur as string[]), o.value]);
                    };
                    return (
                      <div key={o.value}>
                        <button
                          type="button"
                          role={f.kind === 'single' ? 'radio' : 'checkbox'}
                          aria-checked={selected}
                          onClick={toggle}
                          className={cn(
                            'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors',
                            selected ? 'border-brand bg-brand/10' : 'border-border bg-background/40 hover:bg-muted/60',
                          )}
                        >
                          <span
                            className={cn(
                              'mt-0.5 flex size-4 shrink-0 items-center justify-center border',
                              f.kind === 'single' ? 'rounded-full' : 'rounded',
                              selected ? 'border-brand bg-brand text-brand-foreground' : 'border-muted-foreground/50',
                            )}
                          >
                            {selected && <Check className="size-3" strokeWidth={3} />}
                          </span>
                          <span className="min-w-0">
                            <span className="block text-[13px] font-medium">{o.label}</span>
                            {o.description && <span className="block text-[12px] leading-snug text-muted-foreground">{o.description}</span>}
                          </span>
                        </button>
                        {selected && o.preview && (
                          <pre className="mt-1 ml-6 max-h-48 overflow-auto rounded-md border border-border bg-terminal px-2.5 py-2 font-mono text-[11.5px] whitespace-pre-wrap">
                            {o.preview}
                          </pre>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {f.kind === 'text' && (
                <Input
                  value={String(values[f.key] ?? '')}
                  onChange={(e) => set(f.key, e.target.value)}
                  placeholder={f.description ?? 'Antwort'}
                  className="h-8 text-[13px]"
                />
              )}
              {f.kind === 'number' && (
                <Input
                  type="number"
                  value={String(values[f.key] ?? '')}
                  onChange={(e) => set(f.key, e.target.value)}
                  className="h-8 w-40 text-[13px]"
                />
              )}
              {f.kind === 'boolean' && (
                <label className="flex items-center gap-2 text-[13px]">
                  <input type="checkbox" checked={values[f.key] === true} onChange={(e) => set(f.key, e.target.checked)} />
                  {f.description ?? f.title ?? 'Ja'}
                </label>
              )}

              {custom && (
                <Input
                  value={String(values[custom.key] ?? '')}
                  onChange={(e) => set(custom.key, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && complete && !busy) void submit('accept');
                  }}
                  placeholder={f.kind === 'multi' ? 'Eigene Antwort ergänzen (optional)' : 'Eigene Antwort oder Anmerkung (optional)'}
                  className="h-8 text-[13px]"
                />
              )}
            </fieldset>
          );
        })}
      </div>

      <div className="flex items-center gap-1.5 border-t border-brand/20 bg-brand/[0.03] px-3.5 py-2">
        <Button size="sm" variant="brand" disabled={!complete || busy !== null} onClick={() => void submit('accept')}>
          {busy === 'accept' && <Loader2 className="animate-spin" />}
          Antworten
        </Button>
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void submit('decline')}>
          {busy === 'decline' && <Loader2 className="animate-spin" />}
          Überspringen
        </Button>
      </div>
    </div>
  );
});
