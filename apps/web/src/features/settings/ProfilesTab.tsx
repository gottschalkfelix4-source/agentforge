import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bot, Loader2, Plus } from 'lucide-react';
import type { AgentAuthMode, AgentProfile, AgentProfileInput, ApprovalPolicy } from '@vibe/shared';
import { api } from '@/lib/api';
import { qk, useAgents, useProfiles, useProviders } from '@/lib/queries';
import { cn, errorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { APPROVAL_POLICY_ITEMS } from '@/features/chat/Composer';
import { EmptyList, ListSkeleton, PROVIDER_KIND_LABEL, RowActions, SectionHeader } from './common';

export function ProfilesTab() {
  const profiles = useProfiles();
  const agents = useAgents();
  const providers = useProviders();
  const qc = useQueryClient();
  const [editing, setEditing] = React.useState<AgentProfile | 'new' | null>(null);
  const [deleting, setDeleting] = React.useState<AgentProfile | null>(null);

  const agentLabel = (id: string) => agents.data?.find((a) => a.id === id)?.label ?? id;
  const providerName = (id: string | null) => (id ? (providers.data?.find((p) => p.id === id)?.name ?? 'Unbekannter Provider') : null);

  return (
    <div>
      <SectionHeader
        title="Agent-Profile"
        description="Voreinstellungen für Agents: Anmeldung per Abo oder Provider, Modell, Argumente und Umgebungsvariablen."
        action={
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus /> Profil hinzufügen
          </Button>
        }
      />
      {profiles.isPending ? (
        <ListSkeleton />
      ) : profiles.isError ? (
        <p className="text-sm text-destructive">{errorMessage(profiles.error)}</p>
      ) : profiles.data.length === 0 ? (
        <EmptyList icon={<Bot className="size-6" />} text="Noch keine Agent-Profile angelegt." />
      ) : (
        <div className="grid gap-2">
          {profiles.data.map((p) => (
            <div key={p.id} className="flex items-center gap-3 rounded-xl border border-border bg-panel px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{p.name}</span>
                  <Badge variant="outline">{agentLabel(p.agentKind)}</Badge>
                  {agents.data && !agents.data.find((a) => a.id === p.agentKind)?.structured && (
                    <Badge variant="outline">nur Terminal</Badge>
                  )}
                  <Badge variant={p.authMode === 'subscription' ? 'brand' : 'default'}>
                    {p.authMode === 'subscription' ? 'Abo-Login' : 'Provider'}
                  </Badge>
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {[
                    providerName(p.providerId),
                    p.model,
                    p.approvalPolicy !== 'ask' && `Freigaben: ${APPROVAL_POLICY_ITEMS.find((i) => i.id === p.approvalPolicy)?.name}`,
                    p.extraArgs.length > 0 && p.extraArgs.join(' '),
                    Object.keys(p.env).length > 0 && `${Object.keys(p.env).length} Env-Variablen`,
                  ]
                    .filter(Boolean)
                    .join(' · ') || '—'}
                </div>
              </div>
              <RowActions onEdit={() => setEditing(p)} onDelete={() => setDeleting(p)} />
            </div>
          ))}
        </div>
      )}

      <ProfileDialog
        profile={editing === 'new' ? null : editing}
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Profil „${deleting?.name ?? ''}" löschen?`}
        onConfirm={async () => {
          if (!deleting) return;
          await api.deleteProfile(deleting.id);
          void qc.invalidateQueries({ queryKey: qk.profiles });
        }}
      />
    </div>
  );
}

// "KEY=VALUE" lines ⇄ record
function parseEnv(text: string): { env: Record<string, string>; error: string | null } {
  const env: Record<string, string> = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) return { env, error: `Zeile ${i + 1}: erwartet KEY=VALUE` };
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return { env, error: `Zeile ${i + 1}: ungültiger Name „${key}“` };
    env[key] = line.slice(eq + 1);
  }
  return { env, error: null };
}
const formatEnv = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

/** Split on whitespace but keep "quoted strings" together. */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}
const joinArgs = (args: string[]) => args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');

function ProfileDialog({
  profile,
  open,
  onOpenChange,
}: {
  profile: AgentProfile | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const agents = useAgents();
  const providers = useProviders();
  const [agentKind, setAgentKind] = React.useState('');
  const [name, setName] = React.useState('');
  const [authMode, setAuthMode] = React.useState<AgentAuthMode>('subscription');
  const [providerId, setProviderId] = React.useState('');
  const [model, setModel] = React.useState('');
  const [extraArgs, setExtraArgs] = React.useState('');
  const [envText, setEnvText] = React.useState('');
  const [approvalPolicy, setApprovalPolicy] = React.useState<ApprovalPolicy>('ask');
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setError(null);
    if (profile) {
      setAgentKind(profile.agentKind);
      setName(profile.name);
      setAuthMode(profile.authMode);
      setProviderId(profile.providerId ?? '');
      setModel(profile.model ?? '');
      setExtraArgs(joinArgs(profile.extraArgs));
      setEnvText(formatEnv(profile.env));
      setApprovalPolicy(profile.approvalPolicy);
    } else {
      setAgentKind(agents.data?.[0]?.id ?? '');
      setName('');
      setAuthMode('subscription');
      setProviderId('');
      setModel('');
      setExtraArgs('');
      setEnvText('');
      setApprovalPolicy('ask');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, profile]);

  // New profiles whose agent list arrived after opening. Never for an edited profile: in the render that
  // opens it agentKind is still empty, and this would overwrite the profile's agent set just before.
  React.useEffect(() => {
    if (open && !profile && !agentKind && agents.data?.[0]) setAgentKind(agents.data[0].id);
  }, [open, profile, agentKind, agents.data]);

  const manifest = agents.data?.find((a) => a.id === agentKind);
  const allowedKinds = manifest?.providerKinds ?? [];
  const compatibleProviders = (providers.data ?? []).filter((p) => allowedKinds.includes(p.kind));
  const providerSupported = allowedKinds.length > 0;
  const selectedProvider = compatibleProviders.find((p) => p.id === providerId);

  // Reset an incompatible provider selection when the agent changes.
  React.useEffect(() => {
    if (providerId && providers.data && !compatibleProviders.some((p) => p.id === providerId)) setProviderId('');
    if (!providerSupported && authMode === 'provider') setAuthMode('subscription');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentKind, providers.data]);

  const envParsed = parseEnv(envText);

  const save = useMutation({
    mutationFn: () => {
      const body: AgentProfileInput = {
        agentKind,
        name: name.trim(),
        authMode,
        providerId: authMode === 'provider' ? providerId || null : null,
        model: model.trim() || null,
        extraArgs: splitArgs(extraArgs),
        env: envParsed.env,
        approvalPolicy,
      };
      return profile ? api.updateProfile(profile.id, body) : api.createProfile(body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.profiles });
      onOpenChange(false);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const valid =
    !!agentKind && !!name.trim() && !envParsed.error && (authMode === 'subscription' || !!providerId);

  return (
    <Dialog open={open} onOpenChange={(o) => !save.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-xl">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{profile ? 'Profil bearbeiten' : 'Agent-Profil hinzufügen'}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Agent"
              htmlFor="pf-agent"
              hint={manifest ? (manifest.structured ? 'Chat und Terminal' : 'Nur Terminal (keine Chat-Sitzungen)') : undefined}
            >
              <Select id="pf-agent" value={agentKind} onChange={(e) => setAgentKind(e.target.value)}>
                {agents.data?.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                    {a.structured ? ' · Chat' : ' · nur Terminal'}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Name" htmlFor="pf-name">
              <Input id="pf-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Claude via OpenRouter" />
            </Field>
          </div>

          <div className="grid gap-1.5">
            <Label>Anmeldung</Label>
            <div className="grid grid-cols-2 gap-2">
              <AuthOption
                checked={authMode === 'subscription'}
                onSelect={() => setAuthMode('subscription')}
                title="Abo-Login"
                description="Nutzt die gespeicherte Anmeldung des Agents."
              />
              <AuthOption
                checked={authMode === 'provider'}
                onSelect={() => setAuthMode('provider')}
                disabled={!providerSupported}
                title="Provider/API-Key"
                description={providerSupported ? 'Nutzt einen hinterlegten Provider.' : 'Von diesem Agent nicht unterstützt.'}
              />
            </div>
          </div>

          {authMode === 'provider' && (
            <Field
              label="Provider"
              htmlFor="pf-provider"
              hint={
                compatibleProviders.length === 0
                  ? `Kein passender Provider. Unterstützt: ${allowedKinds.map((k) => PROVIDER_KIND_LABEL[k]).join(', ')}.`
                  : undefined
              }
            >
              <Select id="pf-provider" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
                <option value="">– Provider wählen –</option>
                {compatibleProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({PROVIDER_KIND_LABEL[p.kind]})
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field label="Modell (optional)" htmlFor="pf-model" hint={manifest && !manifest.modelFlag ? 'Dieser Agent unterstützt keine Modellauswahl per Flag.' : undefined}>
            <Input
              id="pf-model"
              list="pf-model-options"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={selectedProvider?.defaultModel ?? 'Standard des Agents'}
              className="font-mono text-[13px]"
              spellCheck={false}
            />
            <datalist id="pf-model-options">
              {selectedProvider?.models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </Field>

          {manifest?.structured && (
            <Field
              label="Freigaben (Standard)"
              htmlFor="pf-approval"
              hint="Vorauswahl für Chat-Sitzungen und Aufgaben mit diesem Profil; im Chat jederzeit änderbar."
            >
              <Select id="pf-approval" value={approvalPolicy} onChange={(e) => setApprovalPolicy(e.target.value as ApprovalPolicy)}>
                {APPROVAL_POLICY_ITEMS.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name} – {i.description}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field label="Zusätzliche Argumente" htmlFor="pf-args" hint="Durch Leerzeichen getrennt; Anführungszeichen für Werte mit Leerzeichen.">
            <Input
              id="pf-args"
              value={extraArgs}
              onChange={(e) => setExtraArgs(e.target.value)}
              placeholder="--verbose"
              className="font-mono text-[13px]"
              spellCheck={false}
            />
          </Field>

          <Field label="Umgebungsvariablen" htmlFor="pf-env" hint={envParsed.error ?? 'Eine Variable pro Zeile: KEY=VALUE'}>
            <Textarea
              id="pf-env"
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              rows={4}
              placeholder={'DEBUG=1\nMY_FLAG=true'}
              className={cn('font-mono text-[13px]', envParsed.error && 'border-destructive')}
              spellCheck={false}
            />
          </Field>

          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={save.isPending}>
              Abbrechen
            </Button>
            <Button type="submit" disabled={!valid || save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" />}
              Speichern
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AuthOption({
  checked,
  onSelect,
  title,
  description,
  disabled,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  description: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3 transition-colors hover:bg-accent/50',
        checked && 'border-brand/60 bg-brand/5',
        disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent',
      )}
    >
      <input
        type="radio"
        className="mt-0.5 accent-[var(--brand)]"
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
      />
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}
