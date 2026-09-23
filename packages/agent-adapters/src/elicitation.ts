// ACP form elicitation (`elicitation/create`, mode "form") ⇄ Agentforge question events.
// Claude Code routes its AskUserQuestion tool through this; MCP servers may use it too.

import type { QuestionAnswers, QuestionField } from '@vibe/shared';

interface EnumOption {
  const?: unknown;
  title?: string;
  description?: string;
  _meta?: Record<string, unknown>;
}

interface SchemaProp {
  type?: string;
  title?: string;
  description?: string;
  enum?: unknown[];
  enumNames?: string[];
  oneOf?: EnumOption[];
  anyOf?: EnumOption[];
  items?: { enum?: unknown[]; anyOf?: EnumOption[]; oneOf?: EnumOption[] };
  _meta?: Record<string, unknown>;
}

export interface FormElicitation {
  mode?: string;
  message?: string;
  toolCallId?: string;
  requestedSchema?: { properties?: Record<string, SchemaProp>; required?: string[] };
}

export type ElicitationResponse = { action: 'accept'; content: QuestionAnswers } | { action: 'decline' } | { action: 'cancel' };

/** First `preview` string found in an option's `_meta` extensions (mockups/snippets shown on focus). */
function previewOf(meta: Record<string, unknown> | undefined): string | undefined {
  for (const v of Object.values(meta ?? {})) {
    const p = (v as { preview?: unknown } | null)?.preview;
    if (typeof p === 'string') return p;
  }
  return undefined;
}

/** A free-text field marked as the custom answer of another field (`_meta.*.isCustomAnswer`). */
function customAnswerTarget(meta: Record<string, unknown> | undefined): string | undefined {
  for (const v of Object.values(meta ?? {})) {
    const m = v as { isCustomAnswer?: unknown; questionId?: unknown } | null;
    if (m?.isCustomAnswer === true && typeof m.questionId === 'string') return m.questionId;
  }
  return undefined;
}

function toOptions(list: EnumOption[] | undefined, plain: unknown[] | undefined, names?: string[]) {
  if (list?.length) {
    return list
      .filter((o) => o.const !== undefined)
      .map((o) => ({
        value: String(o.const),
        label: o.title ?? String(o.const),
        ...(o.description ? { description: o.description } : {}),
        ...(previewOf(o._meta) ? { preview: previewOf(o._meta) } : {}),
      }));
  }
  return (plain ?? []).map((v, i) => ({ value: String(v), label: names?.[i] ?? String(v) }));
}

/** Translates a form elicitation's JSON schema into question fields. */
export function schemaToFields(req: FormElicitation): QuestionField[] {
  const props = req.requestedSchema?.properties ?? {};
  const required = new Set(req.requestedSchema?.required ?? []);
  const fields: QuestionField[] = [];
  for (const [key, p] of Object.entries(props)) {
    const base = {
      key,
      ...(p.title ? { title: p.title } : {}),
      ...(p.description ? { description: p.description } : {}),
      ...(required.has(key) ? { required: true } : {}),
    };
    if (p.type === 'array') {
      fields.push({ ...base, kind: 'multi', options: toOptions(p.items?.anyOf ?? p.items?.oneOf, p.items?.enum) });
    } else if (p.type === 'boolean') {
      fields.push({ ...base, kind: 'boolean' });
    } else if (p.type === 'number' || p.type === 'integer') {
      fields.push({ ...base, kind: 'number' });
    } else if (p.oneOf?.length || p.anyOf?.length || p.enum?.length) {
      fields.push({ ...base, kind: 'single', options: toOptions(p.oneOf ?? p.anyOf, p.enum, p.enumNames) });
    } else {
      const target = customAnswerTarget(p._meta);
      fields.push({ ...base, kind: 'text', ...(target ? { customFor: target } : {}) });
    }
  }
  return fields;
}

/** Drops empty answers and coerces values to the field types before they go back to the agent. */
export function answersToContent(fields: QuestionField[], answers: QuestionAnswers | undefined): QuestionAnswers {
  const out: QuestionAnswers = {};
  for (const f of fields) {
    const v = answers?.[f.key];
    if (v === undefined || v === null) continue;
    if (f.kind === 'multi') {
      const list = (Array.isArray(v) ? v : [v]).map(String).filter(Boolean);
      if (list.length) out[f.key] = list;
    } else if (f.kind === 'boolean') {
      out[f.key] = v === true || v === 'true';
    } else if (f.kind === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) out[f.key] = n;
    } else {
      const s = String(v).trim();
      if (s) out[f.key] = s;
    }
  }
  return out;
}
