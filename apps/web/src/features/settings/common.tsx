import * as React from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import type { ProviderKind } from '@vibe/shared';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip } from '@/components/ui/tooltip';

export const PROVIDER_KIND_LABEL: Record<ProviderKind, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  openai_compat: 'OpenAI-kompatibel',
  anthropic_compat: 'Anthropic-kompatibel',
  ollama: 'Ollama',
  gemini: 'Google Gemini',
};

export const PROVIDER_KINDS = Object.keys(PROVIDER_KIND_LABEL) as ProviderKind[];

export function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-end justify-between gap-4">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function ListSkeleton() {
  return (
    <div className="grid gap-2">
      {[0, 1].map((i) => (
        <Skeleton key={i} className="h-14 rounded-xl" />
      ))}
    </div>
  );
}

export function EmptyList({ icon, text, action }: { icon: React.ReactNode; text: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-10 text-center text-sm text-muted-foreground">
      <div className="opacity-50">{icon}</div>
      {text}
      {action}
    </div>
  );
}

export function RowActions({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Tooltip content="Bearbeiten">
        <Button variant="ghost" size="icon-sm" onClick={onEdit}>
          <Pencil className="size-3.5" />
        </Button>
      </Tooltip>
      <Tooltip content="Löschen">
        <Button variant="ghost" size="icon-sm" className="hover:text-destructive" onClick={onDelete}>
          <Trash2 className="size-3.5" />
        </Button>
      </Tooltip>
    </div>
  );
}
