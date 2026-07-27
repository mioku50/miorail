import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { submissionRecoveryMarkerKeyV1, type SubmissionRecoveryMarkerV1 } from '@mioagent/route-domain';

import {
  clearRecoveryMarkerV1,
  markerShouldBeClearedV1,
  readRecoveryMarkersV1,
  writeRecoveryMarkerV1,
  type MarkerStorageV1,
} from './recoveryMarker';

const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

class FakeStorage implements MarkerStorageV1 {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  get length(): number {
    return this.map.size;
  }
}

function marker(overrides: Partial<SubmissionRecoveryMarkerV1> = {}): SubmissionRecoveryMarkerV1 {
  return {
    schemaVersion: 'submission-recovery-marker/v1',
    attemptId: 'submission-attempt:1',
    batchId: 'batch-1',
    goal: 'swap',
    routeRunId: 'run-1',
    blueprintId: 'blueprint-1',
    proofId: null,
    walletAddress: WALLET,
    chainId: 8453,
    createdAt: '2026-07-27T12:00:00.000Z',
    ...overrides,
  } as SubmissionRecoveryMarkerV1;
}

describe('the marker holds handles and nothing else', () => {
  test('a written marker round-trips', () => {
    const storage = new FakeStorage();
    assert.equal(writeRecoveryMarkerV1(storage, marker()), true);
    const found = readRecoveryMarkersV1(storage, { walletAddress: WALLET, chainId: 8453 });
    assert.equal(found.length, 1);
    assert.equal(found[0]?.batchId, 'batch-1');
  });

  test('nothing secret or spendable can be stored in it', () => {
    const storage = new FakeStorage();
    writeRecoveryMarkerV1(storage, marker());
    const raw = storage.getItem(submissionRecoveryMarkerKeyV1(WALLET, 'submission-attempt:1')) ?? '';
    // The schema is `.strict()`, so these could only appear if the contract
    // itself grew a field it must never have.
    for (const banned of ['calldata', 'calls', 'privateKey', 'token', 'receipt', 'signature']) {
      assert.equal(raw.toLowerCase().includes(banned.toLowerCase()), false, `a marker must not carry ${banned}`);
    }
  });

  test('a tampered marker is dropped rather than used', () => {
    const storage = new FakeStorage();
    storage.setItem(
      submissionRecoveryMarkerKeyV1(WALLET, 'submission-attempt:1'),
      JSON.stringify({ ...marker(), attemptId: '' }),
    );
    assert.deepEqual(readRecoveryMarkersV1(storage, { walletAddress: WALLET, chainId: 8453 }), []);
    assert.equal(storage.length, 0, 'an unusable marker is deleted, not left to be retried');
  });

  test('unparseable JSON is dropped', () => {
    const storage = new FakeStorage();
    storage.setItem(submissionRecoveryMarkerKeyV1(WALLET, 'x'), '{not json');
    assert.deepEqual(readRecoveryMarkersV1(storage, { walletAddress: WALLET, chainId: 8453 }), []);
  });

  test('a marker for another wallet is never returned', () => {
    const storage = new FakeStorage();
    writeRecoveryMarkerV1(storage, marker({ walletAddress: OTHER }));
    assert.deepEqual(readRecoveryMarkersV1(storage, { walletAddress: WALLET, chainId: 8453 }), []);
  });

  test('a marker for another chain is never returned', () => {
    const storage = new FakeStorage();
    // Written directly: the schema refuses to produce one for another chain.
    storage.setItem(
      submissionRecoveryMarkerKeyV1(WALLET, 'submission-attempt:1'),
      JSON.stringify({ ...marker(), chainId: 84532 }),
    );
    assert.deepEqual(readRecoveryMarkersV1(storage, { walletAddress: WALLET, chainId: 8453 }), []);
  });

  test('no storage at all is not an error', () => {
    assert.equal(writeRecoveryMarkerV1(null, marker()), false);
    assert.deepEqual(readRecoveryMarkersV1(null, { walletAddress: WALLET, chainId: 8453 }), []);
    clearRecoveryMarkerV1(null, WALLET, 'submission-attempt:1');
  });
});

describe('when a marker stops being worth keeping', () => {
  test('a wallet success does NOT clear it while the proof is still pending', () => {
    // Dropping the handle here would strand a proof that still needs
    // reconciling, with nothing left to resume from.
    assert.equal(markerShouldBeClearedV1({ attemptStatus: 'confirmed', proofFinalStatus: 'pending' }), false);
  });

  test('a terminal proof clears it', () => {
    assert.equal(markerShouldBeClearedV1({ attemptStatus: 'confirmed', proofFinalStatus: 'completed' }), true);
    assert.equal(markerShouldBeClearedV1({ attemptStatus: 'confirmed', proofFinalStatus: 'failed' }), true);
  });

  test('a proof awaiting manual reconciliation is not terminal', () => {
    assert.equal(
      markerShouldBeClearedV1({ attemptStatus: 'confirmed', proofFinalStatus: 'reconciliation_required' }),
      false,
    );
  });

  test('failed, cancelled and abandoned clear it', () => {
    for (const status of ['failed', 'cancelled', 'abandoned']) {
      assert.equal(markerShouldBeClearedV1({ attemptStatus: status, proofFinalStatus: null }), true);
    }
  });
});

describe('recovery cannot become a second wallet path', () => {
  test('the recovery card imports nothing that can send a transaction', () => {
    const source = readFileSync(resolve(import.meta.dirname, 'SubmissionRecoveryCard.tsx'), 'utf8');
    // Comments are stripped first: the file explains at length that it cannot
    // send a transaction, and prose about the guarantee must not be mistaken
    // for a violation of it. What remains is executable code.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const banned of ['useSendCalls', 'sendCalls', 'useApproveSwapBlueprint', 'usePrepare', 'eth_sendTransaction']) {
      assert.equal(code.includes(banned), false, `the recovery card must not reference ${banned}`);
    }
    assert.ok(code.includes('CallsStatusPoller'), 'it reads status through the existing poller');
  });
});
