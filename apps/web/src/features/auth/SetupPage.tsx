import * as React from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { qk } from '@/lib/queries';
import { errorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { AuthLayout } from './AuthGate';

export function SetupPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [setupToken, setSetupToken] = React.useState('');
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [password2, setPassword2] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const mismatch = password2.length > 0 && password !== password2;
  const tooShort = password.length > 0 && password.length < 8;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== password2) return setError('Die Passwörter stimmen nicht überein.');
    setBusy(true);
    setError(null);
    try {
      const me = await api.setup({ setupToken: setupToken.trim(), username: username.trim(), password });
      qc.setQueryData(qk.me, me);
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Agentforge einrichten" subtitle="Lege das Administrator-Konto an.">
      <form onSubmit={submit} className="grid gap-4">
        <Field label="Setup-Token" htmlFor="token" hint="Steht im Server-Log.">
          <Input
            id="token"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-[13px]"
            value={setupToken}
            onChange={(e) => setSetupToken(e.target.value)}
          />
        </Field>
        <Field label="Benutzername" htmlFor="username">
          <Input id="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field label="Passwort" htmlFor="password" hint={tooShort ? 'Mindestens 8 Zeichen empfohlen.' : undefined}>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="Passwort wiederholen" htmlFor="password2">
          <Input
            id="password2"
            type="password"
            autoComplete="new-password"
            aria-invalid={mismatch || undefined}
            value={password2}
            onChange={(e) => setPassword2(e.target.value)}
          />
          {mismatch && <p className="text-xs text-destructive">Die Passwörter stimmen nicht überein.</p>}
        </Field>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button
          type="submit"
          className="w-full"
          disabled={busy || !setupToken || !username || !password || password !== password2}
        >
          {busy && <Loader2 className="animate-spin" />}
          Konto erstellen
        </Button>
      </form>
    </AuthLayout>
  );
}
