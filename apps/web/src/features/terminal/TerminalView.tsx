import * as React from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { TermControl } from '@vibe/shared';
import { wsUrl } from '@/lib/ws';
import { useUi } from '@/lib/store';
import { cn } from '@/lib/utils';
import { darkTermTheme, lightTermTheme } from './theme';
import { useTerminalStore } from './store';

const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

export interface TerminalViewProps {
  projectId: string;
  termId: string;
  visible: boolean;
  /** Whether the terminal is still known to the server and running (used to decide reconnects). */
  isAlive: () => boolean;
  /** Exit code if the server already reports the process as exited. */
  knownExit: () => { exited: boolean; exitCode: number | null };
  onExit?: (exitCode: number | null) => void;
  onRestart?: () => void;
}

/**
 * One xterm instance bridged to `/ws/term/:projectId/:termId`.
 * Stays mounted while hidden so switching tabs never reconnects.
 */
export function TerminalView({ projectId, termId, visible, isAlive, knownExit, onExit, onRestart }: TerminalViewProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const termRef = React.useRef<Terminal | null>(null);
  const fitRef = React.useRef<(() => void) | null>(null);
  const theme = useUi((s) => s.theme);

  // keep callbacks fresh without re-running the connection effect
  const cb = React.useRef({ isAlive, knownExit, onExit, onRestart });
  cb.current = { isAlive, knownExit, onExit, onRestart };

  React.useEffect(() => {
    const container = containerRef.current!;
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, "Cascadia Code", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10_000,
      macOptionIsMeta: true,
      theme: useUi.getState().theme === 'dark' ? darkTermTheme : lightTermTheme,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(
      new WebLinksAddon((_e, uri) => {
        window.open(uri, '_blank', 'noopener,noreferrer');
      }),
    );
    term.open(container);
    termRef.current = term;

    const encoder = new TextEncoder();
    let ws: WebSocket | null = null;
    let disposed = false;
    let exited = false;
    let everConnected = false;
    let retry = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let gaveUp = false;
    let noticeShown = false;

    const safeFit = () => {
      if (!container.offsetWidth || !container.offsetHeight) return;
      try {
        fit.fit();
      } catch {
        /* not ready */
      }
    };
    fitRef.current = safeFit;

    const sendControl = (msg: TermControl) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    const sendResize = () => {
      if (term.cols > 0 && term.rows > 0) sendControl({ type: 'resize', cols: term.cols, rows: term.rows });
    };

    const markExited = (code: number | null) => {
      if (exited) return;
      exited = true;
      term.write(
        `\r\n${DIM}[Prozess beendet: ${code ?? '?'}]${RESET}\r\n${DIM}Enter drücken zum Neustarten – oder Tab schließen.${RESET}\r\n`,
      );
      cb.current.onExit?.(code);
    };

    const connect = () => {
      if (disposed) return;
      gaveUp = false;
      const sock = new WebSocket(wsUrl(`/ws/term/${encodeURIComponent(projectId)}/${encodeURIComponent(termId)}`));
      sock.binaryType = 'arraybuffer';
      ws = sock;

      sock.onopen = () => {
        retry = 0;
        noticeShown = false;
        // server replays the scrollback on attach → start from a clean screen on reconnect
        if (everConnected) term.reset();
        everConnected = true;
        safeFit();
        sendResize();
      };
      sock.onmessage = (e) => {
        if (typeof e.data === 'string') {
          let msg: TermControl;
          try {
            msg = JSON.parse(e.data) as TermControl;
          } catch {
            return;
          }
          if (msg.type === 'exit') markExited(msg.exitCode);
          else if (msg.type === 'error') term.write(`\r\n${RED}[Fehler: ${msg.message}]${RESET}\r\n`);
        } else {
          term.write(new Uint8Array(e.data as ArrayBuffer));
        }
      };
      sock.onclose = () => {
        if (ws !== sock) return;
        ws = null;
        if (disposed || exited) return;
        const known = cb.current.knownExit();
        if (known.exited) {
          markExited(known.exitCode);
          return;
        }
        if (!cb.current.isAlive()) return;
        if (retry >= 8) {
          gaveUp = true;
          term.write(`\r\n${RED}[Verbindung verloren]${RESET} ${DIM}Enter drücken, um erneut zu verbinden.${RESET}\r\n`);
          return;
        }
        if (!noticeShown && everConnected) {
          noticeShown = true;
          term.write(`\r\n${DIM}[Verbindung getrennt – verbinde neu…]${RESET}\r\n`);
        }
        const delay = Math.min(8000, 400 * 2 ** retry);
        retry++;
        retryTimer = setTimeout(connect, delay);
      };
    };

    const dataSub = term.onData((data) => {
      if (exited) {
        if (data === '\r') cb.current.onRestart?.();
        return;
      }
      if (gaveUp) {
        if (data === '\r') {
          retry = 0;
          connect();
        }
        return;
      }
      if (ws?.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
    });
    const binSub = term.onBinary((data) => {
      if (exited || ws?.readyState !== WebSocket.OPEN) return;
      const buf = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) buf[i] = data.charCodeAt(i) & 0xff;
      ws.send(buf);
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      sendResize();
      useTerminalStore.getState().setLastSize(cols, rows);
    });

    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(safeFit);
    });
    ro.observe(container);

    safeFit();
    connect();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      if (retryTimer) clearTimeout(retryTimer);
      ro.disconnect();
      dataSub.dispose();
      binSub.dispose();
      resizeSub.dispose();
      ws?.close();
      ws = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [projectId, termId]);

  // theme switch
  React.useEffect(() => {
    if (termRef.current) termRef.current.options.theme = theme === 'dark' ? darkTermTheme : lightTermTheme;
  }, [theme]);

  // refit + focus when becoming visible
  React.useEffect(() => {
    if (!visible) return;
    const id = requestAnimationFrame(() => {
      fitRef.current?.();
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [visible]);

  return (
    <div
      className={cn('absolute inset-0 bg-terminal', !visible && 'invisible pointer-events-none')}
      aria-hidden={!visible}
    >
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
