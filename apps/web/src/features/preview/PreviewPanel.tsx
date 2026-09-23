import * as React from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ExternalLink,
  Globe,
  Monitor,
  Plus,
  RotateCw,
  Smartphone,
  SquareTerminal,
  Tablet,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type { PreviewCommand, PreviewMessage } from '@vibe/shared';
import { usePorts } from '@/lib/queries';
import { useNav } from '@/lib/store';
import { cn, errorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { frameUrl, parseAddress, previewApi } from './api';
import { ConsoleDrawer } from './ConsoleDrawer';
import { ManualPortForm, PortMenu } from './PortMenu';
import { PreviewFrame } from './PreviewFrame';
import { frames, usePreviewLive, usePreviewTabs, type DeviceKind, type PreviewTab } from './store';

const EMPTY_TABS: PreviewTab[] = [];

// ---- messages from preview frames (one global listener) ------------------------------

const LEVELS = new Set(['log', 'info', 'warn', 'error', 'debug']);

function onFrameMessage(e: MessageEvent) {
  const d = e.data as PreviewMessage | undefined;
  if (!d || typeof d !== 'object' || d.source !== 'vibe-preview') return;
  let tabId: string | undefined;
  let projectId = '';
  for (const [id, f] of frames) {
    if (f.el.contentWindow === e.source) {
      tabId = id;
      projectId = f.projectId;
      break;
    }
  }
  if (!tabId) return;
  const live = usePreviewLive.getState();
  const ts = typeof d.ts === 'number' ? d.ts : Date.now();
  switch (d.type) {
    case 'console':
      if (!LEVELS.has(d.level) || !Array.isArray(d.args)) return;
      live.pushLog(tabId, { level: d.level, text: d.args.map(String).join(' '), ts });
      break;
    case 'error':
      live.pushLog(tabId, {
        level: 'error',
        text: String(d.message),
        stack: typeof d.stack === 'string' ? d.stack : undefined,
        ts,
      });
      break;
    case 'navigate':
      if (typeof d.url !== 'string') return;
      usePreviewTabs.getState().updateTab(projectId, tabId, { path: d.url, title: String(d.title ?? '').slice(0, 200) });
      break;
    case 'ready':
      live.patch(tabId, { ready: true });
      break;
    case 'auth-required': {
      // Cookie missing/expired or the slot was reassigned: get a fresh token once, then give up.
      const cur = live.live[tabId];
      if (cur && Date.now() - cur.lastAuthRetry < 15_000) {
        live.pushLog(tabId, { level: 'error', text: 'Vorschau-Zugang fehlgeschlagen. Bitte neu laden.', ts });
        return;
      }
      live.patch(tabId, { lastAuthRetry: Date.now() });
      live.load(tabId);
      break;
    }
  }
}

if (typeof window !== 'undefined') window.addEventListener('message', onFrameMessage);

function sendCommand(tabId: string, type: PreviewCommand['type']) {
  const f = frames.get(tabId);
  const msg: PreviewCommand = { source: 'vibe-parent', type };
  f?.el.contentWindow?.postMessage(msg, f.origin);
}

/** Handled previewRequest nonces (the nav store keeps the last request around). */
const handledRequests = new Set<number>();

// ---- UI ----------------------------------------------------------------------------------

const DEVICES: { id: DeviceKind; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'desktop', label: 'Desktop', icon: Monitor },
  { id: 'tablet', label: 'Tablet (768 px)', icon: Tablet },
  { id: 'mobile', label: 'Mobil (390 px)', icon: Smartphone },
];

function AddressBar({ tab, onSubmit }: { tab: PreviewTab; onSubmit: (value: string) => void }) {
  const [draft, setDraft] = React.useState(tab.path);
  const [focused, setFocused] = React.useState(false);
  React.useEffect(() => {
    if (!focused) setDraft(tab.path);
  }, [tab.path, focused]);
  return (
    <form
      className="min-w-0 flex-1"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(draft);
        (e.currentTarget.elements.namedItem('address') as HTMLInputElement | null)?.blur();
      }}
    >
      <input
        name="address"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => {
          setFocused(true);
          e.currentTarget.select();
        }}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setDraft(tab.path);
            e.currentTarget.blur();
          }
        }}
        spellCheck={false}
        aria-label="Adresse"
        className="h-7 w-full min-w-0 rounded-md border border-transparent bg-muted px-2.5 font-mono text-xs outline-none transition-colors focus:border-ring focus:bg-transparent"
      />
    </form>
  );
}

function EmptyState({ ports, onPick }: { ports: { port: number; address: string }[]; onPick: (port: number) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="flex size-10 items-center justify-center rounded-xl bg-muted">
        <Globe className="size-5 text-muted-foreground" />
      </div>
      {ports.length === 0 ? (
        <div className="space-y-1">
          <div className="text-sm font-medium">Noch kein Dev-Server erkannt</div>
          <p className="max-w-xs text-xs text-muted-foreground">
            Starte einen Dev-Server im Terminal (z. B. <code className="rounded bg-muted px-1">npm run dev</code>) oder
            bitte den Agenten darum. Sobald ein Port lauscht, öffnet sich die Vorschau automatisch.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="text-sm font-medium">Dev-Server erkannt</div>
          <div className="flex flex-wrap justify-center gap-1.5">
            {ports.map((p) => (
              <Button key={p.port} size="sm" variant="secondary" className="font-mono" onClick={() => onPick(p.port)}>
                <span className="size-1.5 rounded-full bg-success" />
                {p.port}
              </Button>
            ))}
          </div>
        </div>
      )}
      <div className="w-56">
        <ManualPortForm onPick={onPick} />
      </div>
      <p className="max-w-xs text-[11px] text-muted-foreground/80">
        Tipp: Der Server sollte auf <code>localhost</code> oder <code>0.0.0.0</code> lauschen.
      </p>
    </div>
  );
}

export function PreviewPanel({ projectId }: { projectId: string }) {
  const tabs = usePreviewTabs((s) => s.tabs[projectId]) ?? EMPTY_TABS;
  const activeId = usePreviewTabs((s) => s.active[projectId]);
  const device = usePreviewTabs((s) => s.device);
  const consoleOpen = usePreviewTabs((s) => s.consoleOpen);
  const { addTab, closeTab, setActive, updateTab, setDevice, setConsoleOpen } = usePreviewTabs.getState();
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const ready = usePreviewLive((s) => (active ? !!s.live[active.id]?.ready : false));
  const errorCount = usePreviewLive((s) => (active ? (s.logs[active.id]?.filter((e) => e.level === 'error').length ?? 0) : 0));
  const load = usePreviewLive((s) => s.load);

  const portsQuery = usePorts(projectId);
  const ports = React.useMemo(() => [...(portsQuery.data ?? [])].sort((a, b) => a.port - b.port), [portsQuery.data]);

  const openPort = React.useCallback(
    (port: number, path = '/') => {
      const list = usePreviewTabs.getState().tabs[projectId] ?? [];
      const existing = list.find((t) => t.port === port);
      if (existing) {
        setActive(projectId, existing.id);
        if (path !== '/') {
          updateTab(projectId, existing.id, { path });
          load(existing.id, path);
        }
      } else addTab(projectId, port, path);
    },
    [projectId, setActive, updateTab, addTab, load],
  );

  // Requests from other features (chat, ports indicator).
  const request = useNav((s) => s.previewRequest);
  React.useEffect(() => {
    if (!request || request.projectId !== projectId || handledRequests.has(request.nonce)) return;
    handledRequests.add(request.nonce);
    openPort(request.port, request.path ?? '/');
  }, [request, projectId, openPort]);

  // Auto-open the first new port while the panel is empty.
  const seen = React.useRef<Set<number> | null>(null);
  React.useEffect(() => {
    if (!portsQuery.data) return;
    if (!seen.current) {
      seen.current = new Set(portsQuery.data.map((p) => p.port));
      return;
    }
    for (const p of portsQuery.data) {
      if (seen.current.has(p.port)) continue;
      seen.current.add(p.port);
      if ((usePreviewTabs.getState().tabs[projectId] ?? []).length === 0) addTab(projectId, p.port);
    }
  }, [portsQuery.data, projectId, addTab]);

  const navigateTo = (value: string) => {
    if (!active) return;
    const { port, path } = parseAddress(value);
    if (port && port !== active.port) updateTab(projectId, active.id, { port, path, title: '' });
    else updateTab(projectId, active.id, { path });
    load(active.id, path);
  };

  const changePort = (port: number) => {
    if (!active) return openPort(port);
    if (port === active.port) return load(active.id);
    updateTab(projectId, active.id, { port, path: '/', title: '' });
    load(active.id, '/');
  };

  const openExternal = async () => {
    if (!active) return;
    // Open synchronously (popup blockers), then point it at a fresh token URL.
    const w = window.open('about:blank', '_blank');
    try {
      const slot = await previewApi.open(projectId, active.port);
      if (w) {
        w.opener = null;
        w.location.href = frameUrl(slot, active.path);
      }
    } catch (err) {
      w?.close();
      toast.error(errorMessage(err));
    }
  };

  if (tabs.length === 0) {
    return (
      <div className="h-full bg-panel">
        <EmptyState ports={ports} onPick={(port) => openPort(port)} />
      </div>
    );
  }

  const viewport = (
    <div className="relative h-full min-h-0">
      {tabs.map((t) => (
        <PreviewFrame key={t.id} projectId={projectId} tab={t} visible={t.id === active?.id} device={device} />
      ))}
    </div>
  );

  return (
    <div className="flex h-full min-w-0 flex-col bg-panel">
      {/* tabs */}
      <div className="flex h-8 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border px-1.5 pt-1">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={cn(
              'group flex h-7 max-w-44 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-2 text-xs transition-colors',
              t.id === active?.id
                ? 'border-border bg-muted text-foreground'
                : 'border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground',
            )}
            onClick={() => setActive(projectId, t.id)}
            onAuxClick={(e) => {
              if (e.button === 1) closeTab(projectId, t.id);
            }}
            title={`${t.title || 'Vorschau'} – Port ${t.port}${t.path}`}
          >
            <Globe className="size-3 shrink-0" />
            <span className="truncate">{t.title || `localhost:${t.port}`}</span>
            <button
              type="button"
              aria-label="Tab schließen"
              className="ml-auto flex size-4 shrink-0 items-center justify-center rounded opacity-60 hover:bg-accent hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(projectId, t.id);
              }}
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        <PortMenu ports={ports} onPick={(port) => addTab(projectId, port)}>
          <Button variant="ghost" size="icon-xs" className="mb-1 ml-0.5 shrink-0" aria-label="Neuer Vorschau-Tab" title="Neuer Tab">
            <Plus />
          </Button>
        </PortMenu>
      </div>

      {/* toolbar */}
      {active && (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-1.5">
          <Button variant="ghost" size="icon-sm" title="Zurück" aria-label="Zurück" disabled={!ready} onClick={() => sendCommand(active.id, 'back')}>
            <ArrowLeft />
          </Button>
          <Button variant="ghost" size="icon-sm" title="Vorwärts" aria-label="Vorwärts" disabled={!ready} onClick={() => sendCommand(active.id, 'forward')}>
            <ArrowRight />
          </Button>
          <Button variant="ghost" size="icon-sm" title="Neu laden" aria-label="Neu laden" onClick={() => load(active.id)}>
            <RotateCw />
          </Button>
          <PortMenu ports={ports} current={active.port} onPick={changePort}>
            <button
              type="button"
              title="Port wählen"
              className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 font-mono text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              :{active.port}
              <ChevronDown className="size-3" />
            </button>
          </PortMenu>
          <AddressBar tab={active} onSubmit={navigateTo} />
          <div className="ml-1 flex shrink-0 items-center rounded-md bg-muted p-0.5">
            {DEVICES.map((d) => (
              <button
                key={d.id}
                type="button"
                title={d.label}
                aria-label={d.label}
                aria-pressed={device === d.id}
                onClick={() => setDevice(d.id)}
                className={cn(
                  'flex size-6 items-center justify-center rounded transition-colors',
                  device === d.id ? 'bg-panel text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <d.icon className="size-3.5" />
              </button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn('relative', consoleOpen && 'bg-muted')}
            title="Konsole"
            aria-label="Konsole"
            aria-pressed={consoleOpen}
            onClick={() => setConsoleOpen(!consoleOpen)}
          >
            <SquareTerminal />
            {errorCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-1 text-[9px] leading-none font-semibold text-destructive-foreground">
                {errorCount > 99 ? '99+' : errorCount}
              </span>
            )}
          </Button>
          <Button variant="ghost" size="icon-sm" title="In neuem Tab öffnen" aria-label="In neuem Tab öffnen" onClick={() => void openExternal()}>
            <ExternalLink />
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {/* Always a PanelGroup so toggling the console never remounts (reloads) the frames. */}
        <PanelGroup direction="vertical" autoSaveId="vibe-preview-console">
          <Panel id="pv-view" order={1} minSize={20}>
            {viewport}
          </Panel>
          {consoleOpen && (
            <>
              <PanelResizeHandle className="h-px shrink-0 bg-border transition-colors data-[resize-handle-state=drag]:bg-brand data-[resize-handle-state=hover]:bg-brand/60" />
              <Panel id="pv-console" order={2} defaultSize={30} minSize={10}>
                <ConsoleDrawer tabId={active?.id} onClose={() => setConsoleOpen(false)} />
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>
    </div>
  );
}
