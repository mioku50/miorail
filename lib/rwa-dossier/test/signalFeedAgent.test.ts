import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  RWA_SIGNAL_KINDS_V1,
  createMemoryB20CorporateActionRepository,
  createMemoryRwaSignalRepository,
  type RwaSignalV1,
} from '@mioagent/route-storage';

import { rwaRecordedChangesForAgentV1 } from '../src/signalFeedAgent.js';
import type { OfficialDiscoverDepsV1 } from '../src/overview.js';

// ---------------------------------------------------------------------------
// The market-wide read is the only tool on the protocol that answers without
// being told which asset to look at, which makes its empty result the most
// dangerous sentence Miorail can hand an assistant. "Nothing changed" and
// "nobody looked" arrive as the same empty array, and every test here is a way
// the second could be reported as the first.
// ---------------------------------------------------------------------------

const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const NVDA = '0xb200000000000000000000578f3ae29d9e6e0101';
const NOW = new Date('2026-09-08T12:00:00.000Z');

function costChangeV1(input: {
  subject: string;
  occurredAt: string;
  key: string;
  from: string;
  to: string;
}): RwaSignalV1 {
  return {
    kind: 'official_asset_cash_exit_changed',
    chainId: 8453,
    subjectAddress: input.subject,
    officialAddress: null,
    occurredAt: input.occurredAt,
    dedupeKey: `official_asset_cash_exit_changed:${input.key}`,
    facts: {
      ticker: 'TESTc',
      destination: 'USDC',
      requestedCashAtomic: '10000000000',
      previousRoundTripCostBps: input.from,
      roundTripCostBps: input.to,
      changeBps: (BigInt(input.to) - BigInt(input.from)).toString(),
      thresholdBps: 50,
      approvedSources: ['kyberswap'],
    },
  } as RwaSignalV1;
}

async function depsV1(): Promise<OfficialDiscoverDepsV1> {
  const signals = createMemoryRwaSignalRepository();
  return {
    signals,
    // The feed reads the official universe only to put a ticker on an address.
    // An empty universe leaves every ticker null, which is what the projection
    // must do rather than inventing a name.
    official: {
      officialAssets: async () => [],
    } as unknown as OfficialDiscoverDepsV1['official'],
    cashExit: {} as OfficialDiscoverDepsV1['cashExit'],
    marketTail: {} as OfficialDiscoverDepsV1['marketTail'],
    lookalikes: {} as OfficialDiscoverDepsV1['lookalikes'],
    reader: {} as OfficialDiscoverDepsV1['reader'],
    corporateActions: createMemoryB20CorporateActionRepository(),
    now: () => NOW,
  };
}

describe('the market-wide recorded-change read', () => {
  test('an empty feed with no watch says nobody looked, never that nothing changed', async () => {
    const deps = await depsV1();
    const out = await rwaRecordedChangesForAgentV1(deps, {
      window: '24h',
      detail: 'summary',
      limit: 25,
    });

    assert.equal(out.changeCount, 0);
    assert.deepEqual(out.watching, []);
    // Every kind this build can emit is unwatched, so every one of them is a
    // statement about Miorail rather than about the market. Counted against
    // the list itself: the number grew to eight when the corporate-action tail
    // shipped, and a hardcoded six would have started quietly under-reporting
    // exactly what nobody is watching.
    assert.equal(out.notWatched.length, RWA_SIGNAL_KINDS_V1.length);
    assert.match(out.miorailSummary.summary, /No emitter has ever opened a watch/);
    assert.doesNotMatch(out.miorailSummary.summary, /Nothing Miorail watches changed/);
  });

  test('the onchain record is a second fact, and it is never the watch date', async () => {
    // The watch opens when an emitter first runs. The corporate-action tail
    // reads back to before the first tokenized stock existed, so a summary that
    // offered only `watchingSince` would understate a two-month record to the
    // point of being wrong.
    const deps = await depsV1();
    await deps.corporateActions.recordPass({
      chainId: 8453,
      fromBlock: 49_145_000,
      toBlock: 51_212_000,
      observedAt: '2026-09-12T12:00:00.000Z',
      logCalls: 1,
      rows: [],
    });
    const out = await rwaRecordedChangesForAgentV1(deps, {
      window: '24h',
      detail: 'summary',
      limit: 25,
    });
    assert.deepEqual(out.corporateActionRecord, {
      fromBlock: 49_145_000,
      toBlock: 51_212_000,
      actions: 0,
      sinceFirstStock: true,
    });
    assert.match(out.miorailSummary.summary, /No onchain corporate action is recorded/);
    assert.match(out.miorailSummary.summary, /49145000-51212000/);
    assert.match(out.miorailSummary.summary, /every block since the first Coinbase tokenized stock existed/);
  });

  test('a record that opened late is never described as complete', async () => {
    // "Never announced anything" is a claim about a range. A tail pointed at
    // last week can say nothing about the month before it, and an assistant
    // quoting this sentence must not be able to turn it into "never".
    const deps = await depsV1();
    await deps.corporateActions.recordPass({
      chainId: 8453,
      fromBlock: 51_000_000,
      toBlock: 51_212_000,
      observedAt: '2026-09-12T12:00:00.000Z',
      logCalls: 1,
      rows: [],
    });
    const out = await rwaRecordedChangesForAgentV1(deps, {
      window: '24h',
      detail: 'summary',
      limit: 25,
    });
    assert.equal(out.corporateActionRecord!.sinceFirstStock, false);
    assert.match(out.miorailSummary.summary, /the record starts there/);
    assert.doesNotMatch(out.miorailSummary.summary, /every block since/);
  });

  test('a tail that has never run says nothing is known, not that nothing happened', async () => {
    const out = await rwaRecordedChangesForAgentV1(await depsV1(), {
      window: '24h',
      detail: 'summary',
      limit: 25,
    });
    assert.equal(out.corporateActionRecord, null);
    assert.match(out.miorailSummary.summary, /No blocks have been read for onchain corporate actions/);
    assert.doesNotMatch(out.miorailSummary.summary, /has ever been recorded/);
  });

  test('an empty feed WITH a watch may say nothing changed', async () => {
    const deps = await depsV1();
    await deps.signals.openSignalWatch({
      chainId: 8453,
      kinds: ['official_asset_cash_exit_changed'],
      at: '2026-09-01T00:00:00.000Z',
    });

    const out = await rwaRecordedChangesForAgentV1(deps, {
      window: '24h',
      detail: 'summary',
      kinds: ['official_asset_cash_exit_changed'],
      limit: 25,
    });

    assert.equal(out.changeCount, 0);
    assert.deepEqual(out.notWatched, []);
    assert.match(out.miorailSummary.summary, /Nothing Miorail watches changed/);
  });

  test('narrowing to one kind does not print caveats about kinds nobody asked for', async () => {
    const deps = await depsV1();
    await deps.signals.openSignalWatch({
      chainId: 8453,
      kinds: ['official_asset_cash_exit_changed'],
      at: '2026-09-01T00:00:00.000Z',
    });

    const narrowed = await rwaRecordedChangesForAgentV1(deps, {
      window: '24h',
      detail: 'summary',
      kinds: ['official_asset_cash_exit_changed'],
      limit: 25,
    });
    assert.deepEqual(narrowed.notWatched, []);

    const wide = await rwaRecordedChangesForAgentV1(deps, {
      window: '24h',
      detail: 'summary',
      limit: 25,
    });
    assert.equal(wide.notWatched.length, RWA_SIGNAL_KINDS_V1.length - 1);
    assert.ok(!wide.notWatched.includes('official_asset_cash_exit_changed'));
  });

  test('the window cuts on when the market moved, not on when we recorded it', async () => {
    const deps = await depsV1();
    await deps.signals.openSignalWatch({
      chainId: 8453,
      kinds: ['official_asset_cash_exit_changed'],
      at: '2026-08-01T00:00:00.000Z',
    });
    // Both written in one catch-up pass; one moved yesterday, one last week.
    await deps.signals.recordSignals({
      chainId: 8453,
      recordedAt: '2026-09-08T11:00:00.000Z',
      signals: [
        costChangeV1({ subject: AAPL, occurredAt: '2026-09-08T09:00:00.000Z', key: 'a', from: '10', to: '90' }),
        costChangeV1({ subject: NVDA, occurredAt: '2026-09-02T09:00:00.000Z', key: 'b', from: '10', to: '90' }),
      ],
    });

    const day = await rwaRecordedChangesForAgentV1(deps, {
      window: '24h',
      detail: 'rows',
      limit: 25,
    });
    assert.equal(day.changeCount, 1);
    assert.equal(day.changes[0]!.subjectAddress, AAPL);

    const week = await rwaRecordedChangesForAgentV1(deps, {
      window: '7d',
      detail: 'rows',
      limit: 25,
    });
    assert.equal(week.changeCount, 2);
    assert.equal(week.subjectCount, 2);
  });

  test('a full page is declared truncated, so the counts read as a floor', async () => {
    const deps = await depsV1();
    await deps.signals.openSignalWatch({
      chainId: 8453,
      kinds: ['official_asset_cash_exit_changed'],
      at: '2026-08-01T00:00:00.000Z',
    });
    await deps.signals.recordSignals({
      chainId: 8453,
      recordedAt: '2026-09-08T11:00:00.000Z',
      signals: [
        costChangeV1({ subject: AAPL, occurredAt: '2026-09-08T09:00:00.000Z', key: 'a', from: '10', to: '90' }),
        costChangeV1({ subject: NVDA, occurredAt: '2026-09-08T08:00:00.000Z', key: 'b', from: '10', to: '90' }),
      ],
    });

    const cut = await rwaRecordedChangesForAgentV1(deps, {
      window: '24h',
      detail: 'summary',
      limit: 1,
    });
    assert.equal(cut.truncated, true);
    assert.match(cut.miorailSummary.summary, /counts are a floor/);

    const whole = await rwaRecordedChangesForAgentV1(deps, {
      window: '24h',
      detail: 'summary',
      limit: 25,
    });
    assert.equal(whole.truncated, false);
    assert.doesNotMatch(whole.miorailSummary.summary, /floor/);
  });

  test('summary carries the tally and no rows; rows carry the stored facts unchanged', async () => {
    const deps = await depsV1();
    await deps.signals.openSignalWatch({
      chainId: 8453,
      kinds: ['official_asset_cash_exit_changed'],
      at: '2026-08-01T00:00:00.000Z',
    });
    await deps.signals.recordSignals({
      chainId: 8453,
      recordedAt: '2026-09-08T11:00:00.000Z',
      signals: [
        costChangeV1({ subject: AAPL, occurredAt: '2026-09-08T09:00:00.000Z', key: 'a', from: '10', to: '90' }),
      ],
    });

    const summary = await rwaRecordedChangesForAgentV1(deps, {
      window: '24h',
      detail: 'summary',
      limit: 25,
    });
    assert.deepEqual(summary.changes, []);
    assert.deepEqual(summary.changeCountsByKind, { official_asset_cash_exit_changed: 1 });
    assert.equal(summary.changeCount, 1);
    // The tally survives the row suppression: a caller that reads only the
    // summary still learns what moved.
    assert.match(summary.miorailSummary.summary, /1 exit cost moved/);

    const rows = await rwaRecordedChangesForAgentV1(deps, {
      window: '24h',
      detail: 'rows',
      limit: 25,
    });
    const facts = rows.changes[0]!.facts;
    // The threshold travels with both costs: a change is only a change because
    // it cleared a stored line, and a reader cannot judge it without that line.
    assert.equal(facts.previousRoundTripCostBps, '10');
    assert.equal(facts.roundTripCostBps, '90');
    assert.equal(facts.thresholdBps, 50);
    assert.equal(facts.requestedCashAtomic, '10000000000');
  });

  test('what this feed never reports travels with every answer', async () => {
    const deps = await depsV1();
    const out = await rwaRecordedChangesForAgentV1(deps, {
      window: '24h',
      detail: 'summary',
      limit: 25,
    });
    // Trades and price moves are absent by design, and an assistant that does
    // not know that reads their absence as a calm market.
    assert.equal(out.notReported.length, 2);
    assert.ok(out.notReported.some((line) => /Trades\./.test(line)));
    assert.ok(out.notReported.some((line) => /Price moves\./.test(line)));
    assert.equal(out.marketWide, true);
  });
});
