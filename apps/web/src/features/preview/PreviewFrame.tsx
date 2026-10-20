import * as React from 'react';
import { AlertTriangle, Info, RotateCw, X } from 'lucide-react';
import { cn, errorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { frameUrl, previewApi } from './api';
import { frames, usePreviewLive, usePreviewTabs, type DeviceKind, type PreviewTab } from './store';

const HTTPS_PORT_HINT_KEY = 'vibe-preview-https-port-hint';

/** Port mode serves plain HTTP on 7100…; behind an HTTPS reverse proxy those ports are usually not reachable. */
function showHttpsPortHint(): boolean {
  if (window.location.protocol !== 'https:') return false;
  try {
    return localStorage.getItem(HTTPS_PORT_HINT_KEY) !== 'dismissed';
  } catch {
    return true;
  }
}

const DEVICE_SIZE: Record<Exclude<DeviceKind, 'desktop'>, { width: number; height: number }> = {
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
};

/** One preview tab: requests a slot + fresh token, then (re)mounts the iframe. Stays mounted while hidden. */
export function PreviewFrame({
  projectId,
  tab,
  visible,
  device,
}: {
  projectId: string;
  tab: PreviewTab;
  visible: boolean;
  device: DeviceKind;
}) {
  const nonce = usePreviewLive((s) => s.live[tab.id]?.nonce ?? 0);
  const [state, setState] = React.useState<{ src: string | null; key: number; loading: boolean; error: string | null }>({
    src: null,
    key: 0,
    loading: true,
    error: null,
  });
  const [hostPort, setHostPort] = React.useState<number | null>(null);
  const [portHint, setPortHint] = React.useState(showHttpsPortHint);
  // Tabs load once first shown. With a shared preview origin (host mode) the browser can only show one
  // slot at a time, so hidden tabs drop their frame and reload when shown again.
  const [seen, setSeen] = React.useState(visible);
  const [exclusive, setExclusive] = React.useState(false);
  if (visible && !seen) setSeen(true);
  const active = visible || (seen && !exclusive);

  React.useEffect(() => {
    if (!active) {
      setState((s) => ({ ...s, src: null, loading: false, error: null }));
      return;
    }
    let cancelled = false;
    const cur = usePreviewTabs.getState().tabs[projectId]?.find((t) => t.id === tab.id);
    if (!cur) return;
    const path = usePreviewLive.getState().live[tab.id]?.path ?? cur.path ?? '/';
    setState((s) => ({ ...s, loading: true, error: null }));
    // POST is idempotent; every (re)load gets a fresh one-time token so expired links never matter.
    previewApi.open(projectId, cur.port).then(
      (slot) => {
        if (cancelled) return;
        setHostPort(slot.hostPort);
        setExclusive(slot.exclusive);
        setState((s) => ({ src: frameUrl(slot, path), key: s.key + 1, loading: true, error: null }));
      },
      (err) => {
        if (!cancelled) setState((s) => ({ ...s, loading: false, error: errorMessage(err) }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, tab.id, nonce, active]);

  const setRef = React.useCallback(
    (el: HTMLIFrameElement | null) => {
      if (el) frames.set(tab.id, { el, projectId, origin: new URL(el.src).origin });
      else frames.delete(tab.id);
    },
    [tab.id, projectId],
  );

  const size = device === 'desktop' ? null : DEVICE_SIZE[device];

  return (
    <div
      className={cn(
        'absolute inset-0 flex justify-center overflow-auto',
        !visible && 'pointer-events-none invisible',
        size && 'bg-muted/40 p-4',
      )}
    >
      <div
        className={cn('relative shrink-0', size && 'overflow-hidden rounded-xl border border-border shadow-xl')}
        style={size ? { width: size.width, height: '100%', maxHeight: size.height } : { width: '100%', height: '100%' }}
      >
        {state.src && (
          <iframe
            key={state.key}
            ref={setRef}
            src={state.src}
            title={tab.title || `Vorschau Port ${tab.port}`}
            className="size-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
            allow="clipboard-read; clipboard-write; fullscreen; geolocation; camera; microphone"
            onLoad={() => setState((s) => ({ ...s, loading: false }))}
          />
        )}
        {state.loading && !state.error && (
          <div className="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-brand/20">
            <div className="h-full w-1/3 animate-[vibe-pv-load_1s_ease-in-out_infinite] bg-brand" />
          </div>
        )}
        {state.error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-panel p-6 text-center">
            <AlertTriangle className="size-6 text-warning" />
            <div className="text-sm font-medium">Vorschau konnte nicht geöffnet werden</div>
            <div className="max-w-sm text-xs text-muted-foreground">{state.error}</div>
            <Button size="sm" variant="secondary" onClick={() => usePreviewLive.getState().load(tab.id)}>
              <RotateCw /> Erneut versuchen
            </Button>
          </div>
        )}
      </div>
      {hostPort !== null && portHint && (
        <div className="absolute inset-x-2 bottom-2 flex items-start gap-2 rounded-lg border border-border bg-panel/95 p-2.5 text-xs text-muted-foreground shadow-lg">
          <Info className="mt-0.5 size-3.5 shrink-0 text-brand" />
          <div className="min-w-0 flex-1">
            Leer oder Verbindungsfehler? Im Port-Modus läuft die Vorschau über Port {hostPort} (unverschlüsselt). Hinter
            einem HTTPS-Reverse-Proxy ist dieser Port meist nicht erreichbar – dann eine eigene Vorschau-Adresse
            einrichten (<code>PREVIEW_HOST</code>, siehe docs/installation.md).
          </div>
          <button
            type="button"
            aria-label="Hinweis ausblenden"
            className="shrink-0 rounded p-0.5 hover:bg-muted"
            onClick={() => {
              setPortHint(false);
              try {
                localStorage.setItem(HTTPS_PORT_HINT_KEY, 'dismissed');
              } catch {
                /* storage blocked */
              }
            }}
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <style>{'@keyframes vibe-pv-load{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}'}</style>
    </div>
  );
}
