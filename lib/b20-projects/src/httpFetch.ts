import { isNonPublicHostV1 } from './claimFile.js';
import type { B20HttpFetchV1, B20HttpResponseV1 } from './collect.js';

// ---------------------------------------------------------------------------
// The one place Miorail reaches a third party's server.
//
// Every URL that arrives here came out of a claim file, which is input written
// by whoever controls a domain. A fetcher that follows such input without rules
// is a request-forgery primitive pointed at this machine's own network, so the
// rules are here rather than at the call sites:
//
//   HTTPS only, and re-checked after every redirect.
//   No private, loopback or link-local host, before the request and after each
//   hop — a public name whose redirect lands on 127.0.0.1 is the classic bypass.
//   A hard cap on redirects, on time, and on how much body is read.
//
// Nothing Miorail holds is sent: no cookie, no authorization header, no API
// key. The only headers are an Accept and a user agent that says who is asking.
// ---------------------------------------------------------------------------

/** Enough to read a claim file and a small JSON answer. A product endpoint that
 * needs more than this to prove it answers is not being asked to. */
export const B20_PROBE_BODY_LIMIT_BYTES_V1 = 256 * 1024;
export const B20_PROBE_TIMEOUT_MS_V1 = 8_000;
export const B20_PROBE_MAX_REDIRECTS_V1 = 2;

export const B20_PROBE_USER_AGENT_V1 = 'Miorail-B20-ProjectVerifier/1.0 (+https://miorail.xyz)';

export class B20ProbeRefusedError extends Error {
  constructor(reason: string) {
    super(`probe refused: ${reason}`);
    this.name = 'B20ProbeRefusedError';
  }
}

function assertFetchableV1(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new B20ProbeRefusedError('not a URL');
  }
  if (parsed.protocol !== 'https:') throw new B20ProbeRefusedError('not https');
  if (isNonPublicHostV1(parsed.hostname)) throw new B20ProbeRefusedError('non-public host');
  return parsed;
}

/** Reads at most `limit` bytes of a body, on the request's own clock. Past the limit the rest is
 * never read: the connection is closed instead of drained. A body that has not ended by the deadline
 * fails the request, even when its server ignores the abort. */
async function readBoundedV1(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const deadline = new Promise<never>((_, reject) => {
    const stop = () => reject(new B20ProbeRefusedError('the answer did not finish in time'));
    if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
  });
  deadline.catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done || !value) break;
      const kept = value.length > limit - size ? value.subarray(0, limit - size) : value;
      chunks.push(kept);
      size += kept.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

/** The production fetcher. `fetchImpl` is injectable only so a test can drive
 * the redirect and size rules without a server; so are the clock and the limit. */
export function createB20HttpFetchV1(
  fetchImpl: typeof fetch = fetch,
  options: { timeoutMs?: number; bodyLimitBytes?: number } = {},
): B20HttpFetchV1 {
  const timeoutMs = options.timeoutMs ?? B20_PROBE_TIMEOUT_MS_V1;
  const limit = options.bodyLimitBytes ?? B20_PROBE_BODY_LIMIT_BYTES_V1;
  return async ({ url, accept, postJson }): Promise<B20HttpResponseV1> => {
    let target = assertFetchableV1(url);
    // One clock for the whole request, every hop and every byte of the body (audit MCP-4,
    // 2026-11-10): the timer used to stop at the headers, and a body was read whole before it
    // was cut to the limit, so an anonymous /mcp call could make this process read 24 MB in
    // 12.6 seconds, and a few at once could exhaust its memory.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      for (let hop = 0; ; hop += 1) {
        const response = await fetchImpl(target.toString(), {
          method: postJson === undefined ? 'GET' : 'POST',
          // Manual, so every hop is re-checked against the rules above rather
          // than trusted to the platform's own follower.
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            accept,
            'user-agent': B20_PROBE_USER_AGENT_V1,
            ...(postJson === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(postJson === undefined ? {} : { body: JSON.stringify(postJson) }),
        });

        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel().catch(() => undefined);
          const location = response.headers.get('location');
          if (!location || hop >= B20_PROBE_MAX_REDIRECTS_V1) {
            return { ok: false, status: response.status, contentType: null, bodyText: '' };
          }
          target = assertFetchableV1(new URL(location, target).toString());
          continue;
        }

        // Bounded read. A third-party server deciding how much memory this
        // process uses is not a decision it gets to make.
        const raw = await readBoundedV1(response, limit, controller.signal);
        return {
          ok: response.ok,
          status: response.status,
          contentType: response.headers.get('content-type'),
          bodyText: new TextDecoder().decode(raw),
        };
      }
    } finally {
      clearTimeout(timer);
    }
  };
}
