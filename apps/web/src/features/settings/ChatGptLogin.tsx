import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { Check, CheckCircle2, Copy, ExternalLink, Loader2, LogIn } from 'lucide-react';
import { toast } from 'sonner';
import type { ChatGptAccount, ChatGptDeviceStart } from '@vibe/shared';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export const accountLabel = (a: ChatGptAccount) => [a.email ?? 'ChatGPT-Konto', a.planType && planName(a.planType)].filter(Boolean).join(' · ');

const planName = (p: string) => p.charAt(0).toUpperCase() + p.slice(1);

/**
 * "Sign in with ChatGPT" for a subscription provider (device flow). The tokens stay on the server;
 * `onLogin` gets the handle that is sent along when the provider is saved.
 */
export function ChatGptLogin({
  account,
  onLogin,
}: {
  /** Account of the saved or just finished login. */
  account: ChatGptAccount | null;
  onLogin: (handle: string, account: ChatGptAccount) => void;
}) {
  const [flow, setFlow] = React.useState<ChatGptDeviceStart | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const onLoginRef = React.useRef(onLogin);
  onLoginRef.current = onLogin;
  const start = useMutation({
    mutationFn: api.chatgptDeviceStart,
    onSuccess: (f) => {
      setMessage(null);
      setFlow(f);
    },
    onError: (err) => setMessage(errorMessage(err)),
  });

  // Poll until done/expired; the server throttles to OpenAI's interval anyway.
  React.useEffect(() => {
    if (!flow) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await api.chatgptDevicePoll(flow.handle);
        if (cancelled) return;
        if (r.status === 'pending') {
          timer = setTimeout(tick, Math.max(flow.interval, 2) * 1000);
          return;
        }
        setFlow(null);
        if (r.status === 'done' && r.account) onLoginRef.current(flow.handle, r.account);
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
      <div className="grid gap-2 rounded-lg border border-border px-3 py-2.5">
        {account ? (
          <p className="flex items-center gap-1.5 text-sm">
            <CheckCircle2 className="size-4 shrink-0 text-success" />
            <span className="truncate">Angemeldet: {accountLabel(account)}</span>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Melde dich mit deinem ChatGPT-Konto (Plus, Pro, Business …) an. Du bekommst einen Code, den du bei OpenAI bestätigst.
          </p>
        )}
        <div>
          <Button type="button" size="sm" variant={account ? 'outline' : 'brand'} onClick={() => start.mutate()} disabled={start.isPending}>
            {start.isPending ? <Loader2 className="animate-spin" /> : <LogIn />}
            {account ? 'Neu anmelden' : 'Mit ChatGPT anmelden'}
          </Button>
        </div>
        {message && <p className="text-sm text-destructive">{message}</p>}
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
    <div className="grid justify-items-center gap-3 rounded-lg border border-border py-3 text-center">
      <p className="text-sm text-muted-foreground">Gib diesen Code bei OpenAI ein:</p>
      <div className="flex items-center gap-2">
        <span className="rounded-lg border border-border bg-background px-4 py-2 font-mono text-2xl font-semibold tracking-[0.2em] select-all">
          {flow.userCode}
        </span>
        <Button type="button" variant="ghost" size="icon" onClick={copy} aria-label="Code kopieren">
          {copied ? <Check className="text-success" /> : <Copy />}
        </Button>
      </div>
      <Button type="button" variant="brand" size="sm" onClick={() => window.open(flow.verificationUri, '_blank', 'noopener,noreferrer')}>
        <ExternalLink /> auth.openai.com öffnen
      </Button>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" /> Warte auf Bestätigung … (Code gültig für {Math.round(flow.expiresIn / 60)} Min.)
      </p>
      <Button type="button" variant="ghost" size="sm" onClick={() => setFlow(null)}>
        Abbrechen
      </Button>
    </div>
  );
}
