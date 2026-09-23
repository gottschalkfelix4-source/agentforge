import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Copy, ExternalLink, Github, KeyRound, Loader2, LogOut, ShieldCheck } from 'lucide-react';
import type { GitHubDeviceStart } from '@vibe/shared';
import { errorMessage } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { SectionHeader } from '@/features/settings/common';
import { ghKeys, githubApi, useGitHubStatus } from './api';

// Phase 3 – GitHub connection (device flow / PAT)
export function GitHubSettings() {
  const status = useGitHubStatus();

  return (
    <div className="grid gap-8 py-2">
      <section>
        <SectionHeader
          title="GitHub-Konto"
          description="Wird für Klonen, Push/Pull, Pull Requests und Issues in allen Workspaces verwendet. Der Token wird verschlüsselt gespeichert und nur im Speicher der Workspaces gehalten."
        />
        {status.isPending ? (
          <Skeleton className="h-24 rounded-xl" />
        ) : status.isError ? (
          <p className="text-sm text-destructive">{errorMessage(status.error)}</p>
        ) : status.data.connected ? (
          <ConnectedCard login={status.data.login!} avatarUrl={status.data.avatarUrl} scopes={status.data.scopes} />
        ) : (
          <ConnectCard deviceFlowAvailable={status.data.deviceFlowAvailable} />
        )}
      </section>
      <ClientIdSection />
    </div>
  );
}

function ConnectedCard({ login, avatarUrl, scopes }: { login: string; avatarUrl: string | null; scopes: string[] }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = React.useState(false);
  return (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-panel p-4">
      {avatarUrl ? (
        <img src={avatarUrl} alt="" className="size-12 rounded-full border border-border" />
      ) : (
        <div className="flex size-12 items-center justify-center rounded-full bg-muted">
          <Github className="size-6" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{login}</span>
          <Badge variant="success">
            <ShieldCheck className="size-3" /> Verbunden
          </Badge>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {scopes.length ? (
            scopes.map((s) => (
              <Badge key={s} variant="outline" className="font-mono text-[11px]">
                {s}
              </Badge>
            ))
          ) : (
            <span className="text-xs text-muted-foreground">Fine-grained Token (Berechtigungen laut Token-Konfiguration)</span>
          )}
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={() => setConfirm(true)}>
        <LogOut /> Trennen
      </Button>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="GitHub trennen?"
        description="Der gespeicherte Token wird gelöscht und aus allen laufenden Workspaces entfernt. Auf GitHub kannst du die Autorisierung zusätzlich unter Settings → Applications widerrufen."
        confirmLabel="Trennen"
        onConfirm={async () => {
          await githubApi.disconnect();
          await qc.invalidateQueries({ queryKey: ['github'] });
          toast.success('GitHub getrennt');
        }}
      />
    </div>
  );
}

function ConnectCard({ deviceFlowAvailable }: { deviceFlowAvailable: boolean }) {
  const qc = useQueryClient();
  const [token, setToken] = React.useState('');
  const onConnected = async (login?: string) => {
    await qc.invalidateQueries({ queryKey: ['github'] });
    toast.success(login ? `Mit GitHub verbunden als ${login}` : 'Mit GitHub verbunden');
  };
  const saveToken = useMutation({
    mutationFn: () => githubApi.setToken(token.trim()),
    onSuccess: async (s) => {
      setToken('');
      await onConnected(s.login ?? undefined);
    },
  });

  return (
    <div className="grid gap-4 rounded-xl border border-border bg-panel p-4">
      {deviceFlowAvailable ? (
        <DeviceFlowBox onDone={onConnected} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Für die Anmeldung per Browser (Device Flow) wird eine OAuth-App-Client-ID benötigt – siehe unten. Alternativ
          kannst du einen Personal Access Token verwenden.
        </p>
      )}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <div className="h-px flex-1 bg-border" /> oder mit Personal Access Token <div className="h-px flex-1 bg-border" />
      </div>
      <form
        className="grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (token.trim()) saveToken.mutate();
        }}
      >
        <Field
          label="Personal Access Token"
          htmlFor="gh-pat"
          hint={
            <>
              Classic Token mit den Scopes <code>repo</code>, <code>workflow</code>, <code>read:org</code> – oder ein
              Fine-grained Token mit Zugriff auf Contents, Pull requests, Issues und Checks.{' '}
              <a
                className="text-brand hover:underline"
                href="https://github.com/settings/tokens/new?scopes=repo,workflow,read:org&description=Agentforge"
                target="_blank"
                rel="noreferrer"
              >
                Token erstellen
              </a>
            </>
          }
        >
          <div className="flex gap-2">
            <Input
              id="gh-pat"
              type="password"
              autoComplete="off"
              placeholder="ghp_… / github_pat_…"
              className="font-mono text-[13px]"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <Button type="submit" disabled={!token.trim() || saveToken.isPending}>
              {saveToken.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />}
              Speichern
            </Button>
          </div>
        </Field>
      </form>
    </div>
  );
}

function DeviceFlowBox({ onDone }: { onDone: (login?: string) => void | Promise<void> }) {
  const [flow, setFlow] = React.useState<GitHubDeviceStart | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const onDoneRef = React.useRef(onDone);
  onDoneRef.current = onDone;
  const start = useMutation({
    mutationFn: githubApi.deviceStart,
    onSuccess: (f) => {
      setMessage(null);
      setFlow(f);
    },
  });

  // Poll until done/expired; the server throttles to GitHub's interval anyway.
  React.useEffect(() => {
    if (!flow) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await githubApi.devicePoll(flow.handle);
        if (cancelled) return;
        if (r.status === 'pending') {
          timer = setTimeout(tick, Math.max(flow.interval, 2) * 1000);
          return;
        }
        setFlow(null);
        if (r.status === 'done') await onDoneRef.current(r.login);
        else setMessage(r.message ?? 'Anmeldung fehlgeschlagen');
      } catch (err) {
        if (cancelled) return;
        setFlow(null);
        setMessage(errorMessage(err));
      }
    };
    timer = setTimeout(tick, Math.max(flow.interval, 2) * 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [flow]);

  if (!flow) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="brand" onClick={() => start.mutate()} disabled={start.isPending}>
          {start.isPending ? <Loader2 className="animate-spin" /> : <Github />}
          Mit GitHub anmelden
        </Button>
        <span className="text-xs text-muted-foreground">Du bekommst einen Code, den du auf github.com bestätigst.</span>
        {message && <p className="w-full text-sm text-destructive">{message}</p>}
      </div>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(flow.userCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Kopieren nicht möglich');
    }
  };

  return (
    <div className="grid justify-items-center gap-3 py-2 text-center">
      <p className="text-sm text-muted-foreground">Gib diesen Code auf GitHub ein:</p>
      <div className="flex items-center gap-2">
        <span className="rounded-lg border border-border bg-background px-4 py-2 font-mono text-3xl font-semibold tracking-[0.2em] select-all">
          {flow.userCode}
        </span>
        <Button variant="ghost" size="icon" onClick={copy} aria-label="Code kopieren">
          {copied ? <Check className="text-success" /> : <Copy />}
        </Button>
      </div>
      <Button variant="brand" onClick={() => window.open(flow.verificationUri, '_blank', 'noopener,noreferrer')}>
        <ExternalLink /> github.com/login/device öffnen
      </Button>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" /> Warte auf Bestätigung … (Code gültig für {Math.round(flow.expiresIn / 60)} Min.)
      </p>
      <Button variant="ghost" size="sm" onClick={() => setFlow(null)}>
        Abbrechen
      </Button>
    </div>
  );
}

function ClientIdSection() {
  const qc = useQueryClient();
  const client = useQuery({ queryKey: ghKeys.client, queryFn: githubApi.client });
  const [value, setValue] = React.useState('');
  React.useEffect(() => {
    if (client.data) setValue(client.data.clientId ?? '');
  }, [client.data]);
  const save = useMutation({
    mutationFn: () => githubApi.setClient(value.trim() || null),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['github'] });
      toast.success('Client-ID gespeichert');
    },
  });
  const fromEnv = client.data?.fromEnv ?? false;

  return (
    <section>
      <SectionHeader
        title="OAuth-App (Device Flow)"
        description="Optional: eigene GitHub OAuth App für die Anmeldung per Code. Die Client-ID ist öffentlich, ein Client-Secret wird nicht benötigt."
      />
      <form
        className="grid gap-2 rounded-xl border border-border bg-panel p-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field
          label="Client-ID"
          htmlFor="gh-client-id"
          hint={
            fromEnv ? (
              'Über die Umgebungsvariable GITHUB_CLIENT_ID gesetzt.'
            ) : (
              <>
                GitHub → Settings → Developer settings → OAuth Apps → New OAuth App (Callback-URL beliebig, z. B. die
                Adresse dieser Instanz), dann „Enable Device Flow“ aktivieren.{' '}
                <a className="text-brand hover:underline" href="https://github.com/settings/applications/new" target="_blank" rel="noreferrer">
                  OAuth App anlegen
                </a>
              </>
            )
          }
        >
          <div className="flex gap-2">
            <Input
              id="gh-client-id"
              placeholder="Ov23li…"
              className="font-mono text-[13px]"
              value={value}
              disabled={fromEnv || client.isPending}
              onChange={(e) => setValue(e.target.value)}
            />
            <Button type="submit" variant="outline" disabled={fromEnv || save.isPending || value === (client.data?.clientId ?? '')}>
              {save.isPending && <Loader2 className="animate-spin" />}
              Speichern
            </Button>
          </div>
        </Field>
      </form>
    </section>
  );
}
