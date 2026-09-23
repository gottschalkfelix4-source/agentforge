import * as React from 'react';
import { Navigate, useLocation } from 'react-router';
import { Loader2, RefreshCw } from 'lucide-react';
import { useMe } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/utils';

function Splash({ error, onRetry }: { error?: unknown; onRetry?: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
      {error ? (
        <>
          <p className="text-sm">Server nicht erreichbar: {errorMessage(error)}</p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw /> Erneut versuchen
          </Button>
        </>
      ) : (
        <Loader2 className="size-5 animate-spin" />
      )}
    </div>
  );
}

/** Protects the app: redirects to /setup or /login as needed. */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <Splash />;
  if (me.isError) return <Splash error={me.error} onRetry={() => void me.refetch()} />;
  if (me.data.setupRequired) return <Navigate to="/setup" replace />;
  if (!me.data.authenticated) {
    const from = location.pathname + location.search;
    return <Navigate to="/login" replace state={{ from }} />;
  }
  return <>{children}</>;
}

/** For /login and /setup: bounce to the right place when not applicable. */
export function PublicOnly({ mode, children }: { mode: 'login' | 'setup'; children: React.ReactNode }) {
  const me = useMe();
  if (me.isPending) return <Splash />;
  if (me.isError) return <Splash error={me.error} onRetry={() => void me.refetch()} />;
  if (me.data.authenticated) return <Navigate to="/" replace />;
  if (mode === 'login' && me.data.setupRequired) return <Navigate to="/setup" replace />;
  if (mode === 'setup' && !me.data.setupRequired) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-sidebar p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <Logo className="size-10" />
          <div>
            <h1 className="text-lg font-semibold">{title}</h1>
            {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
          </div>
        </div>
        <div className="rounded-xl border border-border bg-panel p-5 shadow-sm">{children}</div>
      </div>
    </div>
  );
}

/** Agentforge mark: an anvil with forge sparks (same artwork as favicon.svg and unraid/icon.png). */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-foreground" />
      <path
        className="fill-background"
        d="M3.5 12.4C6 12 8 12 10 12h16v2.5c0 .9-.6 1.5-1.5 1.5h-3c-1.1 0-1.7 1-1.7 2.2V20h2.5c.7 0 1.2.5 1.2 1.2V24H9.5v-2.8c0-.7.5-1.2 1.2-1.2h2.5v-1.8c0-1.2-.8-2.2-1.9-2.2C8.5 16 5.7 14.6 3.5 12.4z"
      />
      <path fill="var(--brand)" d="M20 4.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" />
      <path fill="#fb923c" d="M13 6.2l.55 1.25 1.25.55-1.25.55L13 9.8l-.55-1.25L11.2 8l1.25-.55z" />
      <path fill="#fbbf24" d="M24.8 2.6l.35.8.8.35-.8.35-.35.8-.35-.8-.8-.35.8-.35z" />
    </svg>
  );
}
