import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type {
  StockInboxRepositoryV1,
  StockInboxPageInputV1,
  RwaSignalRowV1,
} from '../src/index.js';

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
      assert.equal((await pageRows(repository, input)).length, 2);
      await repository.acknowledge(WALLET, ['1'], NOW);
      await repository.acknowledge(WALLET, ['1'], NOW);
      assert.deepEqual(
        (await pageRows(repository, input)).map((r) => r.signalId),
        ['2'],
      );
      assert.equal((await pageRows(repository, { ...input, view: 'history' })).length, 2);
      await repository.open(OTHER, NOW);
      assert.equal((await pageRows(repository, { ...input, wallet: OTHER })).length, 2);
      await add([signal(3)]); // Same timestamp, inserted after a review.
      assert.deepEqual(
        (await pageRows(repository, input)).map((r) => r.signalId),
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
      const first = (await pageRows(repository, input)).slice(0, 50);
      const last = first.at(-1)!;
      const second = (
        await pageRows(repository, { ...input, before: { at: last.recordedAt, id: last.signalId } })
      ).slice(0, 50);
      assert.equal(new Set([...first, ...second].map((r) => r.signalId)).size, 100);
      await repository.acknowledge(
        WALLET,
        first.map((r) => r.signalId),
        NOW,
      );
      assert.equal((await pageRows(repository, input)).length, 50);
      const lastSecond = second.at(-1)!;
      assert.equal(
        (
          await pageRows(repository, {
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
          await pageRows(repository, {
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
    test('a cost change far above the holding is not its news; a route change is, at any size', async () => {
      // A $0.21 position was shown a $10,000 round trip. The cap is the
      // smallest measured size that covers the holding.
      const { repository, add } = await factory();
      const market = (id: number, kind: RwaSignalRowV1['kind'], size: string, token = TOKEN): RwaSignalRowV1 => ({
        ...signal(id, token),
        kind,
        facts: { requestedCashAtomic: size, destination: 'USDC' },
      });
      await add([
        market(1, 'official_asset_cash_exit_changed', '100000000'),
        market(2, 'official_asset_cash_exit_changed', '100000000000'),
        market(3, 'official_asset_market_became_active', '10000000000'),
        market(4, 'official_asset_cash_exit_changed', '100000000000', OTHER),
      ]);
      const state = await repository.open(WALLET, NOW);
      const rows = await pageRows(repository, {
        wallet: WALLET,
        addresses: [TOKEN, OTHER],
        since: state.since,
        until: NOW.toISOString(),
        view: 'unread',
        sizeCaps: [{ address: TOKEN, maxCashAtomic: '100000000' }],
      });
      // OTHER has no cap (a watched contract, or one Miorail cannot value).
      assert.deepEqual(rows.map((r) => r.signalId).sort(), ['1', '3', '4']);
    });
    test('a failing receipt is atomic and cannot acknowledge a valid subset', async () => {
      const { repository, add } = await factory();
      await add([signal(1)]);
      const state = await repository.open(WALLET, NOW);
      await assert.rejects(repository.acknowledge(WALLET, ['1', '9999999'], NOW));
      assert.equal(
        (
          await pageRows(repository, {
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
    test('issuer logs form a whole transaction page, including already-read supporting records', async () => {
      const { repository, add } = await factory();
      const tx = `0x${'a'.repeat(64)}`;
      await add([
        ...Array.from({ length: 49 }, (_, i) => signal(i + 4)),
        ...[1, 2, 3].map((id) => ({
          ...signal(id),
          facts: { transactionHash: tx, multiplierWad: '1000537939576369481' },
        })),
      ]);
      const state = await repository.open(WALLET, NOW);
      const input = {
        wallet: WALLET,
        addresses: [TOKEN],
        since: state.since,
        until: NOW.toISOString(),
        view: 'unread' as const,
      };
      const first = await repository.page(input);
      assert.equal(first.groups.length, 49);
      assert.equal(first.hasMore, true);
      const second = await repository.page({ ...input, before: first.groups.at(-1)!.anchor });
      assert.equal(second.groups.length, 1);
      assert.deepEqual(
        second.groups[0]!.rows.map((row) => row.signalId),
        ['3', '2', '1'],
      );
      await repository.acknowledge(WALLET, ['3'], NOW); // A legacy client reviewed only one log.
      assert.equal(
        (await repository.page({ ...input, before: first.groups.at(-1)!.anchor })).groups[0]!.rows
          .length,
        3,
      );
      await repository.acknowledge(WALLET, ['1', '2', '3'], NOW);
      assert.equal(
        (await repository.page({ ...input, before: first.groups.at(-1)!.anchor })).groups.length,
        0,
      );
      assert.equal(
        (await repository.page({ ...input, view: 'history', before: first.groups.at(-1)!.anchor }))
          .groups[0]!.rows.length,
        3,
      );
    });
    test('group anchors keep interleaved records and equal-valued independent transactions apart', async () => {
      const { repository, add } = await factory();
      const tx = `0x${'a'.repeat(64)}`,
        different = `0x${'b'.repeat(64)}`;
      await add([
        { ...signal(1), facts: { transactionHash: tx } },
        { ...signal(3), facts: { transactionHash: tx } },
        { ...signal(2), facts: { transactionHash: different } },
        { ...signal(4, OTHER), facts: { transactionHash: tx } },
      ]);
      const state = await repository.open(WALLET, NOW);
      const input = {
        wallet: WALLET,
        addresses: [TOKEN, OTHER],
        since: state.since,
        until: NOW.toISOString(),
        view: 'unread' as const,
      };
      const result = await repository.page(input);
      assert.deepEqual(
        result.groups.map((group) => group.rows.map((row) => row.signalId)),
        [['4'], ['3', '1'], ['2']],
      );
      assert.deepEqual(
        (await repository.page({ ...input, before: result.groups[1]!.anchor })).groups.map(
          (group) => group.rows.map((row) => row.signalId),
        ),
        [['2']],
      );
    });
    test('a later log is never swallowed by a proof issued before it was recorded', async () => {
      const { repository, add } = await factory();
      const tx = `0x${'a'.repeat(64)}`;
      await add([{ ...signal(1), facts: { transactionHash: tx } }]);
      const state = await repository.open(WALLET, NOW);
      const input = {
        wallet: WALLET,
        addresses: [TOKEN],
        since: state.since,
        until: NOW.toISOString(),
        view: 'unread' as const,
      };
      const shown = await repository.page(input);
      await add([{ ...signal(2), facts: { transactionHash: tx } }]);
      await repository.acknowledge(
        WALLET,
        shown.groups.flatMap((group) => group.rows.map((row) => row.signalId)),
        NOW,
      );
      const unread = await repository.page(input);
      assert.equal(unread.groups.length, 1);
      assert.deepEqual(
        unread.groups[0]!.rows.map((row) => row.signalId),
        ['2', '1'],
      );
    });
  });
}

async function pageRows(repository: StockInboxRepositoryV1, input: StockInboxPageInputV1) {
  return (await repository.page(input)).groups.flatMap((group) => group.rows);
}
