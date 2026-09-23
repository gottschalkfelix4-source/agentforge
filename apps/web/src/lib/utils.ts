import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unbekannter Fehler';
}

/** Join workspace-relative paths ("." is the root). */
export function joinPath(dir: string, name: string): string {
  if (!dir || dir === '.' || dir === '/') return name;
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '.' : path.slice(0, i);
}

export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
