import * as React from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { ProjectWithWorkspace } from '@vibe/shared';
import { api } from '@/lib/api';
import { qk } from '@/lib/queries';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { toast } from 'sonner';

export function DeleteProjectDialog({
  project,
  open,
  onOpenChange,
}: {
  project: ProjectWithWorkspace;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [deleteFiles, setDeleteFiles] = React.useState(false);

  React.useEffect(() => {
    if (open) setDeleteFiles(false);
  }, [open]);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Projekt „${project.name}" löschen?`}
      description="Der Workspace-Container wird entfernt. Laufende Terminals und Agents werden beendet."
      confirmLabel="Projekt löschen"
      onConfirm={async () => {
        await api.deleteProject(project.id, deleteFiles);
        qc.setQueryData<ProjectWithWorkspace[]>(qk.projects, (old) => old?.filter((p) => p.id !== project.id));
        qc.removeQueries({ queryKey: qk.project(project.id) });
        void qc.invalidateQueries({ queryKey: qk.projects });
        toast.success(`Projekt „${project.name}" gelöscht`);
        navigate('/', { replace: true });
      }}
    >
      <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3 text-sm">
        <Checkbox checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} className="mt-0.5" />
        <span>
          <span className="font-medium">Dateien löschen</span>
          <span className="block text-xs text-muted-foreground">
            Löscht auch alle Projektdateien im Workspace-Volume. Kann nicht rückgängig gemacht werden.
          </span>
        </span>
      </label>
    </ConfirmDialog>
  );
}
