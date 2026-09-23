import { DiffEditor } from '@monaco-editor/react';
import type { FileDiff } from '@vibe/shared';
import { setupMonaco } from '@/lib/monaco';
import { useUi } from '@/lib/store';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { languageFor } from '@/features/editor/language';

setupMonaco();

/** Side-by-side Monaco diff (lazy-loaded). */
export default function MonacoDiffDialog({
  diff,
  open,
  onOpenChange,
}: {
  diff: FileDiff;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const theme = useUi((s) => s.theme);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] max-w-[min(1400px,95vw)] flex-col gap-3 p-4">
        <DialogTitle className="truncate pr-8 font-mono text-sm">{diff.path}</DialogTitle>
        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
          <DiffEditor
            original={diff.oldText ?? ''}
            modified={diff.newText ?? ''}
            language={languageFor(diff.path)}
            theme={theme === 'dark' ? 'vibe-dark' : 'vibe-light'}
            options={{
              readOnly: true,
              renderSideBySide: true,
              minimap: { enabled: false },
              fontSize: 12.5,
              scrollBeyondLastLine: false,
              automaticLayout: true,
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
