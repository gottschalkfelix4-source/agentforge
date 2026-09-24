import type { AppContext } from '../app-context.js';
import type { ProviderRecord } from '../routes/providers.js';
import { HttpError } from '../workspaces/manager.js';
import { ChatGptAuth, needsRefresh, type ChatGptTokens } from './auth.js';

/** Tokens handed to a launch: valid for at least this long (capped at half the token lifetime). */
export const LAUNCH_MIN_VALID_MS = 24 * 3_600_000;

/**
 * ChatGPT subscription providers: the login lives (encrypted) as the provider's secret and is refreshed
 * here only — one refresh at a time per provider, the rotated refresh token is stored right away.
 */
export class ChatGptService {
  readonly auth: ChatGptAuth;
  private readonly inflight = new Map<string, Promise<ChatGptTokens>>();

  constructor(
    private readonly ctx: AppContext,
    auth?: ChatGptAuth,
  ) {
    this.auth = auth ?? new ChatGptAuth();
  }

  stored(p: ProviderRecord): ChatGptTokens | null {
    if (p.kind !== 'openai_chatgpt' || !p.secretId) return null;
    const raw = this.ctx.secrets.get(p.secretId);
    if (!raw) return null;
    try {
      const t = JSON.parse(raw) as ChatGptTokens;
      return t.accessToken && t.refreshToken && t.accountId ? t : null;
    } catch {
      return null;
    }
  }

  /** Current tokens of a provider, refreshed when less than `minValidMs` remain. */
  async tokens(p: ProviderRecord, minValidMs = 5 * 60_000): Promise<ChatGptTokens> {
    const t = this.stored(p);
    if (!t) throw new HttpError(400, 'chatgpt_not_logged_in', `Provider „${p.name}“ ist nicht bei ChatGPT angemeldet (Einstellungen → Provider)`);
    if (!needsRefresh(t, Date.now(), minValidMs)) return t;
    let run = this.inflight.get(p.id);
    if (!run) {
      run = (async () => {
        // Re-read inside the flight: another refresh may just have rotated the token.
        const current = this.stored(p) ?? t;
        if (!needsRefresh(current, Date.now(), minValidMs)) return current;
        const fresh = await this.auth.refresh(current);
        this.ctx.secrets.replace(p.secretId!, JSON.stringify(fresh));
        return fresh;
      })().finally(() => this.inflight.delete(p.id));
      this.inflight.set(p.id, run);
    }
    return run;
  }
}

const instances = new WeakMap<AppContext, ChatGptService>();

export function chatgptService(ctx: AppContext): ChatGptService {
  let s = instances.get(ctx);
  if (!s) {
    s = new ChatGptService(ctx);
    instances.set(ctx, s);
  }
  return s;
}
