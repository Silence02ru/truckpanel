import { DISCORD_WEBHOOK_RE } from '@truckpanel/shared';

/**
 * Discord webhook client (docs/research/discord-webhooks.md).
 *
 * - Requests always go to https://discord.com/api/v10, built from the id/token parsed out of the
 *   user's URL. The stored URL itself is never fetched, so SSRF is impossible by construction.
 * - One queue per webhook id: Discord rate-limits per webhook, so two servers sharing a URL share
 *   a bucket. X-RateLimit-Remaining/Reset-After are respected before the next request; 429 waits
 *   retry_after (global 429 pauses everything).
 * - Never put the token or the URL into errors or logs; only the webhook id.
 */
export interface WebhookRef {
  id: string;
  token: string;
}

export function parseWebhookUrl(url: string): WebhookRef | null {
  const m = DISCORD_WEBHOOK_RE.exec(url.trim());
  return m ? { id: m[1]!, token: m[2]! } : null;
}

export type DiscordErrorKind = 'webhook_invalid' | 'message_missing' | 'rejected' | 'rate_limited' | 'unavailable';

export class DiscordError extends Error {
  constructor(
    readonly kind: DiscordErrorKind,
    readonly status: number,
    /** Discord JSON error code, when present. */
    readonly code: number | null,
  ) {
    super(`Discord ${kind} (HTTP ${status}${code ? `, code ${code}` : ''})`);
  }
}

// JSON error codes: https://docs.discord.com/developers/topics/opcodes-and-status-codes
const UNKNOWN_MESSAGE = 10008;
const UNKNOWN_WEBHOOK = 10015;
const INVALID_WEBHOOK_TOKEN = 50027;

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface DiscordClientOptions {
  fetchFn?: FetchFn;
  maxRetries?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const API = 'https://discord.com/api/v10';
const MAX_WAIT_MS = 60_000;

export class DiscordClient {
  private readonly fetchFn: FetchFn;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly blockedUntil = new Map<string, number>();
  private globalBlockedUntil = 0;

  constructor(opts: DiscordClientOptions = {}) {
    this.fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchFn);
    this.maxRetries = opts.maxRetries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref()));
    this.now = opts.now ?? Date.now;
  }

  /** Posts a message and returns its id (`?wait=true` makes Discord return the message). */
  async create(ref: WebhookRef, body: object): Promise<string> {
    const res = await this.request(ref, 'POST', '?wait=true', body, false);
    const id = (JSON.parse(res) as { id?: unknown }).id;
    if (typeof id !== 'string') throw new DiscordError('rejected', 200, null);
    return id;
  }

  async edit(ref: WebhookRef, messageId: string, body: object): Promise<void> {
    await this.request(ref, 'PATCH', `/messages/${encodeURIComponent(messageId)}`, body, true);
  }

  /** Deleting a message that is already gone is not an error. */
  async remove(ref: WebhookRef, messageId: string): Promise<void> {
    try {
      await this.request(ref, 'DELETE', `/messages/${encodeURIComponent(messageId)}`, undefined, true);
    } catch (e) {
      if (e instanceof DiscordError && e.kind === 'message_missing') return;
      throw e;
    }
  }

  private request(ref: WebhookRef, method: string, path: string, body: object | undefined, messagePath: boolean): Promise<string> {
    const prev = this.queues.get(ref.id) ?? Promise.resolve();
    const run = prev.then(
      () => this.send(ref, method, path, body, messagePath),
      () => this.send(ref, method, path, body, messagePath),
    );
    const tail = run.catch(() => undefined);
    this.queues.set(ref.id, tail);
    void tail.then(() => {
      if (this.queues.get(ref.id) === tail) this.queues.delete(ref.id);
    });
    return run;
  }

  private async send(ref: WebhookRef, method: string, path: string, body: object | undefined, messagePath: boolean): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const wait = Math.max(this.globalBlockedUntil, this.blockedUntil.get(ref.id) ?? 0) - this.now();
      if (wait > 0) await this.sleep(Math.min(wait, MAX_WAIT_MS));

      let res: Awaited<ReturnType<FetchFn>>;
      try {
        res = await this.fetchFn(`${API}/webhooks/${ref.id}/${ref.token}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'TruckPanel (self-hosted, 1.0)' },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        throw new DiscordError('unavailable', 0, null);
      }
      const text = await res.text().catch(() => '');
      this.track(ref.id, res.headers);

      if (res.status >= 200 && res.status < 300) return text;

      const json = safeJson(text);
      const code = typeof json?.code === 'number' ? json.code : null;
      if (res.status === 429) {
        const retryMs = Math.ceil((typeof json?.retry_after === 'number' ? json.retry_after : 1) * 1000);
        const until = this.now() + retryMs;
        if (json?.global === true) this.globalBlockedUntil = until;
        else this.blockedUntil.set(ref.id, until);
        if (attempt < this.maxRetries && retryMs <= MAX_WAIT_MS) continue;
        throw new DiscordError('rate_limited', 429, code);
      }
      if (res.status === 404) {
        if (code === UNKNOWN_MESSAGE) throw new DiscordError('message_missing', 404, code);
        if (code === UNKNOWN_WEBHOOK || code === INVALID_WEBHOOK_TOKEN) throw new DiscordError('webhook_invalid', 404, code);
        // No JSON code: on a message route the message is the likely missing part (legacy behaviour).
        throw new DiscordError(messagePath ? 'message_missing' : 'webhook_invalid', 404, code);
      }
      if (res.status === 401 || res.status === 403) throw new DiscordError('webhook_invalid', res.status, code);
      if (res.status >= 500) throw new DiscordError('unavailable', res.status, code);
      throw new DiscordError('rejected', res.status, code);
    }
  }

  private track(id: string, headers: { get(name: string): string | null }): void {
    const remaining = headers.get('x-ratelimit-remaining');
    const resetAfter = Number(headers.get('x-ratelimit-reset-after'));
    if (remaining === '0' && Number.isFinite(resetAfter) && resetAfter > 0) {
      this.blockedUntil.set(id, this.now() + Math.ceil(resetAfter * 1000));
    }
  }
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
