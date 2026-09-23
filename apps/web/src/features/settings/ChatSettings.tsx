import { AlertTriangle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useChatSettings, useSetChatSettings } from '@/features/tools/api';
import { errorMessage } from '@/lib/utils';
import { Checkbox } from '@/components/ui/checkbox';
import { SectionHeader } from './common';

/** Chat policy: Claude Code with a Pro/Max subscription in chat sessions (rendered inside the Agents tab). */
export function ChatSettings() {
  const settings = useChatSettings();
  const save = useSetChatSettings();
  const checked = settings.data?.allowClaudeSubscriptionChat ?? false;

  return (
    <div>
      <SectionHeader title="Chat" description="Richtlinien für Chat-Sitzungen mit strukturierten Agents." />
      <div className="rounded-xl border border-border bg-panel p-4">
        <label className="flex cursor-pointer items-start gap-3">
          <Checkbox
            className="mt-0.5"
            checked={checked}
            disabled={settings.isPending || save.isPending}
            onChange={(e) =>
              save.mutate(
                { allowClaudeSubscriptionChat: e.target.checked },
                {
                  onSuccess: (s) => toast.success(s.allowClaudeSubscriptionChat ? 'Claude-Abo im Chat erlaubt' : 'Claude-Abo im Chat gesperrt'),
                  onError: (err) => toast.error(errorMessage(err)),
                },
              )
            }
          />
          <span className="min-w-0">
            <span className="flex items-center gap-2 text-sm font-medium">
              Claude-Abo (Pro/Max) in Chat-Sitzungen erlauben
              {save.isPending && <Loader2 className="size-3.5 animate-spin" />}
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">
              Standardmäßig können Chat-Sitzungen mit Claude Code nur über ein Profil mit API-Schlüssel (Provider) gestartet
              werden. Im Terminal funktioniert das Abo-Login immer.
            </span>
          </span>
        </label>
        <div className="mt-3 flex gap-2.5 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>
            Anthropic untersagt in seinen Nutzungsbedingungen, ein Claude-Abo (Pro/Max) über Drittanbieter-Apps zu nutzen –
            dazu zählt auch dieser Chat, der Claude Code über das Agent Client Protocol steuert. Aktivierst du die Option,
            geschieht das auf eigene Verantwortung; im schlimmsten Fall kann Anthropic dein Konto einschränken oder sperren.
            Regelkonform ist die Nutzung von Claude Code im Terminal oder ein Profil mit API-Schlüssel.
          </p>
        </div>
        {settings.isError && <p className="mt-2 text-xs text-destructive">{errorMessage(settings.error)}</p>}
      </div>
    </div>
  );
}
