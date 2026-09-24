import * as React from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Cpu, KeyRound, Loader2, SquareTerminal, TriangleAlert, UserCog } from 'lucide-react';
import type { ApprovalPolicy } from '@vibe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { qk, useProfiles, useProviders } from '@/lib/queries';
import { useNav, useUi } from '@/lib/store';
import { errorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { chatApi, useChatAgents, useCreateSession } from './api';
import { ApprovalPolicyPicker, Composer, PickerMenu, type ComposerApi, type ComposerImage } from './Composer';
import { AgentAvatar, usePersistentState } from './util';

const SUGGESTIONS = [
  { title: 'Projekt erklären', prompt: 'Erkläre mir die Struktur dieses Projekts und wie ich es lokal starte.' },
  { title: 'Dev-Server starten', prompt: 'Installiere die Abhängigkeiten und starte den Dev-Server. Sag mir, auf welchem Port er läuft.' },
  { title: 'Neue App anlegen', prompt: 'Lege eine neue Web-App mit Vite, React und TypeScript an und starte den Dev-Server.' },
  { title: 'Tests & Fehler', prompt: 'Führe die Tests aus und behebe alle Fehler, die dabei auftreten.' },
];

export function NewSession({ projectId }: { projectId: string }) {
  const agents = useChatAgents();
  const profiles = useProfiles();
  const providers = useProviders();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const create = useCreateSession(projectId);
  const setActive = useNav((s) => s.setActiveSession);
  const [agentPref, setAgentPref] = usePersistentState<string>('vibe-chat-agent', 'claude');
  const [profilePref, setProfilePref] = usePersistentState<Record<string, string | null>>('vibe-chat-profile', {});
  // Freigaben per agent, remembered for the next session.
  const [policyPref, setPolicyPref] = usePersistentState<Record<string, ApprovalPolicy>>('vibe-chat-approval', {});
  const [subError, setSubError] = React.useState<string | null>(null);
  const [launching, setLaunching] = React.useState(false);
  const composer = React.useRef<ComposerApi>(null);

  const agent = agents.data.find((a) => a.id === agentPref) ?? agents.data[0];
  const agentProfiles = React.useMemo(
    () => (profiles.data ?? []).filter((p) => p.agentKind === agent?.id),
    [profiles.data, agent?.id],
  );
  const storedProfile = agent ? profilePref[agent.id] : null;
  const profileId = agentProfiles.some((p) => p.id === storedProfile) ? storedProfile! : null;
  const profile = agentProfiles.find((p) => p.id === profileId);

  // Provider profiles (API key / own endpoint / Ollama) choose from the provider's models.
  const [modelPref, setModelPref] = usePersistentState<Record<string, string>>('vibe-chat-model', {});
  const provider = profile?.authMode === 'provider' ? providers.data?.find((p) => p.id === profile.providerId) : undefined;
  const providerModels = React.useMemo(
    () =>
      provider
        ? [...new Set([...provider.models, provider.defaultModel, profile?.model].filter((m): m is string => !!m))]
        : [],
    [provider, profile?.model],
  );
  const fallbackModel = profile?.model ?? provider?.defaultModel ?? providerModels[0] ?? null;
  const storedModel = profileId ? modelPref[profileId] : undefined;
  const model = storedModel && providerModels.includes(storedModel) ? storedModel : fallbackModel;

  const approvalPolicy: ApprovalPolicy = (agent && policyPref[agent.id]) || 'ask';

  const send = async (text: string, images: ComposerImage[]): Promise<boolean> => {
    if (!agent) return false;
    setSubError(null);
    try {
      const session = await create.mutateAsync({
        agentId: agent.id,
        profileId,
        model: provider ? model : undefined,
        approvalPolicy,
        // CreateSessionRequest has no images → send them with a follow-up prompt instead
        initialPrompt: images.length ? undefined : text || undefined,
      });
      setActive(projectId, session.id);
      if (images.length) {
        chatApi
          .prompt(session.id, { text, images: images.map(({ mime, data }) => ({ mime, data })) })
          .catch((err) => toast.error(`Prompt konnte nicht gesendet werden: ${errorMessage(err)}`));
      }
      return true;
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'claude_subscription_chat') {
        setSubError(err.message);
      } else {
        toast.error(errorMessage(err));
      }
      return false;
    }
  };

  const startInTerminal = async () => {
    setLaunching(true);
    try {
      await api.createTerminal(projectId, { kind: 'agent', agentId: 'claude', mode: 'run', profileId });
      void qc.invalidateQueries({ queryKey: qk.terminals(projectId) });
      useUi.getState().setTerminalVisible(true);
      useUi.getState().setProjectView('code');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLaunching(false);
    }
  };

  const agentPicker = agent ? (
    <>
      <PickerMenu
        icon={<AgentAvatar agentId={agent.id} label={agent.label} />}
        label={agent.label}
        title="Agent"
        items={agents.data.map((a) => ({ id: a.id, name: a.label, right: <AgentAvatar agentId={a.id} label={a.label} /> }))}
        value={agent.id}
        onSelect={(id) => {
          setAgentPref(id);
          setSubError(null);
        }}
      />
      <PickerMenu
        icon={<UserCog className="size-3.5" />}
        label={profile?.name ?? 'Standard'}
        title="Profil"
        items={[
          { id: '__default', name: 'Standard', description: 'Anmeldung/Einstellungen des Agents' },
          ...agentProfiles.map((p) => ({
            id: p.id,
            name: p.name,
            description: p.authMode === 'subscription' ? 'Abo' : (p.model ?? 'API-Provider'),
          })),
        ]}
        value={profileId ?? '__default'}
        onSelect={(id) => {
          setProfilePref({ ...profilePref, [agent.id]: id === '__default' ? null : id });
          setSubError(null);
        }}
      />
      <ApprovalPolicyPicker value={approvalPolicy} onSelect={(p) => setPolicyPref({ ...policyPref, [agent.id]: p })} />
      {provider && (
        <PickerMenu
          icon={<Cpu className="size-3.5" />}
          label={model ?? 'Modell'}
          title={`Modell (${provider.name})`}
          items={
            providerModels.length
              ? providerModels.map((m) => ({ id: m, name: m }))
              : [{ id: '__none', name: 'Keine Modelle hinterlegt', description: 'Einstellungen → Provider → „Modelle laden“' }]
          }
          value={model}
          onSelect={(id) => {
            if (id === '__none') return navigate('/settings/providers');
            if (profileId) setModelPref({ ...modelPref, [profileId]: id });
          }}
        />
      )}
    </>
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-5 py-10">
        <h1 className="mb-6 text-center text-2xl font-semibold tracking-tight">Was soll gebaut werden?</h1>

        {agents.isPending ? (
          <div className="flex justify-center py-6 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : agents.data.length === 0 ? (
          <div className="rounded-xl border border-border p-4 text-center text-sm text-muted-foreground">
            Kein Agent mit Chat-Schnittstelle verfügbar.
          </div>
        ) : (
          <Composer
            apiRef={composer}
            draftKey={`new:${projectId}`}
            placeholder={`${agent?.label ?? 'Agent'} eine Aufgabe geben… (Enter senden, Shift+Enter neue Zeile)`}
            onSend={send}
            leftSlot={agentPicker}
            large
            autoFocus
            canSend={!create.isPending}
          />
        )}

        {subError && (
          <div className="mt-3 rounded-xl border border-warning/50 bg-warning/[0.07] p-3.5">
            <div className="flex items-start gap-2.5">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
              <div className="min-w-0 flex-1 text-[13px] leading-relaxed">{subError}</div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 pl-6.5">
              <Button size="sm" variant="brand" onClick={() => void startInTerminal()} disabled={launching}>
                {launching ? <Loader2 className="animate-spin" /> : <SquareTerminal />}
                Im Terminal starten
              </Button>
              <Button size="sm" variant="outline" onClick={() => navigate('/settings/profiles')}>
                <KeyRound />
                Profil anlegen
              </Button>
            </div>
          </div>
        )}

        <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.title}
              type="button"
              onClick={() => composer.current?.setText(s.prompt)}
              className="cursor-pointer rounded-xl border border-border px-3.5 py-2.5 text-left transition-colors hover:bg-accent/60"
            >
              <div className="text-[13px] font-medium">{s.title}</div>
              <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{s.prompt}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
