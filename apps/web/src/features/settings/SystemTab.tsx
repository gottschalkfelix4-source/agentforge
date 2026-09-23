import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, CloudDownload, DatabaseBackup, Download, RefreshCw, Timer, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { request } from '@/lib/api';
import { useMe, useSystem } from '@/lib/queries';
import { errorMessage } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { SectionHeader } from './common';

// ---- API (GET/PUT /api/system/*, see docs/api.md "System / Betrieb") --------------------

interface ImageInfo {
  name: string;
  present: boolean;
  id: string | null;
  digest: string | null;
  created: string | null;
  sizeBytes: number | null;
  version: string | null;
}

interface PullState {
  state: 'idle' | 'pulling' | 'done' | 'error';
  image: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: string | null;
  error: string | null;
  updated: boolean | null;
}

interface SystemSettings {
  workspaceIdleMinutes: number;
  workspaceIdleMinutesStored: number | null;
  workspaceIdleMinutesEnv: number;
}

interface SystemDetails {
  version: string;
  nodeVersion: string;
  startedAt: string;
  uptimeSec: number;
  dataDir: string;
  hostDataPath: string;
  inContainer: boolean;
  previewMode: 'port' | 'subdomain';
  previewDomain: string | null;
  secretKeyFromEnv: boolean;
  docker: { ok: boolean; error: string | null };
  workspaceImage: ImageInfo;
  outdatedWorkspaces: number;
  workspaces: { total: number; running: number; connected: number };
  disk: { totalBytes: number; entries: { name: string; bytes: number }[]; partial: boolean; computedAt: string };
  idle: SystemSettings;
  pull: PullState;
}

const infoKey = ['system', 'info'] as const;
const pullKey = ['system', 'pull'] as const;

function useSystemDetails() {
  return useQuery({ queryKey: infoKey, queryFn: () => request<SystemDetails>('/system/info'), staleTime: 30_000 });
}

// ---- helpers ------------------------------------------------------------------------------

function formatSize(n: number | null | undefined): string {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} T ${h} Std`;
  if (h > 0) return `${h} Std ${m} Min`;
  return `${m} Min`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('de-DE');
}

function Row({ label, ok, children }: { label: string; ok?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-b border-border py-2.5 last:border-b-0">
      <span className="w-44 shrink-0 text-sm text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-2 text-sm">
        {ok === true && <CheckCircle2 className="size-4 shrink-0 text-success" />}
        {ok === false && <XCircle className="size-4 shrink-0 text-destructive" />}
        <span className="min-w-0 break-all">{children}</span>
      </span>
    </div>
  );
}

const Mono = ({ children }: { children: React.ReactNode }) => <code className="font-mono text-[13px]">{children}</code>;

function RowsSkeleton() {
  return (
    <div className="grid gap-3 py-3">
      <Skeleton className="h-5 w-2/3" />
      <Skeleton className="h-5 w-1/2" />
      <Skeleton className="h-5 w-1/3" />
    </div>
  );
}

// ---- sections -----------------------------------------------------------------------------

function StatusSection() {
  const system = useSystem();
  const details = useSystemDetails();
  const me = useMe();
  const d = details.data;

  const refresh = () => {
    void system.refetch();
    void details.refetch();
  };

  return (
    <div>
      <SectionHeader
        title="System"
        description="Status des Servers und der Docker-Umgebung."
        action={
          <Button variant="outline" size="sm" onClick={refresh} disabled={system.isFetching || details.isFetching}>
            <RefreshCw className={system.isFetching || details.isFetching ? 'animate-spin' : ''} /> Aktualisieren
          </Button>
        }
      />
      <Card>
        <CardContent className="py-1">
          {system.isPending ? (
            <RowsSkeleton />
          ) : system.isError ? (
            <p className="py-3 text-sm text-destructive">{errorMessage(system.error)}</p>
          ) : (
            <>
              <Row label="Docker" ok={system.data.dockerOk}>
                {system.data.dockerOk ? 'Verbunden' : (system.data.dockerError ?? 'Nicht erreichbar')}
              </Row>
              <Row label="Version">
                <Mono>{system.data.version}</Mono>
                {d && <span className="ml-2 text-xs text-muted-foreground">Node {d.nodeVersion}</span>}
              </Row>
              {d && (
                <>
                  <Row label="Laufzeit">
                    {formatUptime(d.uptimeSec)}
                    <span className="ml-2 text-xs text-muted-foreground">seit {formatDate(d.startedAt)}</span>
                  </Row>
                  <Row label="Workspaces">
                    {d.workspaces.running} laufend / {d.workspaces.total} gesamt
                  </Row>
                  <Row label="Datenverzeichnis">
                    <Mono>{d.dataDir}</Mono>
                  </Row>
                  <Row label="HOST_DATA_PATH" ok={d.inContainer ? d.hostDataPath !== d.dataDir : undefined}>
                    <Mono>{d.hostDataPath}</Mono>
                    {d.inContainer && d.hostDataPath === d.dataDir && (
                      <span className="ml-2 text-xs text-destructive">
                        entspricht dem Container-Pfad – muss der Pfad auf dem Docker-Host sein
                      </span>
                    )}
                  </Row>
                  <Row label="Live-Preview">
                    {d.previewMode === 'subdomain' ? `Subdomain (*.${d.previewDomain ?? '?'})` : 'Ports'}
                  </Row>
                  <Row label="Secret-Key" ok={d.secretKeyFromEnv}>
                    {d.secretKeyFromEnv ? 'aus VIBE_SECRET_KEY' : 'Datei secret.key im Datenverzeichnis'}
                  </Row>
                </>
              )}
              <Row label="Angemeldet als">{me.data?.username ?? '—'}</Row>
            </>
          )}
          {details.isError && <p className="py-3 text-sm text-destructive">{errorMessage(details.error)}</p>}
        </CardContent>
      </Card>
    </div>
  );
}

function DiskSection() {
  const qc = useQueryClient();
  const details = useSystemDetails();
  const [refreshing, setRefreshing] = React.useState(false);
  const d = details.data;

  const recompute = async () => {
    setRefreshing(true);
    try {
      const fresh = await request<SystemDetails>('/system/info', { query: { refresh: 1 } });
      qc.setQueryData(infoKey, fresh);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div>
      <SectionHeader
        title="Speicherbelegung"
        description="Größe des Datenverzeichnisses (Datenbank, Projekte, Agent-Logins, Caches)."
        action={
          <Button variant="outline" size="sm" onClick={() => void recompute()} disabled={refreshing || !d}>
            <RefreshCw className={refreshing ? 'animate-spin' : ''} /> Neu berechnen
          </Button>
        }
      />
      <Card>
        <CardContent className="py-1">
          {!d ? (
            <RowsSkeleton />
          ) : (
            <>
              <Row label="Gesamt">
                <span className="font-medium">{formatSize(d.disk.totalBytes)}</span>
                {d.disk.partial && (
                  <span className="ml-2 text-xs text-muted-foreground">(mindestens – Zählung wurde begrenzt)</span>
                )}
              </Row>
              {d.disk.entries.slice(0, 8).map((e) => (
                <Row key={e.name} label={e.name}>
                  {formatSize(e.bytes)}
                </Row>
              ))}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ImageSection() {
  const qc = useQueryClient();
  const details = useSystemDetails();
  const pull = useQuery({
    queryKey: pullKey,
    queryFn: () => request<PullState>('/system/pull-image'),
    refetchInterval: (q) => (q.state.data?.state === 'pulling' ? 1500 : false),
  });
  const start = useMutation({
    mutationFn: () => request<PullState>('/system/pull-image', { method: 'POST' }),
    onSuccess: (s) => {
      qc.setQueryData(pullKey, s);
      if (s.state === 'error') toast.error(s.error ?? 'Fehler beim Aktualisieren');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  // Refresh image details when a pull finishes.
  const prevState = React.useRef(pull.data?.state);
  React.useEffect(() => {
    const s = pull.data?.state;
    if (prevState.current === 'pulling' && s && s !== 'pulling') {
      void qc.invalidateQueries({ queryKey: infoKey });
      void qc.invalidateQueries({ queryKey: ['system'] });
      if (s === 'done') toast.success(pull.data?.updated ? 'Neues Workspace-Image geladen' : 'Workspace-Image ist bereits aktuell');
      if (s === 'error') toast.error(pull.data?.error ?? 'Fehler beim Aktualisieren');
    }
    prevState.current = s;
  }, [pull.data, qc]);

  const img = details.data?.workspaceImage;
  const p = pull.data;
  const pulling = p?.state === 'pulling' || start.isPending;
  const outdated = details.data?.outdatedWorkspaces ?? 0;

  return (
    <div>
      <SectionHeader
        title="Workspace-Image"
        description="Image, aus dem alle Projekt-Workspaces erzeugt werden (Toolchain + Agent-CLIs)."
        action={
          <Button variant="outline" size="sm" onClick={() => start.mutate()} disabled={pulling}>
            <CloudDownload className={pulling ? 'animate-pulse' : ''} /> Workspace-Image aktualisieren
          </Button>
        }
      />
      <Card>
        <CardContent className="py-1">
          {!details.data ? (
            <RowsSkeleton />
          ) : (
            <>
              <Row label="Image" ok={img?.present}>
                <Mono>{img?.name}</Mono>
                {!img?.present && (
                  <span className="ml-2 text-xs text-muted-foreground">(nicht vorhanden – wird beim ersten Start gezogen)</span>
                )}
              </Row>
              {img?.present && (
                <>
                  <Row label="Erstellt">
                    {formatDate(img.created)}
                    {img.version && <span className="ml-2 text-xs text-muted-foreground">Version {img.version}</span>}
                  </Row>
                  <Row label="Größe">{formatSize(img.sizeBytes)}</Row>
                  <Row label="Digest">
                    <Mono>{img.digest ? img.digest.split('@')[1] : (img.id ?? '—')}</Mono>
                    {!img.digest && <span className="ml-2 text-xs text-muted-foreground">(lokal gebaut)</span>}
                  </Row>
                </>
              )}
              {p && p.state !== 'idle' && (
                <Row label="Aktualisierung" ok={p.state === 'done' ? true : p.state === 'error' ? false : undefined}>
                  {p.state === 'pulling' && <span className="text-muted-foreground">Wird geladen … {p.progress}</span>}
                  {p.state === 'done' && (p.updated ? 'Neue Version geladen' : 'Bereits aktuell')}
                  {p.state === 'error' && <span className="text-destructive">{p.error}</span>}
                </Row>
              )}
            </>
          )}
        </CardContent>
      </Card>
      <p className="mt-2 text-xs text-muted-foreground">
        Bestehende Workspaces nutzen das neue Image erst nach <strong>„Neu erstellen“</strong> im jeweiligen Projekt
        (Dateien und Agent-Logins bleiben erhalten).
        {outdated > 0 && (
          <Badge variant="warning" className="ml-2">
            {outdated} Workspace{outdated === 1 ? '' : 's'} mit altem Image
          </Badge>
        )}
      </p>
    </div>
  );
}

function IdleSection() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['system', 'settings'], queryFn: () => request<SystemSettings>('/system/settings') });
  const [value, setValue] = React.useState('');
  React.useEffect(() => {
    if (settings.data) setValue(String(settings.data.workspaceIdleMinutes));
  }, [settings.data]);

  const save = useMutation({
    mutationFn: (minutes: number | null) =>
      request<SystemSettings>('/system/settings', { method: 'PUT', body: { workspaceIdleMinutes: minutes } }),
    onSuccess: (s) => {
      qc.setQueryData(['system', 'settings'], s);
      void qc.invalidateQueries({ queryKey: infoKey });
      toast.success(s.workspaceIdleMinutes > 0 ? `Auto-Stopp nach ${s.workspaceIdleMinutes} Minuten` : 'Auto-Stopp deaktiviert');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const parsed = value.trim() === '' ? NaN : Number(value);
  const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= 10080;
  const s = settings.data;

  return (
    <div>
      <SectionHeader title="Automatisch stoppen" description="Spart RAM/CPU: inaktive Workspaces werden angehalten." />
      <Card>
        <CardContent className="grid gap-3 py-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Timer className="size-4 text-muted-foreground" />
            <span>Workspace stoppen nach</span>
            <Input
              className="w-20"
              inputMode="numeric"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-invalid={value !== '' && !valid}
              disabled={!s}
            />
            <span>Minuten Inaktivität</span>
            <Button size="sm" onClick={() => save.mutate(parsed)} disabled={!valid || save.isPending || !s}>
              Speichern
            </Button>
            {s?.workspaceIdleMinutesStored != null && (
              <Button size="sm" variant="ghost" onClick={() => save.mutate(null)} disabled={save.isPending}>
                Standard ({s.workspaceIdleMinutesEnv || 'aus'})
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            0 = aus. Inaktiv heißt: keine laufende Agent-Sitzung und kein Terminal mit laufendem Prozess (offene Shells
            zählen als aktiv). Gestoppte Workspaces lassen sich im Projekt mit „Starten“ wieder hochfahren. Standardwert per
            Umgebungsvariable <code className="font-mono">WORKSPACE_IDLE_MINUTES</code>.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function BackupSection() {
  const [withProjects, setWithProjects] = React.useState(false);
  const details = useSystemDetails();
  const href = `/api/system/backup${withProjects ? '?projects=1' : ''}`;

  return (
    <div>
      <SectionHeader title="Backup" description="Export als .tar.gz – Anleitung zur Wiederherstellung in docs/backup.md." />
      <Card>
        <CardContent className="grid gap-3 py-4">
          <div className="flex flex-wrap items-center gap-4">
            <a href={href} download className={buttonVariants({ variant: 'outline' })}>
              <Download /> Backup herunterladen
            </a>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={withProjects} onChange={(e) => setWithProjects(e.target.checked)} />
              inkl. Projektdateien
            </label>
          </div>
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <DatabaseBackup className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Enthält einen konsistenten Snapshot der Datenbank (Projekte, Sitzungen, Aufgaben, verschlüsselte Secrets)
              {withProjects && ' und alle Projektordner ohne node_modules/.venv o. ä.'}. Agent-Logins und Caches sind nicht
              enthalten.
            </span>
          </p>
          {details.data && !details.data.secretKeyFromEnv && (
            <p className="flex items-start gap-2 text-xs text-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>
                Das Backup enthält die Schlüsseldatei <code className="font-mono">secret.key</code> – damit lassen sich alle
                gespeicherten API-Keys entschlüsseln. Sicher aufbewahren.
              </span>
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function SystemTab() {
  const me = useMe();

  return (
    <div className="grid gap-6">
      {me.data && !me.data.secretKeyFromEnv && (
        <Card className="border-warning/40 bg-warning/5">
          <CardHeader className="flex-row items-start gap-3">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />
            <div>
              <CardTitle>VIBE_SECRET_KEY ist nicht gesetzt</CardTitle>
              <CardDescription className="mt-1">
                Der Schlüssel zum Verschlüsseln von API-Keys wurde automatisch erzeugt und im Datenverzeichnis abgelegt.
                Setze <code className="rounded bg-muted px-1 font-mono">VIBE_SECRET_KEY</code> als Umgebungsvariable, damit
                gespeicherte Secrets nicht mit den Daten zusammen liegen und Backups/Umzüge sicher bleiben.
              </CardDescription>
            </div>
          </CardHeader>
        </Card>
      )}
      <StatusSection />
      <ImageSection />
      <IdleSection />
      <BackupSection />
      <DiskSection />
    </div>
  );
}
