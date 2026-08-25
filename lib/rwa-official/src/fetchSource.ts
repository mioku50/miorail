// ---------------------------------------------------------------------------
// Reading a reviewed source. One GET, a timeout, and no interpretation.
//
// Kept apart from the parsers so that every parser test runs on a fixture and
// none of them needs the network -- and so that "we could not read it" and "we
// read it and could not parse it" stay two different outcomes all the way to
// the stored snapshot.
// ---------------------------------------------------------------------------

export type OfficialFetchResultV1 =
  | { ok: true; body: string }
  | { ok: false; detail: string };

export async function fetchOfficialSourceV1(input: {
  url: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<OfficialFetchResultV1> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 20_000);
  try {
    const response = await (input.fetchImpl ?? fetch)(input.url, {
      method: 'GET',
      headers: { accept: 'text/markdown, text/html;q=0.9, text/plain;q=0.8', 'user-agent': 'miorail/1 (+official-asset-registry)' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) return { ok: false, detail: `http ${response.status}` };
    const body = await response.text();
    if (body.trim().length === 0) return { ok: false, detail: 'empty response body' };
    return { ok: true, body };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: message.slice(0, 200) };
  } finally {
    clearTimeout(timeout);
  }
}
