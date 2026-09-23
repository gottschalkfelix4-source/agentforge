import * as React from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { qk } from '@/lib/queries';
import { errorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { AuthLayout } from './AuthGate';

export function LoginPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await api.login({ username: username.trim(), password });
      qc.setQueryData(qk.me, me);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== '/login' ? from : '/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Bei Agentforge anmelden">
      <form onSubmit={submit} className="grid gap-4">
        <Field label="Benutzername" htmlFor="username">
          <Input
            id="username"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field label="Passwort" htmlFor="password">
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy || !username || !password} className="w-full">
          {busy && <Loader2 className="animate-spin" />}
          Anmelden
        </Button>
      </form>
    </AuthLayout>
  );
}
