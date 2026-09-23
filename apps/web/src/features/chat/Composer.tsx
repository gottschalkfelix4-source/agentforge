import * as React from 'react';
import { toast } from 'sonner';
import type { ImageInput } from '@vibe/shared';
import { ArrowUp, Check, ChevronDown, Cpu, ImagePlus, Loader2, Square, SlidersHorizontal, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { SessionInfo } from './transcript';
import { fileToImage } from './util';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface ComposerImage extends ImageInput {
  name: string;
}

const drafts = new Map<string, string>();

export interface ComposerApi {
  setText: (v: string) => void;
  focus: () => void;
}

/** Small pill-style dropdown used for model/mode/agent pickers. */
export function PickerMenu<T extends string>({
  icon,
  label,
  title,
  items,
  value,
  onSelect,
  disabled,
}: {
  icon?: React.ReactNode;
  label: React.ReactNode;
  title: string;
  items: { id: T; name: React.ReactNode; description?: string; right?: React.ReactNode }[];
  value: T | null | undefined;
  onSelect: (id: T) => void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          className="flex h-7 max-w-52 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-50 data-[state=open]:bg-accent data-[state=open]:text-foreground"
        >
          {icon}
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3 shrink-0 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
        <DropdownMenuLabel>{title}</DropdownMenuLabel>
        {items.map((it) => (
          <DropdownMenuItem key={it.id} onSelect={() => onSelect(it.id)} className="items-start">
            <Check className={cn('mt-0.5', it.id === value ? 'opacity-100' : 'opacity-0')} />
            <div className="min-w-0 flex-1">
              <div className="truncate">{it.name}</div>
              {it.description && <div className="text-[11px] leading-snug text-muted-foreground">{it.description}</div>}
            </div>
            {it.right}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Composer({
  draftKey,
  placeholder = 'Nachricht an den Agent…',
  disabled,
  disabledHint,
  running,
  canSend = true,
  onSend,
  onStop,
  info,
  onModel,
  onMode,
  leftSlot,
  large,
  autoFocus,
  apiRef,
}: {
  draftKey: string;
  placeholder?: string;
  disabled?: boolean;
  disabledHint?: React.ReactNode;
  running?: boolean;
  canSend?: boolean;
  /** Resolve true to clear the composer. */
  onSend: (text: string, images: ComposerImage[]) => Promise<boolean>;
  onStop?: () => Promise<unknown>;
  info?: SessionInfo | null;
  onModel?: (id: string) => void;
  onMode?: (id: string) => void;
  leftSlot?: React.ReactNode;
  large?: boolean;
  autoFocus?: boolean;
  apiRef?: React.Ref<ComposerApi>;
}) {
  const [text, setTextState] = React.useState(() => drafts.get(draftKey) ?? '');
  const [images, setImages] = React.useState<ComposerImage[]>([]);
  const [sending, setSending] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);
  const [dragOver, setDragOver] = React.useState(false);
  const [cmdIndex, setCmdIndex] = React.useState(0);
  const [cmdDismissed, setCmdDismissed] = React.useState(false);
  const ta = React.useRef<HTMLTextAreaElement>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);

  const setText = React.useCallback(
    (v: string) => {
      setTextState(v);
      drafts.set(draftKey, v);
    },
    [draftKey],
  );

  // switch drafts when the session changes
  React.useEffect(() => {
    setTextState(drafts.get(draftKey) ?? '');
    setImages([]);
  }, [draftKey]);

  React.useImperativeHandle(
    apiRef,
    () => ({
      setText: (v: string) => {
        setText(v);
        requestAnimationFrame(() => {
          const el = ta.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(v.length, v.length);
        });
      },
      focus: () => ta.current?.focus(),
    }),
    [setText],
  );

  // autosize (also when the width changes, e.g. first layout or panel resize)
  const autosize = React.useCallback(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, large ? 360 : 280)}px`;
  }, [large]);
  React.useLayoutEffect(autosize, [text, autosize]);
  React.useEffect(() => {
    const el = ta.current;
    if (!el) return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== w) {
        w = el.clientWidth;
        autosize();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [autosize]);

  React.useEffect(() => {
    if (autoFocus && !disabled) ta.current?.focus();
  }, [autoFocus, disabled, draftKey]);

  // slash commands
  const commands = info?.commands ?? [];
  const slashQuery = /^\/(\S*)$/.exec(text)?.[1] ?? null;
  const cmdMatches = React.useMemo(() => {
    if (slashQuery === null || cmdDismissed) return [];
    const q = slashQuery.toLowerCase();
    return commands.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 12);
  }, [slashQuery, cmdDismissed, commands]);
  React.useEffect(() => {
    setCmdIndex(0);
  }, [cmdMatches.length]);
  React.useEffect(() => {
    if (!text.startsWith('/')) setCmdDismissed(false);
  }, [text]);

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (list.length === 0) return;
    const out: ComposerImage[] = [];
    for (const f of list) {
      if (f.size > MAX_IMAGE_BYTES) {
        toast.error(`${f.name || 'Bild'} ist größer als 5 MB`);
        continue;
      }
      try {
        out.push(await fileToImage(f));
      } catch (err) {
        toast.error(String(err));
      }
    }
    if (out.length) setImages((prev) => [...prev, ...out].slice(0, 8));
  };

  const busy = sending || !!running;
  const trimmed = text.trim();
  const sendable = !disabled && canSend && !busy && (trimmed.length > 0 || images.length > 0);

  const send = async () => {
    if (!sendable) return;
    setSending(true);
    try {
      const ok = await onSend(trimmed, images);
      if (ok) {
        setText('');
        setImages([]);
      }
    } finally {
      setSending(false);
      requestAnimationFrame(() => ta.current?.focus());
    }
  };

  const stop = async () => {
    if (!onStop) return;
    setStopping(true);
    try {
      await onStop();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  };

  const acceptCommand = (name: string) => {
    setText(`/${name} `);
    setCmdDismissed(true);
    ta.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (cmdMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCmdIndex((i) => (i + 1) % cmdMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCmdIndex((i) => (i - 1 + cmdMatches.length) % cmdMatches.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        acceptCommand(cmdMatches[cmdIndex]?.name ?? cmdMatches[0]!.name);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setCmdDismissed(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    } else if (e.key === 'Escape' && running && onStop) {
      e.preventDefault();
      void stop();
    }
  };

  const models = info?.models ?? [];
  const modes = info?.modes ?? [];
  const currentModel = models.find((m) => m.id === info?.currentModel);
  const currentMode = modes.find((m) => m.id === info?.currentMode);

  return (
    <div className="relative">
      {cmdMatches.length > 0 && (
        <div className="absolute right-0 bottom-full left-0 z-30 mb-1.5 max-h-72 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-xl">
          <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">Befehle</div>
          {cmdMatches.map((c, i) => (
            <button
              key={c.name}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => acceptCommand(c.name)}
              onMouseEnter={() => setCmdIndex(i)}
              className={cn(
                'flex w-full cursor-pointer items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-[13px]',
                i === cmdIndex && 'bg-accent',
              )}
            >
              <span className="font-mono text-[12.5px]">/{c.name}</span>
              {c.description && <span className="truncate text-xs text-muted-foreground">{c.description}</span>}
            </button>
          ))}
        </div>
      )}
      <div
        className={cn(
          'rounded-2xl border border-input bg-panel shadow-sm transition-colors focus-within:border-ring/70 focus-within:ring-2 focus-within:ring-ring/15',
          dragOver && 'border-brand ring-2 ring-brand/25',
          disabled && 'opacity-70',
        )}
        onDragOver={(e) => {
          if (disabled || !Array.from(e.dataTransfer.types).includes('Files')) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          if (disabled) return;
          e.preventDefault();
          setDragOver(false);
          void addFiles(e.dataTransfer.files);
        }}
      >
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {images.map((img, i) => (
              <div key={i} className="group relative">
                <img src={`data:${img.mime};base64,${img.data}`} alt={img.name} className="size-14 rounded-lg border border-border object-cover" />
                <button
                  type="button"
                  aria-label="Bild entfernen"
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                  className="absolute -top-1.5 -right-1.5 flex size-5 cursor-pointer items-center justify-center rounded-full border border-border bg-popover text-muted-foreground opacity-0 shadow transition-opacity group-hover:opacity-100 hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={ta}
          rows={large ? 3 : 1}
          value={text}
          disabled={disabled}
          placeholder={disabled && disabledHint ? undefined : placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
            if (files.length) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          className={cn(
            'block w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[14px] leading-relaxed outline-none placeholder:text-muted-foreground/60 disabled:cursor-not-allowed',
            large ? 'min-h-24' : 'min-h-11',
          )}
        />
        <div className="flex items-center gap-0.5 px-2 pb-2">
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <Tooltip content="Bild anhängen (auch per Einfügen/Ziehen)">
            <Button variant="ghost" size="icon-sm" disabled={disabled} onClick={() => fileInput.current?.click()} aria-label="Bild anhängen">
              <ImagePlus className="size-4 text-muted-foreground" />
            </Button>
          </Tooltip>
          {leftSlot}
          {modes.length > 0 && onMode && (
            <PickerMenu
              icon={<SlidersHorizontal className="size-3.5" />}
              label={currentMode?.name ?? info?.currentMode ?? 'Modus'}
              title="Modus"
              items={modes.map((m) => ({ id: m.id, name: m.name, description: m.description }))}
              value={info?.currentMode}
              onSelect={onMode}
              disabled={disabled}
            />
          )}
          {models.length > 0 && onModel && (
            <PickerMenu
              icon={<Cpu className="size-3.5" />}
              label={currentModel?.name ?? info?.currentModel ?? 'Modell'}
              title="Modell"
              items={models.map((m) => ({ id: m.id, name: m.name }))}
              value={info?.currentModel}
              onSelect={onModel}
              disabled={disabled}
            />
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {disabled && disabledHint && <span className="text-xs text-muted-foreground">{disabledHint}</span>}
            {running && onStop ? (
              <Tooltip content="Stoppen (Esc)">
                <Button size="icon-sm" variant="secondary" className="rounded-full" onClick={() => void stop()} aria-label="Stoppen">
                  {stopping ? <Loader2 className="animate-spin" /> : <Square className="size-3 fill-current" />}
                </Button>
              </Tooltip>
            ) : (
              <Button
                size="icon-sm"
                variant="brand"
                className="rounded-full"
                disabled={!sendable}
                onClick={() => void send()}
                aria-label="Senden"
              >
                {sending ? <Loader2 className="animate-spin" /> : <ArrowUp className="size-4" />}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
