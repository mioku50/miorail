import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { B20_PROBE_USER_AGENT_V1, B20ProbeRefusedError, createB20HttpFetchV1 } from '../src/httpFetch.js';

// The one place Miorail reaches a third party's server, against servers that
// misbehave (audit MCP-4, 2026-11-10): a body that never ends, one that
// trickles, and redirects. Every server here is a stream in this process.
const URL_V1 = 'https://claims.example.org/.well-known/miorail.json';

function endless(): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean; served: () => number } {
  let cancelled = false, served = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { served += 64 * 1024; controller.enqueue(new Uint8Array(64 * 1024).fill(0x61)); },
    cancel() { cancelled = true; },
  });
  return { stream, cancelled: () => cancelled, served: () => served };
}

describe('the fetcher of a foreign server', () => {
  it('stops reading a body at the limit and closes the connection, however much the server would send', async () => {
    const body = endless();
    const fetcher = createB20HttpFetchV1(async () => new Response(body.stream, { status: 200, headers: { 'content-type': 'application/json' } }),
      { bodyLimitBytes: 256 * 1024, timeoutMs: 5_000 });
    const answer = await fetcher({ url: URL_V1, accept: 'application/json' });
    assert.equal(answer.ok, true);
    assert.equal(answer.bodyText.length, 256 * 1024);
    assert.equal(body.cancelled(), true);
    assert.ok(body.served() <= 256 * 1024 + 2 * 64 * 1024, `read ${body.served()} bytes`);
  });

  it('fails a body that has not ended by the deadline, even when the server ignores the abort', async () => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const trickle = new ReadableStream<Uint8Array>({
      start(controller) { timer = setInterval(() => controller.enqueue(new Uint8Array([0x61])), 20); },
      cancel() { if (timer) clearInterval(timer); },
    });
    const fetcher = createB20HttpFetchV1(async () => new Response(trickle, { status: 200 }), { timeoutMs: 150 });
    const started = Date.now();
    await assert.rejects(fetcher({ url: URL_V1, accept: 'application/json' }), B20ProbeRefusedError);
    assert.ok(Date.now() - started < 2_000);
    if (timer) clearInterval(timer);
  });

  it('keeps one clock across redirects, re-checks each hop, and reads a small answer whole', async () => {
    const asked: Array<{ url: string; agent: string | null; signal: AbortSignal | null }> = [];
    const fetcher = createB20HttpFetchV1(async (input, init) => {
      const url = String(input), headers = new Headers(init?.headers);
      asked.push({ url, agent: headers.get('user-agent'), signal: (init?.signal as AbortSignal | undefined) ?? null });
      if (url === URL_V1) return new Response(null, { status: 302, headers: { location: '/moved.json' } });
      return new Response('{"claim":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const answer = await fetcher({ url: URL_V1, accept: 'application/json' });
    assert.deepEqual(answer, { ok: true, status: 200, contentType: 'application/json', bodyText: '{"claim":true}' });
    assert.deepEqual(asked.map(row => row.url), [URL_V1, 'https://claims.example.org/moved.json']);
    assert.equal(asked[0]!.agent, B20_PROBE_USER_AGENT_V1);
    assert.equal(asked[0]!.signal, asked[1]!.signal);
    const local = createB20HttpFetchV1(async () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/admin' } }));
    await assert.rejects(local({ url: URL_V1, accept: 'application/json' }), /non-public host/);
  });

  it('gives up after two redirects and refuses anything but HTTPS', async () => {
    const loop = createB20HttpFetchV1(async (input) => new Response(null, { status: 301, headers: { location: `${String(input)}x` } }));
    assert.deepEqual(await loop({ url: URL_V1, accept: 'application/json' }), { ok: false, status: 301, contentType: null, bodyText: '' });
    await assert.rejects(createB20HttpFetchV1(async () => new Response('x'))({ url: 'http://claims.example.org/', accept: 'text/plain' }), /not https/);
  });
});
