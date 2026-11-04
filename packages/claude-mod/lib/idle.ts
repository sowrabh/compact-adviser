// What automatic mode does once the person has walked away: compact a finished session while
// its prompt cache is still warm, or keep an unfinished one's cache warm so their next turn
// does not resend the whole context uncached. Nothing here touches the engine.

const MINUTE = 60_000;
export const LONG_TTL_MS = 60 * MINUTE;
export const SHORT_TTL_MS = 5 * MINUTE;
/** How long before the cache would lapse the idle point fires, at most. */
export const IDLE_MARGIN_MS = 10 * MINUTE;
/** A keep-warm ping is a cache hit only when the cache served at least this share of it. */
export const CACHE_HIT_SHARE = 0.9;
/** The one line a keep-warm ping sends; the fork's reply is shown to nobody. */
export const KEEP_WARM_PROMPT = "Reply with exactly: OK";

export interface CacheTtl {
  ttlMs: number;
  /** False when nothing says which TTL the engine uses and the 1 h fallback stands in. */
  known: boolean;
  /** False when prompt caching is off, so there is no cache to keep warm. */
  caching: boolean;
}

function flag(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

/**
 * The prompt-cache TTL Claude Code writes with: its own switches first, then a subscription
 * (rate-limit windows on the latest reply), which writes 1 h entries. Anything else is unknown
 * and takes the 1 h fallback.
 */
export function cacheTtl(signals: {
  force5m?: string;
  enable1h?: string;
  disabled?: string;
  subscription: boolean;
}): CacheTtl {
  if (flag(signals.disabled)) return { ttlMs: LONG_TTL_MS, known: false, caching: false };
  if (flag(signals.force5m)) return { ttlMs: SHORT_TTL_MS, known: true, caching: true };
  if (flag(signals.enable1h) || signals.subscription) {
    return { ttlMs: LONG_TTL_MS, known: true, caching: true };
  }
  return { ttlMs: LONG_TTL_MS, known: false, caching: true };
}

/**
 * How long after a settled answer the idle point comes: the person's `idleMinutes` when set,
 * otherwise just before the cache lapses (50 min on a 1 h cache, 4 min on a 5 min one).
 */
export function idleDelayMs(ttl: CacheTtl, idleMinutes: number): number {
  if (idleMinutes > 0) return idleMinutes * MINUTE;
  return ttl.ttlMs - Math.min(IDLE_MARGIN_MS, ttl.ttlMs / 5);
}

export type WalkAway =
  | { action: "compact" }
  | { action: "warm" }
  | { action: "none"; reason: string };

/**
 * The walk-away decision at the idle point. A turn-end score at or above the idle bar (the
 * floor schedule's loosest point) compacts once; anything else, including no judgment at all,
 * never compacts and may only keep the cache warm.
 */
export function walkAwayAction(input: {
  auto: boolean;
  tokens: number | undefined;
  minContextTokens: number;
  score: number | undefined;
  idleFloor: number;
  completed: number;
  caching: boolean;
  keepWarmHours: number;
  idleSince: number;
  now: number;
}): WalkAway {
  if (!input.auto) return { action: "none", reason: "automatic mode is not confirmed" };
  if (input.tokens === undefined || input.tokens < input.minContextTokens) {
    return { action: "none", reason: "context is below the minimum" };
  }
  if (input.score !== undefined && input.score >= input.idleFloor) return { action: "compact" };
  if (input.keepWarmHours <= 0) return { action: "none", reason: "keep-warm is off" };
  if (!input.caching) return { action: "none", reason: "prompt caching is off" };
  if (input.completed < 2) return { action: "none", reason: "fewer than two exchanges" };
  if (input.now - input.idleSince >= input.keepWarmHours * 60 * MINUTE) {
    return { action: "none", reason: "the keep-warm cap is reached" };
  }
  return { action: "warm" };
}

/** Whether a fork's usage shows the main thread's cache still held its prefix. */
export function cacheHeld(usage: {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}): boolean {
  const total =
    usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
  return total > 0 && usage.cache_read_input_tokens / total >= CACHE_HIT_SHARE;
}
