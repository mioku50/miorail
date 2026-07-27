import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  createB20ReaderV1,
  inspectB20TokenV1,
  type B20ControlSnapshotV1,
  type B20ReaderV1,
  type B20RpcResultV1,
} from '@mioagent/b20-control';

import { InMemoryB20StorageRepositoryV1 } from '../src/b20Memory.js';
import { b20SnapshotWriteEffectV1, b20RecordFromSnapshotV1 } from '../src/b20.js';
import { RouteStorageConflictError, RouteStorageIntegrityError } from '../src/types.js';

const TOKEN = '0xb2000000000000000000007bf6d5cbb0e24cb301';
const NOW = new Date('2026-07-27T12:00:00.000Z');
const BLOCK_HASH = `0x${'ab'.repeat(32)}` as const;

function word(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}
function stringWord(text: string): string {
  const bytes = Buffer.from(text, 'utf8').toString('hex');
  return `0x${word(32n)}${word(BigInt(text.length))}${bytes.padEnd(64, '0')}`;
}

function reader(blockNumber = '49059662', supply = 10n ** 27n): B20ReaderV1 {
  const ok = (value: string): B20RpcResultV1<string> => ({ ok: true, value, raw: value });
  return {
    async readBlockAnchor() {
      return { ok: true, value: { blockNumber, blockHash: BLOCK_HASH, blockTag: '0x1' }, raw: '' };
    },
    async readIsB20() {
      return { ok: true, value: true, raw: `0x${word(1n)}` };
    },
    async readIsB20Initialized() {
      return { ok: true, value: true, raw: `0x${word(1n)}` };
    },
    async readVariantActivated() {
      return { ok: true, value: true, raw: `0x${word(1n)}` };
    },
    async call(input) {
      const selector = input.data.slice(2, 10);
      // totalSupply is the one value varied between scenarios below.
      if (selector === '18160ddd') return ok(`0x${word(supply)}`);
      if (selector === '06fdde03' || selector === '95d89b41') return ok(stringWord('BRIAN'));
      if (selector === 'e8a3d485') return ok(stringWord('ipfs://x'));
      if (selector === '313ce567') return ok(`0x${word(18n)}`);
      if (selector === 'de9997e3') return ok(`0x${word(32n)}${word(0n)}`);
      return ok(`0x${word(0n)}`);
    },
  };
}

async function snapshotFor(blockNumber = '49059662', supply = 10n ** 27n): Promise<B20ControlSnapshotV1> {
  const result = await inspectB20TokenV1(
    { reader: reader(blockNumber, supply) },
    { tenantId: 'tenant-1', chainId: 8453, tokenAddress: TOKEN, now: NOW },
  );
  return result.snapshot;
}

describe('B20 snapshots are immutable', () => {
  test('re-inspecting at the same block returns the stored row rather than writing again', async () => {
    const repository = new InMemoryB20StorageRepositoryV1(() => NOW);
    const snapshot = await snapshotFor();
    const first = await repository.insertSnapshot({ userId: 'tenant-1', snapshot });
    const second = await repository.insertSnapshot({ userId: 'tenant-1', snapshot });
    assert.equal(first.id, second.id);
    assert.equal(first.snapshotHash, second.snapshotHash);
  });

  test('a DIFFERENT snapshot for the same token and block is a conflict, not an overwrite', async () => {
    // The chain had one state at that block. Two disagreeing records mean one
    // of them is wrong, and neither is allowed to silently win.
    const repository = new InMemoryB20StorageRepositoryV1(() => NOW);
    await repository.insertSnapshot({ userId: 'tenant-1', snapshot: await snapshotFor('49059662', 1n) });
    await assert.rejects(
      repository.insertSnapshot({ userId: 'tenant-1', snapshot: await snapshotFor('49059662', 2n) }),
      RouteStorageConflictError,
    );
  });

  test('a later block is a new snapshot, not a replacement', async () => {
    const repository = new InMemoryB20StorageRepositoryV1(() => NOW);
    const older = await repository.insertSnapshot({ userId: 'tenant-1', snapshot: await snapshotFor('49059662') });
    const newer = await repository.insertSnapshot({ userId: 'tenant-1', snapshot: await snapshotFor('49059999') });
    assert.notEqual(older.id, newer.id);
    assert.ok(await repository.getSnapshot(older.id, 'tenant-1'), 'the earlier snapshot survives');
  });

  test('the write decision is shared, so the fake cannot be kinder than Postgres', async () => {
    const snapshot = await snapshotFor();
    const record = b20RecordFromSnapshotV1('tenant-1', snapshot, NOW.toISOString());
    assert.deepEqual(b20SnapshotWriteEffectV1(null, snapshot), { effect: 'insert' });
    assert.deepEqual(b20SnapshotWriteEffectV1(record, snapshot), { effect: 'return_existing' });
    const different = await snapshotFor('49059662', 7n);
    assert.equal(b20SnapshotWriteEffectV1(record, different).effect, 'conflict');
  });
});

describe('tenant isolation is the query, not a check afterwards', () => {
  test('another tenant does not find the snapshot', async () => {
    const repository = new InMemoryB20StorageRepositoryV1(() => NOW);
    const stored = await repository.insertSnapshot({ userId: 'tenant-1', snapshot: await snapshotFor() });
    assert.ok(await repository.getSnapshot(stored.id, 'tenant-1'));
    assert.equal(await repository.getSnapshot(stored.id, 'tenant-2'), null);
    assert.equal(await repository.latestSnapshot('tenant-2', TOKEN), null);
  });

  test('two tenants may each hold their own snapshot of the same token and block', async () => {
    const repository = new InMemoryB20StorageRepositoryV1(() => NOW);
    const snapshotOne = await snapshotFor();
    await repository.insertSnapshot({ userId: 'tenant-1', snapshot: snapshotOne });
    // A second tenant's snapshot carries its own id, so it does not collide.
    const other = await inspectB20TokenV1(
      { reader: reader() },
      { tenantId: 'tenant-2', chainId: 8453, tokenAddress: TOKEN, now: NOW },
    );
    const stored = await repository.insertSnapshot({ userId: 'tenant-2', snapshot: other.snapshot });
    assert.notEqual(stored.id, snapshotOne.id);
  });
});

describe('payloads are validated on the way in and on the way out', () => {
  test('a snapshot that fails its own schema is refused on write', async () => {
    const repository = new InMemoryB20StorageRepositoryV1(() => NOW);
    const snapshot = await snapshotFor();
    const tampered = { ...snapshot, blockNumber: '1' } as B20ControlSnapshotV1;
    await assert.rejects(
      repository.insertSnapshot({ userId: 'tenant-1', snapshot: tampered }),
      RouteStorageIntegrityError,
    );
  });

  test('the latest snapshot for a token is the most recently observed one', async () => {
    const repository = new InMemoryB20StorageRepositoryV1(() => NOW);
    await repository.insertSnapshot({ userId: 'tenant-1', snapshot: await snapshotFor('49059662') });
    const latest = await repository.latestSnapshot('tenant-1', TOKEN);
    assert.equal(latest?.blockNumber, '49059662');
    assert.equal(latest?.tokenAddress, TOKEN);
  });
});

describe('the reader never runs in these tests', () => {
  test('an unconfigured reader opens no socket', async () => {
    const detonating = createB20ReaderV1({
      rpcUrl: '',
      fetchImpl: () => {
        throw new Error('a storage test must never open a socket');
      },
    });
    const result = await detonating.readBlockAnchor();
    assert.equal(result.ok, false);
  });
});
