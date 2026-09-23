import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Link2, Loader2 } from 'lucide-react';
import type { GhRepo } from '@vibe/shared';
import { qk } from '@/lib/queries';
import { errorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { githubApi, useGitHubStatus } from '@/features/github/api';
import { RepoPicker } from '@/features/github/RepoPicker';
import { gitKeys } from './api';

/** Link the project with an existing or new GitHub repository (sets repoOwner/repoName + origin). */
export function LinkRepoDialog({
  open,
  onOpenChange,
  projectId,
  suggestedName,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  suggestedName: string;
}) {
  const qc = useQueryClient();
  const status = useGitHubStatus();
  const [mode, setMode] = React.useState<'existing' | 'new'>('existing');
  const [selected, setSelected] = React.useState<GhRepo | null>(null);
  const [name, setName] = React.useState(suggestedName);
  const [isPrivate, setPrivate] = React.useState(true);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setSelected(null);
      setMode('existing');
      setName(suggestedName.replace(/[^A-Za-z0-9_.-]+/g, '-'));
      setPrivate(true);
    }
  }, [open, suggestedName]);

  const submit = async () => {
    setBusy(true);
    try {
      const repo = mode === 'new' ? await githubApi.createRepo({ name: name.trim(), private: isPrivate }) : selected!;
      await githubApi.link(projectId, repo.owner, repo.name);
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.project(projectId) }),
        qc.invalidateQueries({ queryKey: qk.projects }),
        qc.invalidateQueries({ queryKey: gitKeys.all(projectId) }),
        qc.invalidateQueries({ queryKey: ['gh', projectId] }),
      ]);
      toast.success(`Mit ${repo.fullName} verknüpft`);
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = status.data?.connected && (mode === 'new' ? /^[A-Za-z0-9_.-]+$/.test(name.trim()) : !!selected);

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Mit GitHub verknüpfen</DialogTitle>
          <DialogDescription>Push/Pull, Pull Requests und Issues nutzen dann dieses Repository (Remote „origin“).</DialogDescription>
        </DialogHeader>
        <Tabs value={mode} onValueChange={(v) => setMode(v as 'existing' | 'new')}>
          <TabsList>
            <TabsTrigger value="existing">Bestehendes Repository</TabsTrigger>
            <TabsTrigger value="new" disabled={!status.data?.connected}>
              Neues Repository
            </TabsTrigger>
          </TabsList>
          <TabsContent value="existing" className="pt-3">
            <RepoPicker selected={selected} onSelect={setSelected} />
          </TabsContent>
          <TabsContent value="new" className="grid gap-3 pt-3">
            <Field label="Name" htmlFor="new-repo-name">
              <Input id="new-repo-name" className="font-mono text-[13px]" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} /> Privat
            </label>
          </TabsContent>
        </Tabs>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Abbrechen
          </Button>
          <Button variant="brand" onClick={submit} disabled={busy || !canSubmit}>
            {busy ? <Loader2 className="animate-spin" /> : <Link2 />}
            {mode === 'new' ? 'Erstellen & verknüpfen' : 'Verknüpfen'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
