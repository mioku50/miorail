import assert from 'node:assert/strict';
import test from 'node:test';
import { EvidencePackageV1Schema, evidencePackageV1, type EvidenceToolV1 } from './evidencePackage.js';

const TOKEN = `0x${'11'.repeat(20)}`;
const CONTENT = 'ab'.repeat(32);
const QUOTE = `0x${'cd'.repeat(32)}`;
const SNAPSHOT = `0x${'ef'.repeat(32)}`;
const READ = '2026-10-19T11:00:00.000Z';
const OLDER = '2026-10-18T10:00:00.000Z';
const NOW = new Date('2026-10-20T12:00:00.000Z');
const question = { requestedCashAtomic: '3000000', direction: 'buy', destination: 'USDC' };

function resolve(payload: unknown, pointer: string): unknown {
  return pointer.split('/').slice(1).reduce((value, part) =>
    (value as Record<string, unknown>)?.[part.replace(/~1/g, '/').replace(/~0/g, '~')], payload);
}
function pack(tool: EvidenceToolV1, payload: Record<string, unknown>) {
  const original = JSON.stringify(payload);
  const result = evidencePackageV1(tool, payload, NOW);
  assert.equal(JSON.stringify(payload), original, 'adding provenance must not rewrite facts');
  EvidencePackageV1Schema.parse(result);
  for (const claim of result.claims) for (const path of [...claim.paths, ...claim.basisPaths]) {
    assert.notEqual(resolve(payload, path), undefined, `${tool} points at a missing fact: ${path}`);
  }
  return result;
}

test('a comparison preserves three independent clocks and hashes, including an expired quote', () => {
  const payload = { comparison: { question, universe: {}, marketOutcomeCoverage: {}, numericComparisonCoverage: {},
    representations: [{ tokenAddress: TOKEN, routePolicyKey: SNAPSHOT, exactTestedTokenAtomic: '12500000',
      supply: { blockNumber: '101', evidenceHash: SNAPSHOT, observedAt: OLDER },
      sources: [{ source: 'kyberswap', status: 'quoted', quoteEvidence: {
        blockNumber: '102', evidenceHash: QUOTE, observedAt: READ, expiresAt: READ,
      } }], reference: { observedAt: OLDER, referenceUpdatedAt: '2026-10-17T20:00:00.000Z',
        evidence: { source: 'chainlink', blockNumber: '99', evidenceHash: QUOTE } },
      normalization: { status: 'unconfirmed' }, normalizationCheckedAt: READ,
      lastObservation: { source: 'kyberswap', observedAt: OLDER, expiresAt: OLDER },
    }] } };
  const result = pack('compare_market_reality', payload);
  const quote = result.claims.find(c => c.kind === 'quote')!;
  assert.equal(quote.hash, QUOTE);
  assert.equal(quote.block, '102');
  assert.equal(quote.observedAt, READ);
  assert.equal(quote.scope.requestedCashAtomic, '3000000');
  assert.equal(quote.scope.tokenAmountAtomic, '12500000');
  const supply = result.claims.find(c => c.kind === 'supply')!;
  assert.equal(supply.block, '101');
  assert.equal(supply.hash, SNAPSHOT);
  assert.equal(supply.scope.requestedCashAtomic, undefined, 'a supply read is independent of trade size');
  const reference = result.claims.find(c => c.kind === 'reference')!;
  assert.equal(reference.block, '99');
  assert.equal(reference.observedAt, OLDER, 'feed publication is not the read clock');
  const history = result.claims.find(c => c.kind === 'history')!;
  assert.equal(history.scope.tokenAmountAtomic, undefined, 'the current quantity does not describe a historical quote');
  assert.equal(history.scope.routePolicyKey, undefined, 'a policy not retained on the historical row stays unknown');
  assert.equal(history.observedAt, OLDER);
  assert.equal(history.hash, null, 'a sibling quote is not the historical evidence');
});

test('issuer mappings preserve a source hash and source clock without lending them to supply counts', () => {
  const result = pack('list_reviewed_stocks', { stocks: [{ underlyingKey: 'security:isin:US1111111111',
    canonicalName: 'Example', displaySymbol: 'EX', sourceEvidence: {
      sourceKind: 'backed_assets_api', sourceHash: CONTENT, observedAt: OLDER,
    } }], reviewedTotal: 156, reviewedByAssetClass: { equity: 156 }, returned: 1, truncated: true });
  assert.equal(result.claims[0]!.hash, null);
  assert.equal(result.claims[1]!.hash, CONTENT);
  assert.equal(result.claims[1]!.hashKind, 'source_content');
  assert.equal(result.claims[1]!.block, null);
  assert.equal(result.claims[1]!.observedAt, OLDER);
});

test('identity and supply keep their own block anchors; missing evidence is not a block hash', () => {
  const result = pack('get_representations', { underlying: null, representationCount: 1, selection: {},
    representations: [{ tokenAddress: TOKEN, caip10: `eip155:8453:${TOKEN}`, issuerId: 'coinbase', representationKind: 'b20_asset',
      identityEvidence: { sourceKind: 'coinbase_b20_metadata', sourceHash: CONTENT, observedBlockNumber: '100', observedAt: OLDER },
      supply: { blockNumber: '101', blockHash: SNAPSHOT, observedAt: READ, evidenceHash: null },
    }] });
  assert.equal(result.claims[1]!.block, '100');
  assert.equal(result.claims[1]!.hash, CONTENT);
  assert.equal(result.claims[2]!.block, '101');
  assert.equal(result.claims[2]!.hash, null);
  assert.deepEqual(result.claims[2]!.missing, ['hash']);
});

test('venue catalogue and pool readings cannot inherit the controls block or assembly clock', () => {
  const result = pack('get_use_access', { tokenAddress: TOKEN, blockTag: '0x64', observedAt: READ,
    blockTagCovers: ['transfers', 'bridge'], transfers: { state: 'unread' }, bridge: { state: 'unread' },
    pools: { blockNumber: 95, readAt: OLDER }, defi: { venues: [
      { venueId: 'morpho', observed: { source: 'venue_catalogue', at: OLDER } },
      { venueId: 'euler', observed: null },
    ] }, announcements: [{ announcedAt: '2026-08-24' }], poolYield: { readAt: OLDER }, ecosystem: {} });
  const controls = result.claims.filter(c => c.kind === 'controls');
  assert.equal(controls.length, 2);
  assert.equal(controls[0]!.block, '100');
  const venues = result.claims.filter(c => c.kind === 'venue');
  assert.equal(venues[0]!.block, null);
  assert.equal(venues[0]!.observedAt, OLDER);
  assert.equal(venues[0]!.source.kind, 'venue_catalogue');
  assert.equal(venues[1]!.observedAt, null);
  assert.equal(result.claims.find(c => c.kind === 'pools')!.block, '95');
  assert.equal(result.claims.find(c => c.kind === 'announcement')!.observedAt, null);
  const latest = evidencePackageV1('get_use_access', { blockTag: 'latest', observedAt: READ,
    blockTagCovers: ['transfers'], transfers: {}, pools: {} }, NOW);
  assert.equal(latest.claims[0]!.block, null, 'latest is not a retained block number');
});

test('a source listing date and a lookalike first flag are not new wallet or chain checks', () => {
  const result = pack('check_address_identity', { tokenAddress: TOKEN, standing: 'lookalike', answer: 'Example', corpus: {},
    official: { listedIn: [{ sourceKind: 'coinbase_stocks_api', lastSeenAt: OLDER }] },
    issuerRepresentation: { observedAt: READ }, lookalike: { firstFlaggedAt: OLDER }, generatedAt: NOW.toISOString() });
  assert.equal(result.claims[1]!.observedAt, OLDER);
  assert.equal(result.claims[2]!.observedAt, READ);
  assert.equal(result.claims[3]!.observedAt, null);
  assert.equal(result.availability.withHash, 0);
});

test('dividend estimates, schedules and notices retain their type; a transaction hash is never an evidence hash', () => {
  const result = pack('get_dividend_calendar', { passThrough: {}, stocks: [{ tokenAddress: TOKEN, lastReadAt: READ,
    next: { state: 'estimated', declaredOn: '2026-10-19', source: null, token: { kind: 'estimate', at: null } },
    history: [{ state: 'scheduled', source: { publisher: 'Example' }, token: { kind: 'scheduled', at: READ } }],
    notice: { at: OLDER, transactionHash: QUOTE },
  }] });
  assert.equal(result.claims.find(c => c.paths.includes('/stocks/0/next'))!.kind, 'estimate');
  const scheduled = result.claims.find(c => c.paths.includes('/stocks/0/history/0/token'))!;
  assert.equal(scheduled.observedAt, null);
  assert.equal(scheduled.scope.effectiveAt, READ);
  assert.equal(scheduled.block, null);
  assert.equal(result.claims.at(-1)!.hash, null);
  assert.equal(result.availability.withHash, 0);
  assert.equal(result.availability.withObservedAt, 1);
});

test('recorded events retain their actual block, not the feed tail or event timestamp as observation time', () => {
  const result = pack('get_recorded_changes', { since: OLDER, observedAt: READ, changeCount: 1,
    changeCountsByKind: {}, subjectCount: 1, watching: [], notWatched: [], truncated: true,
    corporateActionRecord: { toBlock: '999' }, changes: [{ subjectAddress: TOKEN,
      kind: 'official_asset_multiplier_changed', occurredAt: OLDER, recordedAt: READ,
      facts: { blockNumber: '97', transactionHash: QUOTE } }],
  });
  const event = result.claims.at(-1)!;
  assert.equal(event.block, '97');
  assert.equal(event.observedAt, null);
  assert.equal(event.hash, null);
  assert.equal(event.scope.tokenAddress, TOKEN);
  assert.equal(event.scope.from, OLDER);
  assert.equal(event.scope.until, READ);
});

test('historical changes expose original snapshot references, keeping run gaps and summary pagination intact', () => {
  const base = { tokenAddress: TOKEN, question, since: OLDER, assembledAt: READ, routePolicy: { routePolicyKey: SNAPSHOT },
    windowObservationCount: 2, windowChangeCount: 1, changeCountsByKind: {}, nextCursor: 'page-2',
    observations: [{ kind: 'comparable_observation', point: { source: 'kyberswap', observedAt: OLDER, snapshotHash: SNAPSHOT } },
      { kind: 'gap', runId: QUOTE, completedAt: READ }],
    changes: [{ previousSnapshotHash: QUOTE, snapshotHash: SNAPSHOT, occurredAt: READ }],
  };
  const result = pack('get_market_changes', base);
  assert.equal(result.claims[1]!.hashKind, 'snapshot');
  assert.equal(result.claims[1]!.hash, SNAPSHOT);
  assert.equal(result.claims[2]!.hash, null, 'a run identifier is not the missing snapshot');
  assert.equal(result.claims[3]!.observedAt, null);
  const summary = pack('get_market_changes', { ...base, observations: [], changes: [], detail: 'summary' });
  assert.equal(summary.claims.length, 1, 'summary does not manufacture claims for omitted rows');
});

test('frozen game stages and a current median cannot borrow each other’s timestamps', () => {
  const result = pack('get_reopen_round', { round: { roundId: '2026-10-16', locksAt: READ,
    stocks: [{ tokenAddress: TOKEN, close: '100.00', baseCall: { base: '101.00' },
      result: { reopen: '102.00', at: READ }, baseNow: { mid: '101.00' } }] }, next: null, closeDay: 'Friday' });
  assert.deepEqual(result.claims.slice(1).map(c => c.scope.phase), ['close', 'lock', 'reopen', 'base_now']);
  assert.equal(result.availability.withObservedAt, 0, 'the public projection does not retain stage observation clocks');
  assert.equal(result.availability.withHash, 0);
});

test('packaging time never supplies missing provenance or exposes an RPC URL', () => {
  const result = pack('miorail_discover_status', { state: 'degraded', summary: 'Behind', blocksBehind: 10,
    counts: {}, lastIngestionRunAt: READ, lastMeasurementRunAt: OLDER });
  assert.equal(result.generatedAt, NOW.toISOString());
  assert.deepEqual(result.availability, { claims: 1, withBlock: 0, withObservedAt: 0, withHash: 0 });
  const bad = evidencePackageV1('get_use_access', { pools: {}, defi: { venues: [
    { venueId: 'https://rpc.invalid/?key=secret', observed: { source: 'chain_head', at: 'bad' } },
  ] } }, NOW);
  assert.equal(bad.claims[1]!.source.id, 'not_exposed');
  assert.equal(bad.claims[1]!.observedAt, null);
  assert.doesNotMatch(JSON.stringify(bad), /https|secret/);
});

test('a full 200-security page adds bounded metadata and no implied source hashes for aggregate counts', () => {
  const result = pack('list_reviewed_stocks', { reviewedTotal: 200, reviewedByAssetClass: {}, returned: 200,
    truncated: false, stocks: Array.from({ length: 200 }, (_, i) => ({
      underlyingKey: `security:isin:US${String(i).padStart(10, '0')}`, canonicalName: `Example ${i}`, displaySymbol: null,
      sourceEvidence: { sourceKind: 'coinbase_stocks_api', sourceHash: CONTENT, observedAt: READ },
    })) });
  assert.equal(result.availability.withHash, 200);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 125_000, 'provenance must fit alongside the bounded page');
});
