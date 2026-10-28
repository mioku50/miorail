import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BORROW_SUBMISSION_PREFIX_V1, borrowSubmissionKeyV1, borrowSubmissionMarkerV1,
  BorrowSubmissionLockedErrorV1, BorrowSubmissionStorageErrorV1, submitBorrowOnceV1,
  type BorrowSubmissionStorageV1,
} from '../src/console/borrowSubmissionGuard.js';
import { handOffFreshBorrowV1 } from '../src/console/borrowReviewFreshness.js';

const WALLET = `0x${'a'.repeat(40)}`;
const OTHER = `0x${'b'.repeat(40)}`;
function storage() {
  const entries = new Map<string, string>();
  return { entries, getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } };
}

describe('one borrow draft crosses the wallet boundary at most once', () => {
  it('keys the exact draft and wallet without storing either credential or address', async () => {
    const key = await borrowSubmissionKeyV1('a-signed-draft-token', WALLET);
    assert.match(key!, /^miorail:borrow-attempt:v1:[0-9a-f]{64}$/);
    assert.equal(key, await borrowSubmissionKeyV1('a-signed-draft-token', WALLET.toUpperCase().replace('0X', '0x')));
    assert.notEqual(key, await borrowSubmissionKeyV1('a-signed-draft-token', OTHER));
    assert.notEqual(key, await borrowSubmissionKeyV1('another-draft-token', WALLET));
    assert.equal(await borrowSubmissionKeyV1('a-signed-draft-token', null), null);
    assert(!key!.includes(WALLET));
    assert(!key!.includes('a-signed-draft-token'));
  });
  for (const outcome of ['timeout', 'no-id', 'submitted'] as const) {
    it(`blocks a second request after ${outcome}, including a fresh instance after reload`, async () => {
      const data = storage(), key = (await borrowSubmissionKeyV1('draft', WALLET))!;
      let attempts = 0;
      const send = async () => {
        attempts++;
        assert.equal(data.getItem(key), 'pending', 'the lock must be durable before the wallet is called');
        if (outcome === 'timeout') throw new Error('response lost after the wallet accepted');
        return outcome === 'submitted' ? 'batch-fixture' : null;
      };
      if (outcome === 'timeout') await assert.rejects(submitBorrowOnceV1({ key, storage: data, send }), /response lost/);
      else await submitBorrowOnceV1({ key, storage: data, send });
      // A re-created guard has only persisted session state, just like a reload.
      const reloadedStorage = { getItem: data.getItem, setItem: data.setItem, removeItem: data.removeItem };
      await assert.rejects(submitBorrowOnceV1({ key, storage: reloadedStorage, send }), BorrowSubmissionLockedErrorV1);
      assert.equal(attempts, 1);
      assert.equal(borrowSubmissionMarkerV1(data, key), outcome === 'submitted' ? 'submitted' : 'unknown');
      assert.deepEqual([...data.entries.keys()], [key]);
    });
  }
  it('keeps a pending attempt blocked even before the first wallet response arrives', async () => {
    const data = storage(), key = (await borrowSubmissionKeyV1('draft', WALLET))!;
    let finish!: (id: string) => void, attempts = 0;
    const send = async () => { attempts++; return new Promise<string>(resolve => { finish = resolve; }); };
    const first = submitBorrowOnceV1({ key, storage: data, send });
    await assert.rejects(submitBorrowOnceV1({ key, storage: data, send }), BorrowSubmissionLockedErrorV1);
    finish('batch');
    await first;
    assert.equal(attempts, 1);
  });
  it('allows a second attempt only after a definitive nested user rejection', async () => {
    const data = storage(), key = (await borrowSubmissionKeyV1('draft', WALLET))!;
    await assert.rejects(submitBorrowOnceV1({ key, storage: data, send: async () => {
      throw Object.assign(new Error('wallet wrapper'), { cause: { cause: { code: 4001 } } });
    } }));
    assert.equal(data.getItem(key), null);
    assert.equal(await submitBorrowOnceV1({ key, storage: data, send: async () => 'new-attempt' }), 'new-attempt');
  });
  it('does not treat a disconnected provider or a rejection-like error message as proof of no submission', async () => {
    for (const error of [Object.assign(new Error('disconnected'), { code: 4900 }), new Error('the upstream rejected the request')]) {
      const data = storage(), key = (await borrowSubmissionKeyV1('draft', WALLET))!;
      await assert.rejects(submitBorrowOnceV1({ key, storage: data, send: async () => { throw error; } }));
      assert.equal(data.getItem(key), 'unknown');
    }
  });
  it('does not call the wallet if storage cannot read or preserve the marker', async () => {
    for (const failing of ['read', 'write', 'silent-write'] as const) {
      let attempts = 0;
      const data: BorrowSubmissionStorageV1 = {
        getItem: () => { if (failing === 'read') throw new Error('blocked'); return null; },
        setItem: () => { if (failing === 'write') throw new Error('quota'); }, removeItem: () => {},
      };
      await assert.rejects(submitBorrowOnceV1({ key: 'fixture-key', storage: data,
        send: async () => { attempts++; return 'must-not-send'; } }), BorrowSubmissionStorageErrorV1);
      assert.equal(attempts, 0);
    }
  });
  it('does not erase the pending marker if persisting the final response fails', async () => {
    const data = storage(), key = (await borrowSubmissionKeyV1('draft', WALLET))!;
    let writes = 0;
    const fragile = { ...data, setItem: (k: string, value: string) => { if (++writes > 1) throw new Error('quota'); data.setItem(k, value); } };
    assert.equal(await submitBorrowOnceV1({ key, storage: fragile, send: async () => 'batch' }), 'batch');
    assert.equal(data.getItem(key), 'pending');
    await assert.rejects(submitBorrowOnceV1({ key, storage: data, send: async () => 'must-not-send' }), BorrowSubmissionLockedErrorV1);
  });
  it('retains the old draft lock after changing identity and coming back', async () => {
    const data = storage(), key = (await borrowSubmissionKeyV1('draft', WALLET))!;
    await submitBorrowOnceV1({ key, storage: data, send: async () => null });
    assert.equal(borrowSubmissionMarkerV1(data, (await borrowSubmissionKeyV1('other-draft', WALLET))!), null);
    assert.equal(borrowSubmissionMarkerV1(data, (await borrowSubmissionKeyV1('draft', OTHER))!), null);
    assert.equal(borrowSubmissionMarkerV1(data, (await borrowSubmissionKeyV1('draft', WALLET))!), 'unknown');
  });
  it('never records an attempt for a refusal or failed re-measurement before the wallet boundary', async () => {
    const data = storage();
    const seen = { state: 'ready' as const, callsHash: `0x${'1'.repeat(64)}`, signingTermsHash: `0x${'2'.repeat(64)}`,
      calls: [{ to: WALLET, value: '0', data: '0x12345678' }], expiresAt: '2099-01-01T00:00:00Z' };
    const send = () => submitBorrowOnceV1({ key: 'unused', storage: data, send: async () => 'must-not-send' });
    const refused = await handOffFreshBorrowV1({ seen, confirmedTermsHash: null, refresh: async () => ({ state: 'refused' }), send, current: () => true });
    assert.equal(refused.state, 'refused');
    await assert.rejects(handOffFreshBorrowV1({ seen, confirmedTermsHash: null, refresh: async () => { throw new Error('read failed'); }, send, current: () => true }));
    assert.equal(data.entries.size, 0);
  });
  it('treats an unknown stored state conservatively', () => {
    const data = storage();
    data.setItem(BORROW_SUBMISSION_PREFIX_V1 + 'fixture', 'corrupted');
    assert.equal(borrowSubmissionMarkerV1(data, BORROW_SUBMISSION_PREFIX_V1 + 'fixture'), 'unknown');
  });
});
