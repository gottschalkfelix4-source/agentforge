import {
  File,
  FileArchive,
  FileCode2,
  FileCog,
  FileImage,
  FileJson,
  FileLock,
  FileText,
  FileTerminal,
  Folder,
  FolderOpen,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const CODE = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'py', 'go', 'rs', 'java', 'kt', 'rb', 'php', 'c', 'cpp', 'h', 'hpp', 'cs', 'swift', 'vue', 'svelte', 'astro', 'html', 'css', 'scss', 'less', 'sql', 'dart', 'lua']);
const IMG = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif']);
const ARCHIVE = new Set(['zip', 'tar', 'gz', 'tgz', 'rar', '7z']);
const TEXT = new Set(['md', 'mdx', 'txt', 'rst', 'log']);
const CONFIG = new Set(['yml', 'yaml', 'toml', 'ini', 'env', 'conf', 'config']);

const COLOR: Record<string, string> = {
  ts: 'text-sky-500',
  tsx: 'text-sky-500',
  mts: 'text-sky-500',
  js: 'text-yellow-500',
  jsx: 'text-yellow-500',
  mjs: 'text-yellow-500',
  cjs: 'text-yellow-500',
  json: 'text-amber-500',
  py: 'text-emerald-500',
  go: 'text-cyan-500',
  rs: 'text-orange-500',
  html: 'text-orange-500',
  css: 'text-blue-400',
  scss: 'text-pink-400',
  md: 'text-muted-foreground',
  vue: 'text-emerald-500',
  svelte: 'text-orange-500',
};

export function FileIcon({ name, dir, open, className }: { name: string; dir?: boolean; open?: boolean; className?: string }) {
  if (dir) {
    const Icon = open ? FolderOpen : Folder;
    return <Icon className={cn('size-4 shrink-0 text-muted-foreground', className)} />;
  }
  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  let Icon: LucideIcon = File;
  if (lower.endsWith('.lock') || lower === 'pnpm-lock.yaml' || lower === 'package-lock.json') Icon = FileLock;
  else if (ext === 'json') Icon = FileJson;
  else if (CODE.has(ext)) Icon = FileCode2;
  else if (IMG.has(ext)) Icon = FileImage;
  else if (ARCHIVE.has(ext)) Icon = FileArchive;
  else if (TEXT.has(ext)) Icon = FileText;
  else if (ext === 'sh' || ext === 'bash' || ext === 'zsh') Icon = FileTerminal;
  else if (CONFIG.has(ext) || lower.startsWith('.') || lower === 'dockerfile' || lower === 'makefile') Icon = FileCog;
  return <Icon className={cn('size-4 shrink-0', COLOR[ext] ?? 'text-muted-foreground', className)} />;
}
