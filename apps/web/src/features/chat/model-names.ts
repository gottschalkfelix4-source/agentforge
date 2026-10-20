/**
 * Readable names for model ids as providers list them ("~anthropic/claude-opus-latest",
 * "deepseek/deepseek-v4.1-flash:free", "claude-opus-4-1-20250805"): vendor, name and tags.
 */
export interface ModelLabel {
  id: string;
  /** "Claude Opus 4.1", "DeepSeek V4.1 Flash" */
  name: string;
  /** "Anthropic" for "anthropic/…"; null for ids without a vendor prefix. */
  vendor: string | null;
  /** "neueste Version", "kostenlos", a release date … */
  tags: string[];
}

const VENDORS: Record<string, string> = {
  ai21: 'AI21',
  amazon: 'Amazon',
  anthropic: 'Anthropic',
  'arcee-ai': 'Arcee AI',
  baidu: 'Baidu',
  bytedance: 'ByteDance',
  'bytedance-seed': 'ByteDance Seed',
  cohere: 'Cohere',
  deepseek: 'DeepSeek',
  google: 'Google',
  ibm: 'IBM',
  inception: 'Inception',
  liquid: 'Liquid',
  'meta-llama': 'Meta',
  microsoft: 'Microsoft',
  minimax: 'MiniMax',
  mistral: 'Mistral AI',
  mistralai: 'Mistral AI',
  moonshotai: 'Moonshot AI',
  nousresearch: 'Nous Research',
  nvidia: 'NVIDIA',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  perplexity: 'Perplexity',
  qwen: 'Qwen',
  tencent: 'Tencent',
  'x-ai': 'xAI',
  xai: 'xAI',
  'z-ai': 'Z.ai',
};

const WORDS: Record<string, string> = {
  ai: 'AI',
  deepseek: 'DeepSeek',
  glm: 'GLM',
  gpt: 'GPT',
  minimax: 'MiniMax',
  oss: 'OSS',
  vl: 'VL',
};

const SUFFIX_TAGS: Record<string, string> = { free: 'kostenlos', thinking: 'Thinking', beta: 'Beta', extended: 'erweitert' };

const LATEST = 'neueste Version';

function vendorName(slug: string): string {
  return VENDORS[slug] ?? slug.replace(/(^|[-_])(\w)/g, (_m, sep: string, c: string) => (sep ? ' ' : '') + c.toUpperCase());
}

function word(token: string): string {
  const lower = token.toLowerCase();
  if (WORDS[lower]) return WORDS[lower];
  if (/^\d+(\.\d+)?[bkm]$/.test(lower)) return lower.toUpperCase(); // 70b → 70B
  if (/^v\d/.test(lower)) return 'V' + token.slice(1); // v4.1 → V4.1
  if (/^\d/.test(token)) return token; // 4o, 3.5
  return token.charAt(0).toUpperCase() + token.slice(1);
}

export function describeModel(rawId: string): ModelLabel {
  const tags: string[] = [];
  let rest = rawId.trim();
  if (rest.startsWith('~')) {
    rest = rest.slice(1);
    tags.push(LATEST);
  }

  const colon = rest.lastIndexOf(':');
  if (colon > 0 && !rest.slice(colon + 1).includes('/')) {
    const suffix = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (suffix) tags.push(SUFFIX_TAGS[suffix.toLowerCase()] ?? suffix);
  }

  let vendor: string | null = null;
  const slash = rest.indexOf('/');
  if (slash > 0) {
    vendor = vendorName(rest.slice(0, slash).toLowerCase());
    rest = rest.slice(slash + 1);
  }

  const tokens = rest.split(/[-_\s]+/).filter(Boolean);
  const parts: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const lower = t.toLowerCase();
    if (lower === 'latest') {
      if (!tags.includes(LATEST)) tags.push(LATEST);
      continue;
    }
    // Release dates: 20250805 or 2024-08-06.
    if (/^20\d{6}$/.test(t)) {
      tags.push(`${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6)}`);
      continue;
    }
    if (/^20\d\d$/.test(t) && /^\d\d$/.test(tokens[i + 1] ?? '') && /^\d\d$/.test(tokens[i + 2] ?? '')) {
      tags.push(`${t}-${tokens[i + 1]}-${tokens[i + 2]}`);
      i += 2;
      continue;
    }
    const prev = parts[parts.length - 1];
    // Version numbers split by dashes: claude-opus-4-1 → "Opus 4.1"; gpt-5 → "GPT-5".
    if (/^\d{1,2}$/.test(t) && prev && /^\d+(\.\d+)*$/.test(prev) && /^\d{1,2}$/.test(tokens[i - 1] ?? '')) {
      parts[parts.length - 1] = `${prev}.${t}`;
      continue;
    }
    if (/^\d/.test(t) && prev === 'GPT') {
      parts[parts.length - 1] = `GPT-${t}`;
      continue;
    }
    parts.push(word(t));
  }

  return { id: rawId, name: parts.join(' ') || rawId, vendor, tags };
}
