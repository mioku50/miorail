// GMGN limits the caller's IP across read endpoints. Share the cooldown across
// quotes, gas and discovery; retrying during a ban can extend it. This cache is
// process-local and contains only a timestamp, never credentials or responses.
const cooldowns = new WeakMap<typeof fetch, number>();
const FALLBACK_COOLDOWN_MS = 5 * 60_000;
const MAX_COOLDOWN_MS = 24 * 60 * 60_000;

function resetAt(headers: Headers, now: number): number {
  const seconds = headers.get('x-ratelimit-reset');
  const retryAfter = headers.get('retry-after');
  const deadlines = [
    seconds && /^\d{1,11}$/.test(seconds) ? Number(seconds) * 1000 : NaN,
    retryAfter && /^\d{1,8}$/.test(retryAfter) ? now + Number(retryAfter) * 1000 : NaN,
    retryAfter && !/^\d+$/.test(retryAfter) ? Date.parse(retryAfter) : NaN,
  ].filter(value => Number.isFinite(value) && value > now && value <= now + MAX_COOLDOWN_MS);
  // The buffer covers the second precision of the published reset header.
  return deadlines.length ? Math.max(...deadlines) + 1000 : now + FALLBACK_COOLDOWN_MS;
}

/** Preserve the real fetch boundary and suppress reads until a 429 resets. */
export function gmgnReadFetchV1(fetchImpl: typeof fetch = fetch, clock: () => number = Date.now): typeof fetch {
  return async (request, init) => {
    const now = clock();
    const blockedUntil = cooldowns.get(fetchImpl) ?? 0;
    if (blockedUntil > now) {
      init?.signal?.throwIfAborted();
      return new Response('{"code":429,"error":"MIORAIL_GMGN_COOLDOWN"}', {
        status: 429,
        headers: { 'content-type': 'application/json', 'x-ratelimit-reset': String(Math.ceil(blockedUntil / 1000)) },
      });
    }
    const response = await fetchImpl(request, init);
    if (response.status === 429) {
      cooldowns.set(fetchImpl, Math.max(cooldowns.get(fetchImpl) ?? 0, resetAt(response.headers, clock())));
    }
    return response;
  };
}
