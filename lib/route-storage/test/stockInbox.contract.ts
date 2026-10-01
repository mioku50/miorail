import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { StockInboxRepositoryV1, RwaSignalRowV1 } from '../src/index.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const TOKEN = '0xb20000000000000000000078ee7ce2fe4908108c';
const NOW = new Date('2026-10-01T12:00:00.000Z');
const at = new Date(NOW.getTime() - 1000).toISOString();
function signal(id: number, token = TOKEN): RwaSignalRowV1 {
  return {
    signalId: String(id),
    chainId: 8453,
    subjectAddress: token,
    officialAddress: null,
    occurredAt: '2026-09-25T12:00:00.000Z',
    recordedAt: at,
    kind: 'official_asset_multiplier_changed',
    facts: {},
  };
}
export function stockInboxContract(
  name: string,
  factory: () => Promise<{
    repository: StockInboxRepositoryV1;
    add(rows: RwaSignalRowV1[]): Promise<void>;
  }>,
) {
  describe(`shared stock inbox (${name})`, () => {
    test('opening establishes one baseline and never implies a review', async () => {
      const { repository } = await factory();
      const first = await repository.open(WALLET, NOW);
      assert.equal(first.since, '2026-09-30T12:00:00.000Z');
      assert.equal(first.reviewedAt, null);
      assert.deepEqual(
        await repository.open(WALLET, new Date(NOW.getTime() + 20 * 86_400_000)),
        first,
      );
    });
    test('receipts name events, are idempotent and isolated by wallet; history retains them', async () => {
      const { repository, add } = await factory();
      await add([signal(1), signal(2)]);
      const state = await repository.open(WALLET, NOW);
      const input = {
        wallet: WALLET,
        addresses: [TOKEN],
        since: state.since,
        until: NOW.toISOString(),
        view: 'unread' as const,
      };
      assert.equal((await repository.page(input)).length, 2);
      await repository.acknowledge(WALLET, ['1'], NOW);
      await repository.acknowledge(WALLET, ['1'], NOW);
      assert.deepEqual(
        (await repository.page(input)).map((r) => r.signalId),
        ['2'],
      );
      assert.equal((await repository.page({ ...input, view: 'history' })).length, 2);
      await repository.open(OTHER, NOW);
      assert.equal((await repository.page({ ...input, wallet: OTHER })).length, 2);
      await add([signal(3)]); // Same timestamp, inserted after a review.
      assert.deepEqual(
        (await repository.page(input)).map((r) => r.signalId),
        ['3', '2'],
      );
    });
    test('stable pages handle same-time IDs; reviewing a page leaves every unseen page intact', async () => {
      const { repository, add } = await factory();
      await add(Array.from({ length: 103 }, (_, i) => signal(i + 1)));
      const state = await repository.open(WALLET, NOW);
      const input = {
        wallet: WALLET,
        addresses: [TOKEN],
        since: state.since,
        until: NOW.toISOString(),
        view: 'unread' as const,
      };
      const first = (await repository.page(input)).slice(0, 50);
      const last = first.at(-1)!;
      const second = (
        await repository.page({ ...input, before: { at: last.recordedAt, id: last.signalId } })
      ).slice(0, 50);
      assert.equal(new Set([...first, ...second].map((r) => r.signalId)).size, 100);
      await repository.acknowledge(
        WALLET,
        first.map((r) => r.signalId),
        NOW,
      );
      assert.equal((await repository.page(input)).length, 51);
      const lastSecond = second.at(-1)!;
      assert.equal(
        (
          await repository.page({
            ...input,
            before: { at: lastSecond.recordedAt, id: lastSecond.signalId },
          })
        ).length,
        3,
      );
    });
    test('irrelevant, future and pre-baseline records cannot displace relevant late observations', async () => {
      const { repository, add } = await factory();
      const future = { ...signal(3), recordedAt: new Date(NOW.getTime() + 1000).toISOString() };
      const old = {
        ...signal(4),
        occurredAt: '2026-09-01T00:00:00.000Z',
        recordedAt: '2026-09-01T00:00:00.000Z',
      };
      await add([signal(1), signal(2, OTHER), future, old]);
      const state = await repository.open(WALLET, NOW);
      assert.deepEqual(
        (
          await repository.page({
            wallet: WALLET,
            addresses: [TOKEN],
            since: state.since,
            until: NOW.toISOString(),
            view: 'unread',
          })
        ).map((r) => r.signalId),
        ['1'],
      );
    });
    test('a failing receipt is atomic and cannot acknowledge a valid subset', async () => {
      const { repository, add } = await factory();
      await add([signal(1)]);
      const state = await repository.open(WALLET, NOW);
      await assert.rejects(repository.acknowledge(WALLET, ['1', '9999999'], NOW));
      assert.equal(
        (
          await repository.page({
            wallet: WALLET,
            addresses: [TOKEN],
            since: state.since,
            until: NOW.toISOString(),
            view: 'unread',
          })
        ).length,
        1,
      );
      assert.equal((await repository.open(WALLET, NOW)).reviewedAt, null);
      await assert.rejects(repository.acknowledge(WALLET, ['0'], NOW));
      await assert.rejects(repository.open('arbitrary-wallet', NOW));
    });
  });
}
