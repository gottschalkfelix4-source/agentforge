import { Link } from 'react-router';
import { Github, Globe, Loader2, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useGitHubOrgs, useGitHubStatus } from './api';

export interface NewRepoValue {
  name: string;
  /** null = personal account */
  org: string | null;
  private: boolean;
  description: string;
  autoInit: boolean;
}

export const emptyNewRepo: NewRepoValue = { name: '', org: null, private: true, description: '', autoInit: true };

/** GitHub repository names: letters, digits, `.`, `_`, `-`. */
export function toRepoName(s: string): string {
  return s
    .trim()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

export const isValidRepoName = (s: string) => /^[A-Za-z0-9._-]{1,100}$/.test(s) && s !== '.' && s !== '..';

/** Form fields for creating a new GitHub repository (owner, name, visibility, description, README). */
export function NewRepoFields({ value, onChange }: { value: NewRepoValue; onChange: (v: NewRepoValue) => void }) {
  const status = useGitHubStatus();
  const connected = !!status.data?.connected;
  const orgs = useGitHubOrgs(connected);
  const set = (patch: Partial<NewRepoValue>) => onChange({ ...value, ...patch });

  if (status.isPending) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!connected) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        <Github className="size-5 opacity-60" />
        GitHub ist nicht verbunden.
        <Link to="/settings/github" className="text-brand hover:underline">
          In den Einstellungen verbinden
        </Link>
      </div>
    );
  }

  const nameInvalid = value.name !== '' && !isValidRepoName(value.name);

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-2">
        <Field label="Besitzer" htmlFor="repo-owner">
          <Select
            id="repo-owner"
            value={value.org ?? ''}
            onChange={(e) => set({ org: e.target.value || null })}
          >
            <option value="">{status.data?.login ?? 'Mein Konto'}</option>
            {orgs.data?.map((o) => (
              <option key={o.login} value={o.login}>
                {o.login}
              </option>
            ))}
          </Select>
        </Field>
        <span className="pb-2 text-muted-foreground">/</span>
        <Field label="Repository-Name" htmlFor="repo-name">
          <Input
            id="repo-name"
            placeholder="mein-projekt"
            className={cn('font-mono text-[13px]', nameInvalid && 'border-destructive')}
            spellCheck={false}
            value={value.name}
            onChange={(e) => set({ name: e.target.value })}
            onBlur={() => set({ name: toRepoName(value.name) })}
          />
        </Field>
      </div>
      {nameInvalid && (
        <p className="-mt-2 text-xs text-destructive">Erlaubt sind Buchstaben, Ziffern, „.“, „_“ und „-“.</p>
      )}

      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Sichtbarkeit">
        {(
          [
            { priv: true, icon: Lock, label: 'Privat', hint: 'Nur du und Eingeladene' },
            { priv: false, icon: Globe, label: 'Öffentlich', hint: 'Für alle sichtbar' },
          ] as const
        ).map((o) => (
          <button
            key={o.label}
            type="button"
            role="radio"
            aria-checked={value.private === o.priv}
            onClick={() => set({ private: o.priv })}
            className={cn(
              'flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors',
              value.private === o.priv ? 'border-brand bg-brand/5' : 'border-border hover:bg-muted/50',
            )}
          >
            <o.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>
              <span className="block text-sm font-medium">{o.label}</span>
              <span className="block text-xs text-muted-foreground">{o.hint}</span>
            </span>
          </button>
        ))}
      </div>

      <Field label="Beschreibung (optional)" htmlFor="repo-desc">
        <Input
          id="repo-desc"
          maxLength={350}
          placeholder="Kurz, worum es geht"
          value={value.description}
          onChange={(e) => set({ description: e.target.value })}
        />
      </Field>

      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={value.autoInit} onChange={(e) => set({ autoInit: e.target.checked })} />
        Mit README initialisieren
        <span className="text-xs text-muted-foreground">(empfohlen – legt den Branch „main“ an)</span>
      </label>
    </div>
  );
}
