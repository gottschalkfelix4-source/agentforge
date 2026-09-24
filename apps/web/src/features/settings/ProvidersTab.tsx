import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, KeyRound, ListRestart, Loader2, Plug, Plus, XCircle } from 'lucide-react';
import type { ChatGptAccount, Provider, ProviderInput, ProviderKind, ProviderTestResult } from '@vibe/shared';
import { api } from '@/lib/api';
import { toolsApi } from '@/features/tools/api';
import { qk, useProviders } from '@/lib/queries';
import { errorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyList, ListSkeleton, PROVIDER_KIND_LABEL, PROVIDER_KINDS, RowActions, SectionHeader } from './common';
import { accountLabel, ChatGptLogin } from './ChatGptLogin';

const OLLAMA_DEFAULT_URL = 'http://host.docker.internal:11434';
const needsBaseUrl = (k: ProviderKind) => k === 'openai_compat' || k === 'anthropic_compat';
const CHATGPT: ProviderKind = 'openai_chatgpt';

export function ProvidersTab() {
  const providers = useProviders();
  const qc = useQueryClient();
  const [editing, setEditing] = React.useState<Provider | 'new' | null>(null);
  const [deleting, setDeleting] = React.useState<Provider | null>(null);

  return (
    <div>
      <SectionHeader
        title="Provider"
        description="API-Zugänge und Abos für Agents im Modus „Provider/API-Key“. Schlüssel und Logins werden verschlüsselt gespeichert."
        action={
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus /> Provider hinzufügen
          </Button>
        }
      />
      {providers.isPending ? (
        <ListSkeleton />
      ) : providers.isError ? (
        <p className="text-sm text-destructive">{errorMessage(providers.error)}</p>
      ) : providers.data.length === 0 ? (
        <EmptyList icon={<KeyRound className="size-6" />} text="Noch keine Provider angelegt." />
      ) : (
        <div className="grid gap-2">
          {providers.data.map((p) => (
            <div key={p.id} className="flex items-center gap-3 rounded-xl border border-border bg-panel px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{p.name}</span>
                  <Badge variant="outline">{PROVIDER_KIND_LABEL[p.kind]}</Badge>
                  {p.kind === CHATGPT ? (
                    p.account ? (
                      <Badge variant="success">Angemeldet</Badge>
                    ) : (
                      <Badge variant="warning">Nicht angemeldet</Badge>
                    )
                  ) : p.hasKey ? (
                    <Badge variant="success">Key gespeichert</Badge>
                  ) : (
                    p.kind !== 'ollama' && <Badge variant="warning">Kein Key</Badge>
                  )}
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {[p.account && accountLabel(p.account), p.baseUrl, p.defaultModel && `Standard: ${p.defaultModel}`, p.models.length > 0 && `${p.models.length} Modelle`]
                    .filter(Boolean)
                    .join(' · ') || '—'}
                </div>
              </div>
              <RowActions onEdit={() => setEditing(p)} onDelete={() => setDeleting(p)} />
            </div>
          ))}
        </div>
      )}

      <ProviderDialog
        provider={editing === 'new' ? null : editing}
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Provider „${deleting?.name ?? ''}" löschen?`}
        description="Agent-Profile, die diesen Provider verwenden, funktionieren danach nicht mehr."
        onConfirm={async () => {
          if (!deleting) return;
          await api.deleteProvider(deleting.id);
          void qc.invalidateQueries({ queryKey: qk.providers });
          void qc.invalidateQueries({ queryKey: qk.profiles });
        }}
      />
    </div>
  );
}

function ProviderDialog({
  provider,
  open,
  onOpenChange,
}: {
  provider: Provider | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const [kind, setKind] = React.useState<ProviderKind>('anthropic');
  const [name, setName] = React.useState('');
  const [baseUrl, setBaseUrl] = React.useState('');
  const [apiKey, setApiKey] = React.useState('');
  const [models, setModels] = React.useState('');
  const [defaultModel, setDefaultModel] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [test, setTest] = React.useState<ProviderTestResult | null>(null);
  // ChatGPT subscription: a login finished in this dialog (saved together with the provider).
  const [login, setLogin] = React.useState<{ handle: string; account: ChatGptAccount } | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setError(null);
    setTest(null);
    setApiKey('');
    setLogin(null);
    if (provider) {
      setKind(provider.kind);
      setName(provider.name);
      setBaseUrl(provider.baseUrl ?? '');
      setModels(provider.models.join(', '));
      setDefaultModel(provider.defaultModel ?? '');
    } else {
      setKind('anthropic');
      setName('');
      setBaseUrl('');
      setModels('');
      setDefaultModel('');
    }
  }, [open, provider]);

  const onKindChange = (k: ProviderKind) => {
    setKind(k);
    if (k === 'ollama' && !baseUrl) setBaseUrl(OLLAMA_DEFAULT_URL);
    if (k !== 'ollama' && baseUrl === OLLAMA_DEFAULT_URL) setBaseUrl('');
    if (k === CHATGPT) setBaseUrl('');
    if (!name || name === PROVIDER_KIND_LABEL[kind]) setName(PROVIDER_KIND_LABEL[k]);
  };

  const save = useMutation({
    mutationFn: () => {
      const modelList = models
        .split(/[,\n]/)
        .map((m) => m.trim())
        .filter(Boolean);
      const body: ProviderInput = {
        kind,
        name: name.trim(),
        baseUrl: baseUrl.trim() || null,
        models: modelList,
        defaultModel: defaultModel.trim() || null,
      };
      // Omit apiKey to keep the stored key when editing and the field is empty.
      if (kind === CHATGPT) {
        if (login) body.chatgptLogin = login.handle;
      } else if (apiKey.trim()) body.apiKey = apiKey.trim();
      return provider ? api.updateProvider(provider.id, body) : api.createProvider(body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.providers });
      onOpenChange(false);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  // Test the dialog's current values; a saved provider falls back to its stored key.
  const runTest = useMutation({
    mutationFn: (_fill: boolean) => {
      const body =
        kind === CHATGPT
          ? { kind, ...(login ? { chatgptLogin: login.handle } : {}) }
          : { kind, baseUrl: baseUrl.trim() || null, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) };
      return provider ? toolsApi.testSavedProvider(provider.id, body) : toolsApi.testProvider(body);
    },
    onSuccess: (res, fill) => {
      setTest(res);
      if (fill && res.ok && res.models) {
        setModels(res.models.join(', '));
        if (!defaultModel.trim() && res.models[0]) setDefaultModel(res.models[0]);
      }
    },
    onError: (err) => setTest({ ok: false, error: errorMessage(err) }),
  });
  React.useEffect(() => setTest(null), [kind, baseUrl, apiKey, login]);

  const chatgpt = kind === CHATGPT;
  const account = login?.account ?? (provider?.kind === CHATGPT ? (provider.account ?? null) : null);
  const baseUrlRequired = needsBaseUrl(kind);
  const valid = name.trim() && (!baseUrlRequired || baseUrl.trim()) && (!chatgpt || !!account);
  const testable = chatgpt ? !!account : !(baseUrlRequired && !baseUrl.trim());
  const modelOptions = models
    .split(/[,\n]/)
    .map((m) => m.trim())
    .filter(Boolean);

  return (
    <Dialog open={open} onOpenChange={(o) => !save.isPending && onOpenChange(o)}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{provider ? 'Provider bearbeiten' : 'Provider hinzufügen'}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Typ" htmlFor="pv-kind">
              <Select id="pv-kind" value={kind} onChange={(e) => onKindChange(e.target.value as ProviderKind)}>
                {PROVIDER_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {PROVIDER_KIND_LABEL[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Name" htmlFor="pv-name">
              <Input id="pv-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Anthropic privat" />
            </Field>
          </div>
          {chatgpt ? (
            <Field label="Anmeldung" hint="Nutzt dein ChatGPT-Abo mit Codex, OpenCode und Kilo. Agentforge erneuert die Anmeldung selbst.">
              <ChatGptLogin account={account} onLogin={(handle, a) => setLogin({ handle, account: a })} />
            </Field>
          ) : (
            <>
              <Field
                label={baseUrlRequired ? 'Base-URL' : 'Base-URL (optional)'}
                htmlFor="pv-url"
                hint={kind === 'ollama' ? 'Aus dem Container erreichbar, z. B. über host.docker.internal.' : undefined}
              >
                <Input
                  id="pv-url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={
                    kind === 'ollama'
                      ? OLLAMA_DEFAULT_URL
                      : kind === 'openai_compat'
                        ? 'https://api.example.com/v1'
                        : kind === 'anthropic_compat'
                          ? 'https://api.example.com'
                          : kind === 'gemini'
                            ? 'https://generativelanguage.googleapis.com'
                            : 'Standard des Anbieters'
                  }
                  className="font-mono text-[13px]"
                  spellCheck={false}
                />
              </Field>
              <Field label="API-Key" htmlFor="pv-key">
                <Input
                  id="pv-key"
                  type="password"
                  autoComplete="new-password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={provider?.hasKey ? 'gespeichert – leer lassen um zu behalten' : kind === 'ollama' ? 'nicht erforderlich' : 'sk-…'}
                  className="font-mono text-[13px]"
                />
              </Field>
            </>
          )}
          <Field label="Modelle" htmlFor="pv-models" hint="Kommagetrennt.">
            <Input
              id="pv-models"
              value={models}
              onChange={(e) => setModels(e.target.value)}
              placeholder={chatgpt ? 'Über „Modelle laden“ abrufen' : 'claude-sonnet-4-5, claude-opus-4-1'}
              className="font-mono text-[13px]"
              spellCheck={false}
            />
          </Field>
          <Field label="Standardmodell" htmlFor="pv-default">
            <Input
              id="pv-default"
              list="pv-model-options"
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
              className="font-mono text-[13px]"
              spellCheck={false}
            />
            <datalist id="pv-model-options">
              {modelOptions.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </Field>
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={runTest.isPending || !testable}
                onClick={() => runTest.mutate(false)}
              >
                {runTest.isPending && !runTest.variables ? <Loader2 className="animate-spin" /> : <Plug />}
                Verbindung testen
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={runTest.isPending || !testable}
                onClick={() => runTest.mutate(true)}
              >
                {runTest.isPending && runTest.variables ? <Loader2 className="animate-spin" /> : <ListRestart />}
                Modelle laden
              </Button>
            </div>
            {test &&
              (test.ok ? (
                <p className="flex items-center gap-1.5 text-xs text-success">
                  <CheckCircle2 className="size-3.5 shrink-0" />
                  Verbindung erfolgreich · {test.models?.length ?? 0} Modelle gefunden
                </p>
              ) : (
                <p className="flex items-start gap-1.5 text-xs text-destructive">
                  <XCircle className="mt-px size-3.5 shrink-0" />
                  <span className="break-all">{test.error ?? 'Verbindung fehlgeschlagen'}</span>
                </p>
              ))}
          </div>
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
