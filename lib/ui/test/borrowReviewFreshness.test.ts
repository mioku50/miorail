import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handOffFreshBorrowV1, hasBorrowSigningTermsV1, type FreshBorrowReviewV1 } from '../src/console/borrowReviewFreshness.js';

const NOW = Date.parse('2026-10-27T15:00:00Z');
function ready(over: Partial<FreshBorrowReviewV1> = {}): FreshBorrowReviewV1 {
  return { state: 'ready', callsHash: `0x${'1'.repeat(64)}`, signingTermsHash: `0x${'2'.repeat(64)}`,
    expiresAt: new Date(NOW + 30_000).toISOString(),
    calls: [{ to: `0x${'1'.repeat(40)}`, value: '0', data: '0x12345678' }], ...over };
}
function input(seen = ready()) {
  const sent: NonNullable<FreshBorrowReviewV1['calls']>[] = [];
  return { seen, confirmedTermsHash: null as string | null, refresh: async () => ready(),
    send: async (calls: NonNullable<FreshBorrowReviewV1['calls']>) => { sent.push(calls); return 'wallet-batch'; },
    current: () => true, now: () => NOW, sent };
}

describe('the borrow review that reaches a wallet', () => {
  it('re-measures before the first handoff and sends exactly the fresh server calls', async () => {
    const state = input(), order: string[] = [];
    const fresh = ready();
    const result = await handOffFreshBorrowV1({ ...state,
      refresh: async () => { order.push('measure'); return fresh; },
      send: async (calls) => { order.push('wallet'); assert.equal(calls, fresh.calls); return 'batch'; },
    });
    assert.deepEqual(order, ['measure', 'wallet']);
    assert.deepEqual(result, { state: 'submitted', batchId: 'batch' });
  });
  for (const fresh of [
    { state: 'refused', refusal: 'over_still_limit', detail: 'Still limit is lower.' },
    ready({ calls: [] }), ready({ signingTermsHash: undefined }), ready({ expiresAt: undefined }),
    ready({ expiresAt: new Date(NOW).toISOString() }), ready({ callsHash: 'bad' }),
    ready({ calls: [null] as never }),
  ] as FreshBorrowReviewV1[]) {
    it(`never sends a refused, incomplete or expired fresh answer (${JSON.stringify(fresh).slice(0, 65)})`, async () => {
      const state = input();
      const result = await handOffFreshBorrowV1({ ...state, refresh: async () => fresh });
      assert.equal(result.state, 'refused');
      assert.equal(state.sent.length, 0);
    });
  }
  it('shows changed debt or calls without opening a wallet; the second click accepts that exact review', async () => {
    const state = input();
    const fresh = ready({ signingTermsHash: `0x${'3'.repeat(64)}`, callsHash: `0x${'4'.repeat(64)}` });
    let measurements = 0;
    const refresh = async () => { measurements++; return fresh; };
    const first = await handOffFreshBorrowV1({ ...state, refresh });
    assert.equal(first.state, 'review_changed');
    assert.equal(state.sent.length, 0);
    if (first.state !== 'review_changed') return;
    const second = await handOffFreshBorrowV1({ ...state, seen: fresh, confirmedTermsHash: first.termsHash, refresh });
    assert.equal(second.state, 'submitted');
    assert.equal(measurements, 1, 'interest or venue nonces must not cause a perpetual re-prepare on the second click');
    assert.equal(state.sent[0], fresh.calls);
  });
  it('does not reuse the changed review after its server expiry', async () => {
    const state = input();
    const expired = ready({ expiresAt: new Date(NOW - 1).toISOString() });
    let reads = 0;
    const result = await handOffFreshBorrowV1({ ...state, seen: expired, confirmedTermsHash: expired.signingTermsHash!,
      refresh: async () => { reads++; return { state: 'refused', detail: 'Market changed.' }; } });
    assert.equal(result.state, 'refused');
    assert.equal(reads, 1);
    assert.equal(state.sent.length, 0);
  });
  it('checks wallet/draft identity again after the read', async () => {
    const state = input();
    const result = await handOffFreshBorrowV1({ ...state, current: () => false });
    assert.equal(result.state, 'refused');
    assert.equal(state.sent.length, 0);
  });
  it('a failed fresh read cannot fall back to the old calls', async () => {
    const state = input();
    await assert.rejects(handOffFreshBorrowV1({ ...state, refresh: async () => { throw new Error('read unavailable'); } }), /read unavailable/);
    assert.equal(state.sent.length, 0);
  });
  it('does not confuse a wallet declining with a successful submission', async () => {
    const state = input();
    await assert.rejects(handOffFreshBorrowV1({ ...state, send: async () => { throw new Error('user rejected'); } }), /user rejected/);
  });
  it('legacy ready data without server signing terms cannot enable the wallet control', () => {
    assert.equal(hasBorrowSigningTermsV1({ state: 'ready', calls: ready().calls }), false);
    assert.equal(hasBorrowSigningTermsV1(ready()), true);
  });
});
