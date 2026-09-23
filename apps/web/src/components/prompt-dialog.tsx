import * as React from 'react';
import { toast } from 'sonner';
import { errorMessage } from '@/lib/utils';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export function PromptDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  initialValue = '',
  placeholder,
  confirmLabel = 'OK',
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  label?: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  onSubmit: (value: string) => Promise<unknown> | void;
}) {
  const [value, setValue] = React.useState(initialValue);
  const [busy, setBusy] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (open) {
      setValue(initialValue);
      // select the name part (without extension) for rename convenience
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        const dot = initialValue.lastIndexOf('.');
        el.setSelectionRange(0, dot > 0 ? dot : initialValue.length);
      });
    }
  }, [open, initialValue]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    setBusy(true);
    try {
      await onSubmit(v);
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-md" onOpenAutoFocus={(e) => e.preventDefault()}>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <div className="grid gap-1.5">
            {label && <label className="text-xs font-medium">{label}</label>}
            <Input
              ref={inputRef}
              value={value}
              placeholder={placeholder}
              onChange={(e) => setValue(e.target.value)}
              className="font-mono text-[13px]"
              spellCheck={false}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Abbrechen
            </Button>
            <Button type="submit" disabled={busy || !value.trim()}>
              {busy && <Loader2 className="animate-spin" />}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
