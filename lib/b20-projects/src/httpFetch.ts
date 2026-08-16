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

/** The production fetcher. `fetchImpl` is injectable only so a test can drive
 * the redirect and size rules without a server. */
export function createB20HttpFetchV1(
  fetchImpl: typeof fetch = fetch,
): B20HttpFetchV1 {
  return async ({ url, accept, postJson }): Promise<B20HttpResponseV1> => {
    let target = assertFetchableV1(url);

    for (let hop = 0; ; hop += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), B20_PROBE_TIMEOUT_MS_V1);
      let response: Response;
      try {
        response = await fetchImpl(target.toString(), {
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
      } finally {
        clearTimeout(timer);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || hop >= B20_PROBE_MAX_REDIRECTS_V1) {
          return { ok: false, status: response.status, contentType: null, bodyText: '' };
        }
        target = assertFetchableV1(new URL(location, target).toString());
        continue;
      }

      // Bounded read. A third-party server deciding how much memory this
      // process uses is not a decision it gets to make.
      const raw = await response.arrayBuffer();
      const bodyText = new TextDecoder().decode(raw.slice(0, B20_PROBE_BODY_LIMIT_BYTES_V1));
      return {
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get('content-type'),
        bodyText,
      };
    }
  };
}
