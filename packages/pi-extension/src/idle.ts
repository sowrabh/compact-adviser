// When automatic mode acts once the person has walked away from a settled answer: just before
// the prompt cache would lapse, so a finished session compacts while its cache is still warm
// and the next turn does not resend the whole context uncached. Pi has no way to keep a cache
// warm without a turn of its own, so this host compacts or does nothing.

const MINUTE = 60_000;
export const LONG_TTL_MS = 60 * MINUTE;
export const SHORT_TTL_MS = 5 * MINUTE;
/** How long before the cache would lapse the idle point fires, at most. */
export const IDLE_MARGIN_MS = 10 * MINUTE;

export interface CacheTtl {
  ttlMs: number;
  /** False when the provider's TTL is not known and the 1 h fallback stands in. */
  known: boolean;
}

/** Pi's Anthropic-protocol providers cache for 5 minutes, or 1 hour with PI_CACHE_RETENTION=long. */
const ANTHROPIC_APIS = new Set(["anthropic-messages", "bedrock-converse-stream"]);

export function piCacheTtl(api: string | undefined, retention: string | undefined): CacheTtl {
  if (api !== undefined && ANTHROPIC_APIS.has(api)) {
    return { ttlMs: retention === "long" ? LONG_TTL_MS : SHORT_TTL_MS, known: true };
  }
  return { ttlMs: LONG_TTL_MS, known: false };
}

/**
 * How long after a settled answer the idle point comes: the person's `idleMinutes` when set,
 * otherwise just before the cache lapses (50 min on a 1 h cache, 4 min on a 5 min one).
 */
export function idleDelayMs(ttl: { ttlMs: number }, idleMinutes: number): number {
  if (idleMinutes > 0) return idleMinutes * MINUTE;
  return ttl.ttlMs - Math.min(IDLE_MARGIN_MS, ttl.ttlMs / 5);
}
