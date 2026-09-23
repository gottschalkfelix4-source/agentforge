import * as React from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FolderPlus, Github, GitPullRequestCreateArrow, Loader2 } from 'lucide-react';
import type { GhRepo, ProjectWithWorkspace } from '@vibe/shared';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/utils';
import { qk } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { githubApi } from '@/features/github/api';
import { emptyNewRepo, isValidRepoName, NewRepoFields, toRepoName, type NewRepoValue } from '@/features/github/NewRepoFields';
import { RepoPicker } from '@/features/github/RepoPicker';

type Mode = 'blank' | 'github' | 'newrepo';

export function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [mode, setMode] = React.useState<Mode>('blank');
  const [name, setName] = React.useState('');
  const [nameTouched, setNameTouched] = React.useState(false);
  const [gitUrl, setGitUrl] = React.useState('');
  const [repo, setRepo] = React.useState<GhRepo | null>(null);
  const [newRepo, setNewRepo] = React.useState<NewRepoValue>(emptyNewRepo);
  const [repoNameTouched, setRepoNameTouched] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setMode('blank');
      setName('');
      setNameTouched(false);
      setGitUrl('');
      setRepo(null);
      setNewRepo(emptyNewRepo);
      setRepoNameTouched(false);
    }
  }, [open]);

  const create = useMutation({
    mutationFn: async () => {
      if (mode === 'newrepo') {
        // Create the repository on GitHub first, then a project linked to it (cloned into the workspace).
        const created = await githubApi.createRepo({
          name: newRepo.name,
          private: newRepo.private,
          description: newRepo.description.trim() || null,
          org: newRepo.org,
          autoInit: newRepo.autoInit,
        });
        void qc.invalidateQueries({ queryKey: ['github', 'repos'] });
        return api.createProject({ name: name.trim(), repo: { owner: created.owner, name: created.name } });
      }
      return api.createProject(
        mode === 'github' && repo
          ? { name: name.trim(), repo: { owner: repo.owner, name: repo.name } }
          : { name: name.trim(), gitUrl: gitUrl.trim() || null },
      );
    },
    onSuccess: (project) => {
      qc.setQueryData<ProjectWithWorkspace[]>(qk.projects, (old) => (old ? [...old, project] : [project]));
      qc.setQueryData(qk.project(project.id), project);
      void qc.invalidateQueries({ queryKey: qk.projects });
      onOpenChange(false);
      navigate(`/p/${project.id}`);
    },
  });

  // Derive a name from the git URL if the user left it empty.
  const onGitBlur = () => {
    if (name.trim() || !gitUrl.trim()) return;
    const m = /([^/:]+?)(\.git)?\/?$/.exec(gitUrl.trim());
    if (m?.[1]) setName(m[1]);
  };

  const pickRepo = (r: GhRepo) => {
    setRepo(r);
    if (!nameTouched) setName(r.name);
  };

  const onNewRepoChange = (v: NewRepoValue) => {
    if (v.name !== newRepo.name) setRepoNameTouched(true);
    setNewRepo(v);
    if (!nameTouched && v.name) setName(v.name);
  };

  const onNameChange = (value: string) => {
    setName(value);
    setNameTouched(true);
    // Keep the repo name in sync with the project name until the user edits it.
    if (!repoNameTouched) setNewRepo((r) => ({ ...r, name: toRepoName(value) }));
  };

  const canSubmit =
    !!name.trim() &&
    (mode === 'blank' || (mode === 'github' && !!repo) || (mode === 'newrepo' && isValidRepoName(newRepo.name))) &&
    !create.isPending;

  return (
    <Dialog open={open} onOpenChange={(o) => !create.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) create.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Neues Projekt</DialogTitle>
            <DialogDescription>Jedes Projekt bekommt einen eigenen Workspace-Container.</DialogDescription>
          </DialogHeader>
          <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
            <TabsList>
              <TabsTrigger value="blank">
                <FolderPlus className="size-3.5" /> Leer / Git-URL
              </TabsTrigger>
              <TabsTrigger value="github">
                <Github className="size-3.5" /> Von GitHub
              </TabsTrigger>
              <TabsTrigger value="newrepo">
                <GitPullRequestCreateArrow className="size-3.5" /> Neues Repo
              </TabsTrigger>
            </TabsList>
            <TabsContent value="blank" className="grid gap-4">
              <Field label="Git-URL (optional)" htmlFor="project-git" hint="Wird beim ersten Start in den Workspace geklont.">
                <Input
                  id="project-git"
                  placeholder="https://github.com/user/repo.git"
                  className="font-mono text-[13px]"
                  spellCheck={false}
                  value={gitUrl}
                  onChange={(e) => setGitUrl(e.target.value)}
                  onBlur={onGitBlur}
                />
              </Field>
            </TabsContent>
            <TabsContent value="github" className="grid gap-2">
              <RepoPicker selected={repo} onSelect={pickRepo} />
              <p className="text-xs text-muted-foreground">
                Wird mit deinem GitHub-Token geklont (auch private Repos) und mit dem Projekt verknüpft.
              </p>
            </TabsContent>
            <TabsContent value="newrepo" className="grid gap-2">
              <NewRepoFields value={newRepo} onChange={onNewRepoChange} />
              <p className="text-xs text-muted-foreground">
                Das Repository wird auf GitHub angelegt, mit dem Projekt verknüpft und in den Workspace geklont.
              </p>
            </TabsContent>
          </Tabs>
          <Field label="Name" htmlFor="project-name">
            <Input
              id="project-name"
              autoFocus={mode === 'blank'}
              placeholder="mein-projekt"
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
            />
          </Field>
          {create.isError && (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {errorMessage(create.error)}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={create.isPending}>
              Abbrechen
            </Button>
            <Button type="submit" variant="brand" disabled={!canSubmit}>
              {create.isPending && <Loader2 className="animate-spin" />}
              {mode === 'newrepo' ? 'Repo & Projekt erstellen' : 'Projekt erstellen'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
