import fs from 'node:fs/promises';
import type { ListeningPort } from '@vibe/shared';

const TCP_LISTEN = '0A';

function ipv4FromHex(hex: string): string {
  // /proc stores the address as a little-endian 32-bit word.
  const bytes = [];
  for (let i = 6; i >= 0; i -= 2) bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  return bytes.join('.');
}

function ipv6FromHex(hex: string): string {
  // Four little-endian 32-bit words.
  const bytes: number[] = [];
  for (let w = 0; w < 4; w++) {
    const word = hex.slice(w * 8, w * 8 + 8);
    for (let i = 6; i >= 0; i -= 2) bytes.push(Number.parseInt(word.slice(i, i + 2), 16));
  }
  // IPv4-mapped (::ffff:a.b.c.d)
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return `::ffff:${bytes.slice(12).join('.')}`;
  }
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)).toString(16));
  // Compress the longest run of zero groups.
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== '0') { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > bestLen && j - i > 1) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  if (bestStart === -1) return groups.join(':');
  return `${groups.slice(0, bestStart).join(':')}::${groups.slice(bestStart + bestLen).join(':')}`;
}

/** Parses the content of /proc/net/tcp or /proc/net/tcp6 and returns LISTEN sockets. */
export function parseProcNetTcp(content: string): ListeningPort[] {
  const out: ListeningPort[] = [];
  const lines = content.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const local = cols[1]!;
    const state = cols[3]!;
    if (state.toUpperCase() !== TCP_LISTEN) continue;
    const idx = local.lastIndexOf(':');
    if (idx < 0) continue;
    const addrHex = local.slice(0, idx);
    const port = Number.parseInt(local.slice(idx + 1), 16);
    if (!Number.isFinite(port) || port <= 0) continue;
    let address: string;
    if (addrHex.length === 8) address = ipv4FromHex(addrHex);
    else if (addrHex.length === 32) address = ipv6FromHex(addrHex);
    else continue;
    out.push({ port, address });
  }
  return out;
}

const WILDCARDS = new Set(['0.0.0.0', '::']);

// Docker's embedded DNS resolver listens on 127.0.0.11 inside user-defined networks.
const IGNORED_ADDRESSES = new Set(['127.0.0.11']);

/** Dedupes by port (preferring wildcard binds), removes excluded ports, sorts ascending. */
export function uniquePorts(entries: ListeningPort[], exclude: number[] = []): ListeningPort[] {
  const byPort = new Map<number, ListeningPort>();
  for (const e of entries) {
    if (exclude.includes(e.port) || IGNORED_ADDRESSES.has(e.address)) continue;
    const prev = byPort.get(e.port);
    if (!prev || (!WILDCARDS.has(prev.address) && WILDCARDS.has(e.address))) byPort.set(e.port, e);
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

export async function listListeningPorts(exclude: number[]): Promise<ListeningPort[]> {
  if (process.platform !== 'linux') return [];
  const all: ListeningPort[] = [];
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      all.push(...parseProcNetTcp(await fs.readFile(file, 'utf8')));
    } catch {
      /* tcp6 may be absent */
    }
  }
  return uniquePorts(all, exclude);
}

export function portsKey(ports: ListeningPort[]): string {
  return ports.map((p) => `${p.address}:${p.port}`).join(',');
}

/** Polls listening ports and calls onChange when the set changes. */
export class PortWatcher {
  private timer: NodeJS.Timeout | undefined;
  private current: ListeningPort[] = [];
  private key = '';

  constructor(
    private readonly exclude: number[],
    private readonly onChange: (ports: ListeningPort[]) => void,
    private readonly intervalMs = 2000,
  ) {}

  async start(): Promise<void> {
    await this.poll(false);
    this.timer = setInterval(() => void this.poll(true), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  get ports(): ListeningPort[] {
    return this.current;
  }

  async refresh(): Promise<ListeningPort[]> {
    await this.poll(true);
    return this.current;
  }

  private async poll(notify: boolean): Promise<void> {
    try {
      const ports = await listListeningPorts(this.exclude);
      const key = portsKey(ports);
      if (key !== this.key) {
        this.key = key;
        this.current = ports;
        if (notify) this.onChange(ports);
      }
    } catch (err) {
      console.error('[wsd] port poll failed', err);
    }
  }
}
